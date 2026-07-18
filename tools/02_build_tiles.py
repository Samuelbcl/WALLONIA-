#!/usr/bin/env python3
"""
02_build_tiles.py — AOI GeoTIFF -> pyramide de tuiles .bin + grid.json + index.json

    python tools/02_build_tiles.py --aoi home --max-level 9   # production
    python tools/02_build_tiles.py --aoi home --max-level 6   # iteration dev (secondes)

Format d'une tuile : 259 x 259 uint16 little-endian, sans en-tete.
Voir docs/DATA-PIPELINE.md § 3-5. Les invariants INV-2, INV-3, INV-5 vivent ici.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.enums import Resampling

ROOT = Path(__file__).resolve().parent.parent

# --- Constantes de grille. Repliquees dans grid.json, JAMAIS en dur cote TS. ---
ROOT_SIZE = 131072          # 2^17 m
SAMPLES = 257               # samples utiles par tuile, indices 0..256, bords partages
BORDER = 1                  # anneau de bordure pour les normales (INV-3)
RASTER = SAMPLES + 2 * BORDER   # 259

HEIGHT_OFFSET = -100.0      # m
HEIGHT_SCALE = 0.02         # m par pas -> plage [-100, +1211], precision 2 cm
VOID = 0                    # u16 == 0 -> -100 m -> le shader discard (hors AOI)


def encode(h: np.ndarray) -> np.ndarray:
    """metres float -> uint16. INV-5 : tout ce qui est aberrant est clampe ici."""
    h = np.nan_to_num(h, nan=HEIGHT_OFFSET, posinf=HEIGHT_OFFSET, neginf=HEIGHT_OFFSET)
    u = np.round((h - HEIGHT_OFFSET) / HEIGHT_SCALE)
    return np.clip(u, 0, 65535).astype(np.uint16)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", required=True)
    ap.add_argument("--max-level", type=int, default=9)
    args = ap.parse_args()

    if not 0 <= args.max_level <= 9:
        sys.exit("--max-level doit etre dans [0, 9]. Le niveau 9 = 1 m/sample = resolution native.")

    aois = json.loads((ROOT / "tools" / "aoi.json").read_text())
    aoi = aois[args.aoi]
    src_path = ROOT / "data" / f"aoi_{args.aoi}_31370.tif"
    if not src_path.exists():
        sys.exit(f"{src_path} absent. Lance d'abord 01_prepare_aoi.py --aoi {args.aoi}")

    out_dir = ROOT / "public" / "tiles" / args.aoi
    out_dir.mkdir(parents=True, exist_ok=True)

    # --- origine de la grille : root centre sur l'AOI, arrondi a 256 m ---------
    tf = Transformer.from_crs("EPSG:4326", "EPSG:31370", always_xy=True)
    cx, cy = tf.transform(aoi["lon"], aoi["lat"])
    ox = math.floor((cx - ROOT_SIZE / 2) / 256) * 256
    oy = math.floor((cy - ROOT_SIZE / 2) / 256) * 256

    half = aoi["sizeM"] / 2.0
    aoi_box = (cx - half, cy - half, cx + half, cy + half)

    print(f"AOI      : {args.aoi}  ({aoi['sizeM'] / 1000:g} km)")
    print(f"origine  : ({ox}, {oy}) EPSG:31370")
    print(f"niveaux  : 0 -> {args.max_level}")

    index: dict[str, dict[str, float]] = {}
    written = 0

    with rasterio.open(src_path) as src:
        nodata = src.nodata

        for z in range(args.max_level + 1):
            size = ROOT_SIZE / (2 ** z)
            res = size / (SAMPLES - 1)          # niveau 9 -> 1.0 m
            n = 2 ** z

            # ne parcourir que les tuiles qui intersectent l'AOI
            x0 = max(0, int((aoi_box[0] - ox) // size))
            x1 = min(n - 1, int((aoi_box[2] - ox) // size))
            y0 = max(0, int((aoi_box[1] - oy) // size))
            y1 = min(n - 1, int((aoi_box[3] - oy) // size))

            count_z = 0
            for tx in range(x0, x1 + 1):
                for ty in range(y0, y1 + 1):
                    minx = ox + tx * size
                    miny = oy + ty * size

                    # INV-3 : le sample i (i de -1 a 257) est a minx + i*res.
                    # rasterio veut les BORDS -> +/- un demi-pixel autour des centres extremes.
                    left = minx - res - res / 2
                    right = minx + (SAMPLES + BORDER - 1) * res + res / 2
                    bottom = miny - res - res / 2
                    top = miny + (SAMPLES + BORDER - 1) * res + res / 2

                    win = rasterio.windows.from_bounds(
                        left, bottom, right, top, transform=src.transform
                    )
                    # boundless : hors AOI -> VOID. Utilise les overviews de gdaladdo.
                    data = src.read(
                        1,
                        window=win,
                        out_shape=(RASTER, RASTER),
                        resampling=Resampling.average if z < 9 else Resampling.bilinear,
                        boundless=True,
                        fill_value=HEIGHT_OFFSET,
                    ).astype(np.float32)

                    if nodata is not None:
                        data[data == nodata] = HEIGHT_OFFSET

                    # rasterio rend les lignes nord->sud. On veut ligne 0 = sud. (INV-4)
                    data = np.flipud(data)

                    valid = data[data > HEIGHT_OFFSET + 1.0]
                    if valid.size == 0:
                        continue  # tuile entierement hors AOI -> 404 -> noeud sterile

                    tile_dir = out_dir / str(z) / str(tx)
                    tile_dir.mkdir(parents=True, exist_ok=True)
                    (tile_dir / f"{ty}.bin").write_bytes(encode(data).tobytes())

                    index[f"{z}/{tx}/{ty}"] = {
                        "minZ": round(float(valid.min()), 2),
                        "maxZ": round(float(valid.max()), 2),
                    }
                    count_z += 1
                    written += 1

            print(f"  z={z}  {count_z:5d} tuiles   ({res:g} m/sample)")

    grid = {
        "crs": "EPSG:31370",
        "rootSize": ROOT_SIZE,
        "origin": [ox, oy],
        "maxLevel": args.max_level,
        "baseUrl": f"/tiles/{args.aoi}",
    }
    encoding = {
        "raster": RASTER,
        "samples": SAMPLES,
        "border": BORDER,
        "heightScale": HEIGHT_SCALE,
        "heightOffset": HEIGHT_OFFSET,
        "dtype": "uint16le",
    }
    (out_dir / "grid.json").write_text(json.dumps(grid, indent=2))
    (out_dir / "index.json").write_text(
        json.dumps({"aoi": args.aoi, "grid": grid, "encoding": encoding, "tiles": index})
    )

    mb = written * RASTER * RASTER * 2 / 1e6
    print(f"\nOK : {written} tuiles, ~{mb:.0f} Mo brut -> {out_dir}")
    print("\nSanity check :")
    print("  - une tuile pese exactement 134162 octets (259*259*2)")
    print("  - grid.json + index.json existent")
    print("  - AUCUNE de ces constantes ne doit etre recopiee en dur dans le TypeScript")


if __name__ == "__main__":
    main()
