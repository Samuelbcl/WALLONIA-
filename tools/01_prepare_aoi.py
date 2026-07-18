#!/usr/bin/env python3
"""
01_prepare_aoi.py — MNT brut SPW (EPSG:3812) -> AOI reprojetee, nettoyee, pyramidee.

    python tools/01_prepare_aoi.py --aoi home

Prerequis : data/raw/ contient les GeoTIFF dezippes du SPW.
Voir docs/DATA-PIPELINE.md § 1.

Sortie : data/aoi_{name}_31370.tif  (+ .ovr)
"""

import argparse
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data"

SRC_CRS = "EPSG:3812"   # Lambert Belge 2008 — CRS natif du MNT SPW
DST_CRS = "EPSG:31370"  # Lambert Belge 72 — CRS monde du projet (decision D2)


def run(cmd: list[str]) -> None:
    print("  $", " ".join(str(c) for c in cmd))
    subprocess.run(cmd, check=True)


def which_fillnodata() -> list[str]:
    """gdal_fillnodata est un binaire sur les GDAL recents, un script .py avant."""
    for candidate in ("gdal_fillnodata", "gdal_fillnodata.py"):
        if shutil.which(candidate):
            return [candidate]
    return [sys.executable, "-m", "osgeo_utils.gdal_fillnodata"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", required=True, help="cle dans tools/aoi.json")
    args = ap.parse_args()

    aois = json.loads((ROOT / "tools" / "aoi.json").read_text())
    if args.aoi not in aois:
        sys.exit(f"AOI '{args.aoi}' inconnue. Disponibles : {list(aois)}")
    aoi = aois[args.aoi]

    tifs = sorted(RAW.rglob("*.tif")) + sorted(RAW.rglob("*.tiff"))
    if not tifs:
        sys.exit(f"Aucun GeoTIFF dans {RAW}. Voir docs/DATA-PIPELINE.md § 1.")
    print(f"[1/5] {len(tifs)} GeoTIFF sources trouves")

    OUT.mkdir(parents=True, exist_ok=True)

    # --- bbox : centre WGS84 -> EPSG:31370, +/- sizeM/2 ---------------------
    tf = Transformer.from_crs("EPSG:4326", DST_CRS, always_xy=True)
    cx, cy = tf.transform(aoi["lon"], aoi["lat"])
    half = aoi["sizeM"] / 2.0
    minx, miny = math.floor(cx - half), math.floor(cy - half)
    maxx, maxy = math.ceil(cx + half), math.ceil(cy + half)
    print(f"      centre 31370 : ({cx:.1f}, {cy:.1f})")
    print(f"      bbox 31370   : {minx} {miny} {maxx} {maxy}")

    # --- VRT : zero copie, GDAL voit toutes les dalles comme un seul raster --
    vrt = OUT / f"raw_{args.aoi}.vrt"
    listfile = OUT / f"raw_{args.aoi}.txt"
    listfile.write_text("\n".join(str(t) for t in tifs))
    print("[2/5] VRT")
    run(["gdalbuildvrt", "-input_file_list", str(listfile), "-overwrite", str(vrt)])

    # --- warp : 3812 -> 31370, crop, 1 m --------------------------------------
    warped = OUT / f"aoi_{args.aoi}_31370_raw.tif"
    print("[3/5] warp + crop (long : plusieurs minutes)")
    run([
        "gdalwarp",
        "-s_srs", SRC_CRS, "-t_srs", DST_CRS,
        "-te", str(minx), str(miny), str(maxx), str(maxy),
        "-tr", "1", "1",
        "-r", "bilinear",
        "-of", "GTiff",
        "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=2",
        "-co", "BIGTIFF=IF_SAFER",
        "-multi", "-wo", "NUM_THREADS=ALL_CPUS",
        "-overwrite",
        str(vrt), str(warped),
    ])

    # --- fillnodata : INV-5. Les plans d'eau n'ont pas de retour LiDAR. -------
    final = OUT / f"aoi_{args.aoi}_31370.tif"
    print("[4/5] fillnodata")
    run(which_fillnodata() + [
        "-md", "50", "-si", "1", "-b", "1",
        "-of", "GTiff",
        "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=2",
        "-co", "BIGTIFF=IF_SAFER",
        str(warped), str(final),
    ])

    # --- overviews : sans ca, generer une tuile de niveau 0 lit tout le raster.
    print("[5/5] overviews")
    run(["gdaladdo", "-r", "average", "--config", "COMPRESS_OVERVIEW", "DEFLATE",
         str(final), "2", "4", "8", "16", "32", "64", "128", "256"])

    warped.unlink(missing_ok=True)
    listfile.unlink(missing_ok=True)

    print(f"\nOK -> {final}")
    print("\nVERIFICATION OBLIGATOIRE (docs/DATA-PIPELINE.md § 2) :")
    print(f"  gdalinfo -stats {final}")
    print("  Attendu pour 'home' : Min ~60-70 m (la Meuse), Max ~350-370 m (plateau de Beaufays).")
    print("  Min negatif ou ~-9999  -> le fillnodata n'a pas pris.")
    print("  Max > 700              -> la bbox est fausse (encore en 3812 ?).")


if __name__ == "__main__":
    main()
