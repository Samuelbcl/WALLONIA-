import proj4 from "proj4";

/**
 * Trois espaces (ARCHITECTURE.md § 2). Les conversions vivent ICI et nulle part
 * ailleurs. WGS84 (degrés) — CRS EPSG:31370 (mètres) — Rendu (mètres, Y-up,
 * Nord = −Z, recentré sur l'origine AOI).
 */

// Définition officielle EPSG:31370 (Lambert Belge 72). C'est une définition de
// projection, pas une constante de grille — la grille vient de grid.json.
proj4.defs(
  "EPSG:31370",
  "+proj=lcc +lat_1=51.16666723333333 +lat_2=49.8333339 +lat_0=90 " +
    "+lon_0=4.367486666666666 +x_0=150000.013 +y_0=5400088.438 +ellps=intl " +
    "+towgs84=-106.869,52.2978,-103.724,0.3366,-0.457,1.8422,-1.2747 " +
    "+units=m +no_defs",
);

const wgs84ToLambert = proj4("EPSG:4326", "EPSG:31370");

// Origine de l'espace de rendu (D3). Fixée une fois au bootstrap depuis grid.json.
const origin = { x: 0, y: 0, set: false };

export function setRenderOrigin(x: number, y: number): void {
  origin.x = x;
  origin.y = y;
  origin.set = true;
}

function assertOrigin(): void {
  if (!origin.set) throw new Error("crs: origine de rendu non initialisée (grid.json pas chargé ?)");
}

/** CRS 31370 -> espace de rendu Three (x, z). INV-4 : Nord = −Z. */
export function crsToRender(x: number, y: number): [number, number] {
  assertOrigin();
  return [x - origin.x, -(y - origin.y)];
}

/** Espace de rendu Three (x, z) -> CRS 31370. */
export function renderToCrs(rx: number, rz: number): [number, number] {
  assertOrigin();
  return [rx + origin.x, -rz + origin.y];
}

/** WGS84 (lon, lat) -> CRS 31370 (x, y). */
export function wgs84ToCrs(lon: number, lat: number): [number, number] {
  const [x, y] = wgs84ToLambert.forward([lon, lat]);
  return [x ?? 0, y ?? 0];
}

/** CRS 31370 (x, y) -> WGS84 (lon, lat). Uniquement pour l'affichage HUD. */
export function crsToWgs84(x: number, y: number): [number, number] {
  const [lon, lat] = wgs84ToLambert.inverse([x, y]);
  return [lon ?? 0, lat ?? 0];
}
