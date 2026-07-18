import type * as THREE from "three";
import type { TileGrid } from "../geo/grid";
import type { TileLoader } from "./TileLoader";
import { TileNode } from "./TileNode";

// INV-6 : hystérésis. Sans elle, une tuile pile à la limite oscille à chaque
// frame et on passe son temps à charger/décharger.
const SPLIT_RATIO = 2.0;
const MERGE_RATIO = 2.5;

/**
 * Split/merge du quadtree. Ne touche jamais aux meshes : il produit la liste
 * des nœuds à afficher, TerrainSystem fait le diff.
 */
export class Quadtree {
  private readonly grid: TileGrid;
  private readonly loader: TileLoader;
  private readonly root: TileNode;

  constructor(grid: TileGrid, loader: TileLoader) {
    this.grid = grid;
    this.loader = loader;
    const rootRecord = grid.record(0, 0, 0);
    if (!rootRecord) throw new Error("index.json sans tuile racine 0/0/0");
    this.root = new TileNode(grid, 0, 0, 0, rootRecord);
  }

  /** Une passe : met à jour l'état split/merge et renvoie les nœuds affichables. */
  update(cameraPos: THREE.Vector3, intersects: (node: TileNode) => boolean): TileNode[] {
    const out: TileNode[] = [];
    this.process(this.root, cameraPos, intersects, out);
    return out;
  }

  private process(
    node: TileNode,
    cameraPos: THREE.Vector3,
    intersects: (node: TileNode) => boolean,
    out: TileNode[],
  ): void {
    const dist = cameraPos.distanceTo(node.center);
    const ratio = dist / node.size;

    if (node.isSplit) {
      if (ratio > MERGE_RATIO) this.tryMerge(node, dist);
    } else if (ratio < SPLIT_RATIO && node.z < this.grid.maxLevel && node.hasChildrenData()) {
      // Hors frustum, on ne dépense ni fetch ni split : le nœud grossier suffit.
      if (intersects(node)) {
        if (this.childrenReady(node)) {
          node.isSplit = true; // INV-6 : uniquement quand les 4 enfants sont là
        } else {
          this.requestChildren(node, cameraPos);
        }
      }
    } else if (ratio > MERGE_RATIO) {
      this.cancelChildLoads(node);
    }

    if (node.isSplit) {
      for (const child of node.existingChildren()) {
        this.process(child, cameraPos, intersects, out);
      }
    } else {
      if (this.loader.get(node.key)) {
        out.push(node);
      } else if (!this.loader.isSterile(node.key)) {
        // Nœud affichable mais donnée absente (démarrage, ou éviction après merge).
        this.loader.request(node.key, dist);
      }
    }
  }

  /** Merge seulement quand le parent peut réellement s'afficher, sinon trou béant. */
  private tryMerge(node: TileNode, dist: number): void {
    if (!this.loader.get(node.key)) {
      if (!this.loader.isSterile(node.key)) {
        this.loader.request(node.key, dist);
      }
      return;
    }
    node.isSplit = false;
    for (const child of node.existingChildren()) this.collapse(child);
  }

  /** Replie récursivement un sous-arbre et annule ses fetchs en vol. */
  private collapse(node: TileNode): void {
    this.cancelChildLoads(node);
    if (!node.isSplit) return;
    node.isSplit = false;
    for (const child of node.existingChildren()) this.collapse(child);
  }

  // INV-6 : un enfant stérile (404 = pas de donnée) compte comme prêt — la
  // région est réellement vide. Un échec transitoire NE compte PAS : le parent
  // reste affiché et l'enfant sera re-demandé après cooldown. Pas de trou.
  private childrenReady(node: TileNode): boolean {
    for (const child of node.existingChildren()) {
      if (!this.loader.has(child.key) && !this.loader.isSterile(child.key)) return false;
    }
    return true;
  }

  private requestChildren(node: TileNode, cameraPos: THREE.Vector3): void {
    for (const child of node.existingChildren()) {
      if (!this.loader.has(child.key) && !this.loader.isSterile(child.key)) {
        this.loader.request(child.key, cameraPos.distanceTo(child.center));
      }
    }
  }

  private cancelChildLoads(node: TileNode): void {
    for (const child of node.existingChildren()) {
      if (!this.loader.has(child.key)) this.loader.cancel(child.key);
    }
  }

}
