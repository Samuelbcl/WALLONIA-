import * as THREE from "three";
import type { TileGrid } from "../geo/grid";
import type { DecodeRequest, DecodeResponse } from "./decode.worker";

export interface LoadedTile {
  texture: THREE.DataTexture;
  /** Copie CPU, raster×raster, ligne 0 = sud. Sert au sondage d'altitude (AGL). */
  heights: Float32Array;
  lastUsed: number;
}

interface PendingTile {
  priority: number;
  controller: AbortController | null; // null = en file, pas encore parti
  retries: number;
  notBeforeMs: number; // backoff : pas de départ avant cet instant
}

const MAX_CONCURRENT = 6; // ARCHITECTURE.md § 7
const CACHE_CAPACITY = 256;
// Au-delà de la capacité dure, on évince même les tuiles récentes (VRAM bornée).
const CACHE_HARD_CAPACITY = 384;
const CACHE_MIN_AGE_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 1500; // doublé à chaque tentative
const FAIL_COOLDOWN_MS = 15_000; // échec transitoire : nouvelle chance après ce délai

/** fetch + décodage en worker + cache LRU. */
export class TileLoader {
  private readonly grid: TileGrid;
  private readonly cache = new Map<string, LoadedTile>();
  private readonly pending = new Map<string, PendingTile>();
  /** 404 : « pas de donnée ici », définitif. Rien d'autre ne finit ici. */
  private readonly sterile = new Set<string>();
  /** Échecs transitoires : re-tentables après cooldown, jamais stériles. */
  private readonly cooldownUntil = new Map<string, number>();
  /** Clés jamais évincées (tuiles actuellement affichées), fournies par TerrainSystem. */
  private protectedKeys: ReadonlySet<string> = new Set();
  private readonly worker: Worker;
  private readonly decodes = new Map<
    number,
    { resolve: (heights: Float32Array) => void; reject: (err: Error) => void }
  >();
  private nextDecodeId = 0;
  private activeFetches = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(grid: TileGrid) {
    this.grid = grid;
    this.worker = new Worker(new URL("./decode.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<DecodeResponse>) => {
      const decode = this.decodes.get(ev.data.id);
      this.decodes.delete(ev.data.id);
      decode?.resolve(ev.data.heights);
    };
    // Sans ces deux handlers, une erreur worker laisse decode() pendante pour
    // toujours : le slot activeFetches fuit et le chargement gèle après 6 fuites.
    this.worker.onerror = (ev) => this.failAllDecodes(new Error(`decode.worker: ${ev.message}`));
    this.worker.onmessageerror = () => this.failAllDecodes(new Error("decode.worker: messageerror"));
  }

  /** Tuile décodée si présente. Rafraîchit sa position LRU. */
  get(key: string): LoadedTile | undefined {
    const entry = this.cache.get(key);
    if (entry) entry.lastUsed = performance.now();
    return entry;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  /** 404 définitif — le nœud ne sera jamais re-demandé ni affiché. */
  isSterile(key: string): boolean {
    return this.sterile.has(key);
  }

  /** Demande une tuile. priority = distance caméra (plus petit = plus urgent). */
  request(key: string, priority: number): void {
    if (this.cache.has(key) || this.sterile.has(key)) return;
    const cooldown = this.cooldownUntil.get(key);
    if (cooldown !== undefined) {
      if (performance.now() < cooldown) return;
      this.cooldownUntil.delete(key);
    }
    const pending = this.pending.get(key);
    if (pending) {
      pending.priority = priority;
      return;
    }
    this.pending.set(key, { priority, controller: null, retries: 0, notBeforeMs: 0 });
    this.pump();
  }

  /** Annule une demande qui n'intéresse plus personne (nœud mergé entre-temps). */
  cancel(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    pending.controller?.abort();
    this.pending.delete(key);
  }

  /** Tuiles actuellement affichées : l'éviction ne doit jamais les toucher. */
  setProtected(keys: ReadonlySet<string>): void {
    this.protectedKeys = keys;
  }

  get loadedCount(): number {
    return this.cache.size;
  }

  get inflightCount(): number {
    return this.pending.size;
  }

  private pump(): void {
    const now = performance.now();
    let earliestWait = Infinity;
    while (this.activeFetches < MAX_CONCURRENT) {
      let bestKey: string | null = null;
      let bestPriority = Infinity;
      for (const [key, p] of this.pending) {
        if (p.controller !== null) continue;
        if (p.notBeforeMs > now) {
          earliestWait = Math.min(earliestWait, p.notBeforeMs);
          continue;
        }
        if (p.priority < bestPriority) {
          bestPriority = p.priority;
          bestKey = key;
        }
      }
      if (bestKey === null) break;
      void this.startFetch(bestKey);
    }
    // Des retries en backoff attendent : re-pomper quand le premier arrive à échéance.
    if (earliestWait < Infinity && this.pumpTimer === null) {
      this.pumpTimer = setTimeout(() => {
        this.pumpTimer = null;
        this.pump();
      }, Math.max(20, earliestWait - now));
    }
  }

  private async startFetch(key: string): Promise<void> {
    const pending = this.pending.get(key);
    if (!pending) return;
    const controller = new AbortController();
    pending.controller = controller;
    this.activeFetches++;

    const [z, x, y] = key.split("/").map(Number) as [number, number, number];
    const raster = this.grid.encoding.raster;
    try {
      const res = await fetch(this.grid.tileUrl(z, x, y), { signal: controller.signal });
      // cancel() a pu supprimer/remplacer l'entrée pendant l'await : cette
      // course est périmée, elle ne doit plus toucher ni pending ni cache.
      if (this.pending.get(key) !== pending) return;
      if (res.status === 404) {
        // « pas de donnée ici » : nœud stérile, on ne re-fetche jamais.
        this.sterile.add(key);
        this.pending.delete(key);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      if (this.pending.get(key) !== pending) return;
      const heights = await this.decode(buffer);
      if (this.pending.get(key) !== pending) return;
      if (heights.length !== raster * raster) {
        throw new Error(`tuile ${key} : ${heights.length} samples au lieu de ${raster * raster}`);
      }
      this.store(key, heights);
      this.pending.delete(key);
    } catch (err) {
      if (controller.signal.aborted) return; // cancel() a déjà nettoyé pending
      if (this.pending.get(key) !== pending) return; // entrée périmée
      pending.retries++;
      if (pending.retries >= MAX_RETRIES) {
        // Transitoire, pas stérile : nouvelle chance après cooldown, sinon un
        // hoquet réseau laisserait un trou permanent dans le terrain.
        console.warn(`tuile ${key} : ${MAX_RETRIES} échecs, cooldown ${FAIL_COOLDOWN_MS} ms`, err);
        this.cooldownUntil.set(key, performance.now() + FAIL_COOLDOWN_MS);
        this.pending.delete(key);
      } else {
        pending.controller = null; // repart en file, avec backoff
        pending.notBeforeMs = performance.now() + RETRY_BACKOFF_MS * 2 ** (pending.retries - 1);
      }
    } finally {
      this.activeFetches--;
      this.pump();
    }
  }

  private decode(buffer: ArrayBuffer): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const id = this.nextDecodeId++;
      this.decodes.set(id, { resolve, reject });
      const msg: DecodeRequest = {
        id,
        buffer,
        heightScale: this.grid.encoding.heightScale,
        heightOffset: this.grid.encoding.heightOffset,
      };
      this.worker.postMessage(msg, [buffer]);
    });
  }

