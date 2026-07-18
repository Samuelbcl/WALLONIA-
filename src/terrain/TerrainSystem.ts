import * as THREE from "three";
import { tileKey, type TileGrid } from "../geo/grid";
import { Quadtree } from "./Quadtree";
import { buildTileGeometry } from "./TileGeometry";
import { TileLoader } from "./TileLoader";
import type { TileNode } from "./TileNode";
import terrainVert from "./shaders/terrain.vert.glsl?raw";
import terrainFrag from "./shaders/terrain.frag.glsl?raw";

const SKIRT_DEPTH_M = 60; // D8

export interface Lighting {
  sunDir: THREE.Vector3; // espace de rendu, pointe VERS le soleil
  sunColor: THREE.Color;
  skyColor: THREE.Color;
  fogColor: THREE.Color;
  fogDensity: number;
}

/** Orchestre : quadtree -> diff de meshes -> uniforms -> scène. */
export class TerrainSystem {
  readonly group = new THREE.Group();
  verticalScale = 1.0; // D5 : exagération 1.0, uniform configurable (debug)

  private readonly grid: TileGrid;
  private readonly loader: TileLoader;
  private readonly quadtree: Quadtree;
  private readonly geometry: THREE.BufferGeometry;
  private readonly baseMaterial: THREE.ShaderMaterial;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly cullBox = new THREE.Box3();
  private rendered = new Map<string, TileNode>();

