import * as THREE from "three";
import { crsToRender } from "../geo/crs";
import { tileKey, type TileGrid, type TileRecord } from "../geo/grid";

/**
 * Un nœud du quadtree : identité de tuile, bounds en espace de rendu, état de
 * subdivision, mesh éventuel. La donnée (texture/hauteurs) vit dans TileLoader.
 */
export class TileNode {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly key: string;
  readonly size: number;
  readonly minX: number; // CRS
  readonly minY: number; // CRS
  readonly record: TileRecord;
  /** AABB en espace de rendu, hauteurs réelles depuis index.json (culling § 6). */
  readonly bounds: THREE.Box3;
  readonly center: THREE.Vector3;

  isSplit = false;
  mesh: THREE.Mesh | null = null;

  private readonly grid: TileGrid;
  private childNodes: TileNode[] | null = null;

  constructor(grid: TileGrid, z: number, x: number, y: number, record: TileRecord) {
    this.grid = grid;
    this.z = z;
    this.x = x;
    this.y = y;
    this.key = tileKey(z, x, y);
    this.size = grid.tileSize(z);
    [this.minX, this.minY] = grid.tileMin(z, x, y);
    this.record = record;

    // INV-4 : Y CRS croissant -> Z rendu décroissant, donc maxY donne le minZ du box.
    const [rx0, rz0] = crsToRender(this.minX, this.minY);
    const [rx1, rz1] = crsToRender(this.minX + this.size, this.minY + this.size);
    this.bounds = new THREE.Box3(
      new THREE.Vector3(rx0, record.minZ, rz1),
      new THREE.Vector3(rx1, record.maxZ, rz0),
    );
    this.center = this.bounds.getCenter(new THREE.Vector3());
  }

  /** Enfants présents dans l'index. Un enfant absent = pas de donnée = rien à afficher. */
  existingChildren(): TileNode[] {
    if (this.childNodes === null) {
      this.childNodes = [];
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const cz = this.z + 1;
          const cx = this.x * 2 + dx;
          const cy = this.y * 2 + dy;
          const record = this.grid.record(cz, cx, cy);
          if (record) this.childNodes.push(new TileNode(this.grid, cz, cx, cy, record));
        }
      }
    }
    return this.childNodes;
  }

  hasChildrenData(): boolean {
    return this.existingChildren().length > 0;
  }
}