  private failAllDecodes(err: Error): void {
    const waiting = [...this.decodes.values()];
    this.decodes.clear();
    for (const d of waiting) d.reject(err);
  }

  private store(key: string, heights: Float32Array): void {
    const raster = this.grid.encoding.raster;
    const texture = new THREE.DataTexture(
      heights,
      raster,
      raster,
      THREE.RedFormat,
      THREE.FloatType,
    );
    texture.colorSpace = THREE.NoColorSpace; // INV-1
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    const existing = this.cache.get(key);
    if (existing) existing.texture.dispose(); // écrasement (course résolue) : pas de fuite VRAM
    this.cache.set(key, { texture, heights, lastUsed: performance.now() });
    this.evict();
  }

  private evict(): void {
    if (this.cache.size <= CACHE_CAPACITY) return;
    const now = performance.now();
    const entries = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of entries) {
      if (this.cache.size <= CACHE_CAPACITY) return;
      if (this.protectedKeys.has(key)) continue; // affichée : jamais évincée
      // Sous la capacité dure, on garde ~30 s (un aller-retour LOD ne re-fetche rien).
      if (now - entry.lastUsed < CACHE_MIN_AGE_MS && this.cache.size <= CACHE_HARD_CAPACITY) {
        continue;
      }
      entry.texture.dispose(); // sinon fuite VRAM
      this.cache.delete(key);
    }
  }
}