  constructor(grid: TileGrid, scene: THREE.Scene) {
    this.grid = grid;
    this.loader = new TileLoader(grid);
    this.quadtree = new Quadtree(grid, this.loader);
    this.geometry = buildTileGeometry();

    const enc = grid.encoding;
    const [ox, oy] = grid.center();
    this.baseMaterial = new THREE.ShaderMaterial({
      vertexShader: terrainVert,
      fragmentShader: terrainFrag,
      uniforms: {
        uHeightmap: { value: null },
        uTileMinX: { value: 0 },
        uTileMinY: { value: 0 },
        uTileSize: { value: 0 },
        uOrigin: { value: new THREE.Vector2(ox, oy) },
        uVerticalScale: { value: 1.0 },
        uSkirtDepth: { value: SKIRT_DEPTH_M },
        // INV-3 : texel = (uv*(samples-1) + border + 0.5) / raster — depuis index.json.
        uUvTransform: {
          value: new THREE.Vector2((enc.samples - 1) / enc.raster, (enc.border + 0.5) / enc.raster),
        },
        uSampleUv: { value: 1 / (enc.samples - 1) },
        uVoidBelow: { value: enc.heightOffset + 1 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSkyColor: { value: new THREE.Color(0.4, 0.55, 0.8) },
        uFogColor: { value: new THREE.Color(0.75, 0.82, 0.9) },
        uFogDensity: { value: 2.5e-5 },
      },
    });

    scene.add(this.group);
  }

  update(camera: THREE.PerspectiveCamera, lighting: Lighting): void {
    // Sans ça, matrixWorldInverse date du render précédent : culling en retard
    // d'une frame, visible en demi-tour rapide.
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    const nodes = this.quadtree.update(camera.position, (n) => this.nodeInFrustum(n));

    const next = new Map<string, TileNode>();
    for (const node of nodes) next.set(node.key, node);
    this.loader.setProtected(new Set(next.keys()));

    // Diff : les nœuds qui sortent rendent leur matériau (la texture reste au cache LRU).
    for (const [key, node] of this.rendered) {
      if (!next.has(key)) this.releaseMesh(node);
    }

    for (const node of next.values()) {
      const entry = this.loader.get(node.key);
      if (!entry) continue; // évincé dans la frame — le quadtree re-demandera
      if (!node.mesh) this.createMesh(node, entry.texture);
      const mesh = node.mesh;
      if (!mesh) continue;
      if ((mesh.material as THREE.ShaderMaterial).uniforms["uHeightmap"]?.value !== entry.texture) {
        setUniform(mesh, "uHeightmap", entry.texture);
      }
      mesh.visible = this.nodeInFrustum(node);
      if (mesh.visible) this.applyLighting(mesh, lighting);
    }

    this.rendered = next;
  }

  /** Culling manuel (§ 6). Bounds Y × exagération, étendues de la jupe. */
  private nodeInFrustum(node: TileNode): boolean {
    this.cullBox.copy(node.bounds);
    this.cullBox.min.y = node.bounds.min.y * this.verticalScale - SKIRT_DEPTH_M;
    this.cullBox.max.y = node.bounds.max.y * this.verticalScale;
    return this.frustum.intersectsBox(this.cullBox);
  }

  /** Altitude du terrain au point CRS depuis la tuile chargée la plus fine. */
  getHeightAt(crsX: number, crsY: number): number | null {
    const enc = this.grid.encoding;
    for (let z = this.grid.maxLevel; z >= 0; z--) {
      const at = this.grid.tileAt(z, crsX, crsY);
      if (!at) return null;
      const [x, y] = at;
      const entry = this.loader.get(tileKey(z, x, y));
      if (!entry) continue;
      const size = this.grid.tileSize(z);
      const [minX, minY] = this.grid.tileMin(z, x, y);
      const fx = ((crsX - minX) / size) * (enc.samples - 1);
      const fy = ((crsY - minY) / size) * (enc.samples - 1); // ligne 0 = sud
      return bilinear(entry.heights, enc.raster, enc.border, fx, fy);
    }
    return null;
  }

  get tilesRendered(): number {
    return this.rendered.size;
  }

  get tilesLoaded(): number {
    return this.loader.loadedCount;
  }

  get tilesInflight(): number {
    return this.loader.inflightCount;
  }

  private createMesh(node: TileNode, texture: THREE.DataTexture): void {
    // INV-7 : un clone de ShaderMaterial par tuile. Même source de shader ->
    // même programme GPU, le clone ne recompile rien.
    const mat = this.baseMaterial.clone();
    setMatUniform(mat, "uHeightmap", texture);
    setMatUniform(mat, "uTileMinX", node.minX);
    setMatUniform(mat, "uTileMinY", node.minY);
    setMatUniform(mat, "uTileSize", node.size);
    const mesh = new THREE.Mesh(this.geometry, mat);
    mesh.frustumCulled = false; // culling manuel via node.bounds (§ 6)
    node.mesh = mesh;
    this.group.add(mesh);
  }

  private releaseMesh(node: TileNode): void {
    if (!node.mesh) return;
    this.group.remove(node.mesh);
    (node.mesh.material as THREE.ShaderMaterial).dispose();
    node.mesh = null;
  }

  private applyLighting(mesh: THREE.Mesh, l: Lighting): void {
    const u = (mesh.material as THREE.ShaderMaterial).uniforms;
    (u["uSunDir"]?.value as THREE.Vector3).copy(l.sunDir);
    (u["uSunColor"]?.value as THREE.Color).copy(l.sunColor);
    (u["uSkyColor"]?.value as THREE.Color).copy(l.skyColor);
    (u["uFogColor"]?.value as THREE.Color).copy(l.fogColor);
    if (u["uFogDensity"]) u["uFogDensity"].value = l.fogDensity;
    if (u["uVerticalScale"]) u["uVerticalScale"].value = this.verticalScale;
  }
}

function setUniform(mesh: THREE.Mesh, name: string, value: unknown): void {
  setMatUniform(mesh.material as THREE.ShaderMaterial, name, value);
}

function setMatUniform(mat: THREE.ShaderMaterial, name: string, value: unknown): void {
  const uniform = mat.uniforms[name];
  if (uniform) uniform.value = value;
}

function bilinear(
  heights: Float32Array,
  raster: number,
  border: number,
  fx: number,
  fy: number,
): number {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (sx: number, sy: number): number => {
    const cx = Math.min(Math.max(sx + border, 0), raster - 1);
    const cy = Math.min(Math.max(sy + border, 0), raster - 1);
    return heights[cy * raster + cx] ?? 0;
  };
  const h00 = at(x0, y0);
  const h10 = at(x0 + 1, y0);
  const h01 = at(x0, y0 + 1);
  const h11 = at(x0 + 1, y0 + 1);
  return (
    h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty
  );
}

