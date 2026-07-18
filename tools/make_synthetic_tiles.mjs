#!/usr/bin/env node
/**
 * make_synthetic_tiles.mjs — relief SYNTHÉTIQUE de dev, format identique au
 * builder réel (02_build_tiles.py) : 259×259 uint16 LE, grid.json, index.json.
 *
 *     node tools/make_synthetic_tiles.mjs [--max-level 6]
 *
 * Sert uniquement à valider le moteur avant que les 9,5 Go du SPW soient
 * téléchargés + le pipeline GDAL exécuté. Sortie : public/tiles/synthetic/.
 * Le relief est un fBm plausible (60-360 m), PAS la Wallonie.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import proj4 from "proj4";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Mêmes constantes que 02_build_tiles.py — répliquées dans grid.json, jamais côté TS.
const ROOT_SIZE = 131072;
const SAMPLES = 257;
const BORDER = 1;
const RASTER = SAMPLES + 2 * BORDER;
const HEIGHT_OFFSET = -100.0;
const HEIGHT_SCALE = 0.02;

const maxLevelArg = process.argv.indexOf("--max-level");
const MAX_LEVEL = maxLevelArg >= 0 ? Number(process.argv[maxLevelArg + 1]) : 6;

proj4.defs(
  "EPSG:31370",
  "+proj=lcc +lat_1=51.16666723333333 +lat_2=49.8333339 +lat_0=90 " +
    "+lon_0=4.367486666666666 +x_0=150000.013 +y_0=5400088.438 +ellps=intl " +
    "+towgs84=-106.869,52.2978,-103.724,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs",
);

// Même AOI que le vrai pipeline : centre Beaufays, 16 km.
const aoi = JSON.parse(readFileSync(join(ROOT, "tools", "aoi.json"), "utf8")).home;
const [cx, cy] = proj4("EPSG:4326", "EPSG:31370").forward([aoi.lon, aoi.lat]);
const ox = Math.floor((cx - ROOT_SIZE / 2) / 256) * 256;
const oy = Math.floor((cy - ROOT_SIZE / 2) / 256) * 256;
const half = aoi.sizeM / 2;
const box = [cx - half, cy - half, cx + half, cy + half];

// --- fBm déterministe : même champ continu quel que soit le niveau -> cohérent entre LOD.
function hash(ix, iy) {
  let h = (ix * 374761393 + iy * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function noise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function heightAt(x, y) {
  let value = 0;
  let amp = 1;
  let sum = 0;
  let wavelength = 8000;
  for (let o = 0; o < 8; o++) {
    value += amp * noise(x / wavelength + o * 17.17, y / wavelength - o * 9.31);
    sum += amp;
    amp *= 0.55;
    wavelength /= 2.05;
  }
  const n = value / sum; // ~[0,1], centré sur 0.5
  // Crêtes et vallées incisées, gamme Liège-Ardenne : ~70-380 m, pentes marquées.
  const ridged = 1 - Math.abs(2 * noise(x / 5200 + 8.1, y / 5200 + 2.7) - 1);
  const t = Math.max(0, (n - 0.18) / 0.64);
  return 70 + 340 * Math.pow(t, 1.35) * (0.45 + 0.55 * ridged);
}

const outDir = join(ROOT, "public", "tiles", "synthetic");
const index = {};
let written = 0;

for (let z = 0; z <= MAX_LEVEL; z++) {
  const size = ROOT_SIZE / 2 ** z;
  const res = size / (SAMPLES - 1);
  const n = 2 ** z;
  const x0 = Math.max(0, Math.floor((box[0] - ox) / size));
  const x1 = Math.min(n - 1, Math.floor((box[2] - ox) / size));
  const y0 = Math.max(0, Math.floor((box[1] - oy) / size));
  const y1 = Math.min(n - 1, Math.floor((box[3] - oy) / size));

  let countZ = 0;
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      const minx = ox + tx * size;
      const miny = oy + ty * size;
      const data = new Uint16Array(RASTER * RASTER);
      let minZ = Infinity;
      let maxZ = -Infinity;
      let anyValid = false;
      // Ligne 0 = sud (INV-4) : on génère directement sud -> nord.
      for (let row = 0; row < RASTER; row++) {
        const yM = miny + (row - BORDER) * res;
        for (let col = 0; col < RASTER; col++) {
          const xM = minx + (col - BORDER) * res;
          const inside = xM >= box[0] && xM <= box[2] && yM >= box[1] && yM <= box[3];
          let h = HEIGHT_OFFSET; // VOID
          if (inside) {
            h = heightAt(xM, yM);
            anyValid = true;
            if (h < minZ) minZ = h;
            if (h > maxZ) maxZ = h;
          }
          data[row * RASTER + col] = Math.min(
            65535,
            Math.max(0, Math.round((h - HEIGHT_OFFSET) / HEIGHT_SCALE)),
          );
        }
      }
      if (!anyValid) continue;
      const dir = join(outDir, String(z), String(tx));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${ty}.bin`), Buffer.from(data.buffer));
      index[`${z}/${tx}/${ty}`] = {
        minZ: Math.round(minZ * 100) / 100,
        maxZ: Math.round(maxZ * 100) / 100,
      };
      countZ++;
      written++;
    }
  }
  console.log(`  z=${z}  ${countZ} tuiles  (${res.toFixed(1)} m/sample)`);
}

const grid = {
  crs: "EPSG:31370",
  rootSize: ROOT_SIZE,
  origin: [ox, oy],
  maxLevel: MAX_LEVEL,
  baseUrl: "/tiles/synthetic",
};
const encoding = {
  raster: RASTER,
  samples: SAMPLES,
  border: BORDER,
  heightScale: HEIGHT_SCALE,
  heightOffset: HEIGHT_OFFSET,
  dtype: "uint16le",
};
writeFileSync(join(outDir, "grid.json"), JSON.stringify(grid, null, 2));
writeFileSync(
  join(outDir, "index.json"),
  JSON.stringify({ aoi: "synthetic", grid, encoding, tiles: index }),
);
console.log(`\nOK : ${written} tuiles synthétiques -> ${outDir}`);
