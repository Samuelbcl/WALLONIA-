/**
 * Math de tuiles + chargement de l'index émis par tools/02_build_tiles.py.
 * Toutes les constantes de grille viennent d'ici (grid.json / index.json),
 * jamais du code TS.
 */

export interface GridJson {
  crs: string;
  rootSize: number;
  origin: [number, number];
  maxLevel: number;
  baseUrl: string;
}

export interface EncodingJson {
  raster: number; // 259
  samples: number; // 257
  border: number; // 1
  heightScale: number;
  heightOffset: number;
  dtype: string;
}

export interface TileRecord {
  minZ: number;
  maxZ: number;
}

interface IndexJson {
  aoi: string;
  grid: GridJson;
  encoding: EncodingJson;
  tiles: Record<string, TileRecord>;
}

export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

export class TileGrid {
  readonly aoi: string;
  readonly rootSize: number;
  readonly origin: [number, number];
  readonly maxLevel: number;
  readonly baseUrl: string;
  readonly encoding: EncodingJson;
  readonly tiles: Map<string, TileRecord>;

  constructor(index: IndexJson) {
    this.aoi = index.aoi;
    this.rootSize = index.grid.rootSize;
    this.origin = index.grid.origin;
    this.maxLevel = index.grid.maxLevel;
    this.baseUrl = index.grid.baseUrl;
    this.encoding = index.encoding;
    this.tiles = new Map(Object.entries(index.tiles));
  }

  tileSize(z: number): number {
    return this.rootSize / 2 ** z;
  }

  /** Coin (minX, minY) de la tuile en CRS. */
  tileMin(z: number, x: number, y: number): [number, number] {
    const size = this.tileSize(z);
    return [this.origin[0] + x * size, this.origin[1] + y * size];
  }

  has(z: number, x: number, y: number): boolean {
    return this.tiles.has(tileKey(z, x, y));
  }

  record(z: number, x: number, y: number): TileRecord | undefined {
    return this.tiles.get(tileKey(z, x, y));
  }

  tileUrl(z: number, x: number, y: number): string {
    return `${this.baseUrl}/${z}/${x}/${y}.bin`;
  }

  /** Centre de la grille racine — sert d'origine à l'espace de rendu (D3). */
  center(): [number, number] {
    return [this.origin[0] + this.rootSize / 2, this.origin[1] + this.rootSize / 2];
  }

  /** Tuile de niveau z contenant le point CRS, ou undefined hors grille. */
  tileAt(z: number, cx: number, cy: number): [number, number] | undefined {
    const size = this.tileSize(z);
    const x = Math.floor((cx - this.origin[0]) / size);
    const y = Math.floor((cy - this.origin[1]) / size);
    if (x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return undefined;
    return [x, y];
  }
}

export async function loadTileGrid(aoi: string): Promise<TileGrid> {
  const res = await fetch(`/tiles/${aoi}/index.json`);
  if (!res.ok) throw new Error(`index.json introuvable pour l'AOI '${aoi}' (${res.status})`);
  const index = (await res.json()) as IndexJson;
  return new TileGrid(index);
}
