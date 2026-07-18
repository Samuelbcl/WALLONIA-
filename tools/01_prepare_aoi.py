#!/usr/bin/env python3
"""
01_prepare_aoi.py — MNT brut SPW (EPSG:3812) -> AOI reprojetee, nettoyee, pyramidee.

    python tools/01_prepare_aoi.py --aoi home

Prerequis : data/raw/ contient les GeoTIFF dezippes du SPW.
Voir docs/DATA-PIPELINE.md § 1.

Deux chemins d'execution, meme resultat :
  - GDAL CLI (gdalbuildvrt/gdalwarp/gdaladdo) si present — plus econome en RAM.
  - rasterio pur sinon (meme GDAL en dessous). Charge l'AOI entiere en memoire :
    OK pour home (16 km ~ 1 Go), deconseille pour east (64 km) — installer GDAL CLI.

Sortie : data/aoi_{name}_31370.tif  (+ overviews internes ou .ovr)
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

FILL_DISTANCE = 50      # INV-5 : gdal_fillnodata -md 50
FILL_SMOOTHING = 1      # -si 1
OVERVIEWS = [2, 4, 8, 16, 32, 64, 128, 256]


def run(cmd: list[str]) -> None:
    print("  $", " ".join(str(c) for c in cmd))
    subprocess.run(cmd, check=True)


def which_fillnodata() -> list[str]:
    """gdal_fillnodata est un binaire sur les GDAL recents, un script .py avant."""
    for candidate in ("gdal_fillnodata", "gdal_fillnodata.py"):
        if shutil.which(candidate):
            return [candidate]
    return [sys.executable, "-m", "osgeo_utils.gdal_fillnodata"]


def has_gdal_cli() -> bool:
    return all(shutil.which(t) for t in ("gdalbuildvrt", "gdalwarp", "gdaladdo"))


def prepare_with_cli(tifs: list[Path], bbox: tuple[int, int, int, int], aoi_name: str, final: Path) -> None:
    minx, miny, maxx, maxy = bbox

    vrt = OUT / f"raw_{aoi_name}.vrt"
    listfile = OUT / f"raw_{aoi_name}.txt"
    listfile.write_text("\n".join(str(t) for t in tifs))
    print("[2/5] VRT")
    run(["gdalbuildvrt", "-input_file_list", str(listfile), "-overwrite", str(vrt)])

    warped = OUT / f"aoi_{aoi_name}_31370_raw.tif"
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

    print("[4/5] fillnodata")
    run(which_fillnodata() + [
        "-md", str(FILL_DISTANCE), "-si", str(FILL_SMOOTHING), "-b", "1",
        "-of", "GTiff",
        "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=2",
        "-co", "BIGTIFF=IF_SAFER",
        str(warped), str(final),
    ])

    print("[5/5] overviews")
    run(["gdaladdo", "-r", "average", "--config", "COMPRESS_OVERVIEW", "DEFLATE",
         str(final)] + [str(o) for o in OVERVIEWS])

    warped.unlink(missing_ok=True)
    listfile.unlink(missing_ok=True)


def prepare_with_rasterio(tifs: list[Path], bbox: tuple[int, int, int, int], size_m: float, final: Path) -> None:
    import numpy as np
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.fill import fillnodata
    from rasterio.transform import from_origin
    from rasterio.warp import reproject, transform_bounds

    if size_m > 20_000:
        print("ATTENTION : chemin rasterio = AOI entiere en RAM. Pour une AOI de "
              f"{size_m / 1000:g} km, installe GDAL CLI (OSGeo4W) et relance.")

    minx, miny, maxx, maxy = bbox
    width, height = maxx - minx, maxy - miny
    dst_transform = from_origin(minx, maxy, 1, 1)
    dst = np.full((height, width), np.nan, dtype=np.float32)

    # Selection des dalles sources qui intersectent l'AOI (bornes en 3812).
    sb = transform_bounds(DST_CRS, SRC_CRS, minx, miny, maxx, maxy, densify_pts=21)
    margin = 50.0
    selected = []
    for path in tifs:
        with rasterio.open(path) as src:
            b = src.bounds
            if (b.right < sb[0] - margin or b.left > sb[2] + margin
                    or b.top < sb[1] - margin or b.bottom > sb[3] + margin):
                continue
            selected.append(path)
    if not selected:
        sys.exit("Aucune dalle source n'intersecte l'AOI. Mauvaise province telechargee ?")
    print(f"[2/5] {len(selected)} dalles sur {len(tifs)} intersectent l'AOI")

    print("[3/5] warp + crop rasterio (long : plusieurs minutes)")
    for i, path in enumerate(selected):
        with rasterio.open(path) as src:
            # init_dest_nodata=False : chaque dalle ne remplit que sa zone,
            # sans ecraser ce que les dalles precedentes ont pose.
            reproject(
                source=rasterio.band(src, 1),
                destination=dst,
                dst_transform=dst_transform,
                dst_crs=DST_CRS,
                dst_nodata=np.nan,
                resampling=Resampling.bilinear,
                init_dest_nodata=False,
            )
        print(f"      {i + 1}/{len(selected)} {path.name}")

    print("[4/5] fillnodata")  # INV-5 : les plans d'eau n'ont pas de retour LiDAR
    valid = (~np.isnan(dst)).astype(np.uint8) * 255
    if valid.min() == 255:
        print("      rien a remplir")
    else:
        dst = fillnodata(dst, mask=valid,
                         max_search_distance=FILL_DISTANCE,
                         smoothing_iterations=FILL_SMOOTHING)

    print("[5/5] ecriture + overviews")
    profile = {
        "driver": "GTiff", "height": height, "width": width, "count": 1,
        "dtype": "float32", "crs": DST_CRS, "transform": dst_transform,
        "tiled": True, "blockxsize": 256, "blockysize": 256,
        "compress": "deflate", "predictor": 2, "nodata": float("nan"),
        "BIGTIFF": "IF_SAFER",
    }
    with rasterio.open(final, "w", **profile) as out:
        out.write(dst, 1)
    with rasterio.open(final, "r+") as out:
        out.build_overviews(OVERVIEWS, Resampling.average)
        out.update_tags(ns="rio_overview", resampling="average")


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
    bbox = (math.floor(cx - half), math.floor(cy - half),
            math.ceil(cx + half), math.ceil(cy + half))
    print(f"      centre 31370 : ({cx:.1f}, {cy:.1f})")
    print(f"      bbox 31370   : {bbox[0]} {bbox[1]} {bbox[2]} {bbox[3]}")

    final = OUT / f"aoi_{args.aoi}_31370.tif"
    if has_gdal_cli():
        prepare_with_cli(tifs, bbox, args.aoi, final)
    else:
        print("      GDAL CLI absent -> chemin rasterio pur")
        prepare_with_rasterio(tifs, bbox, aoi["sizeM"], final)

    print(f"\nOK -> {final}")
    print("\nVERIFICATION OBLIGATOIRE (docs/DATA-PIPELINE.md § 2) :")
    print(f"  gdalinfo -stats {final}   (ou: py -c \"import rasterio;s=rasterio.open(r'{final}');import numpy as np;a=s.read(1);print(np.nanmin(a), np.nanmax(a))\")")
    print("  Attendu pour 'home' : Min ~60-70 m (la Meuse), Max ~350-370 m (plateau de Beaufays).")
    print("  Min negatif ou ~-9999  -> le fillnodata n'a pas pris.")
    print("  Max > 700              -> la bbox est fausse (encore en 3812 ?).")


if __name__ == "__main__":
    main()
