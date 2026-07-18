# DATA-PIPELINE

De la donnée LiDAR brute du SPW aux tuiles servies par Vite.

---

## 1. Télécharger

**Téléchargement direct, sans compte, sans délai.**

```bash
mkdir -p data/raw && cd data/raw

# MNT 1m 2021-2022 — Province de Liège — GeoTIFF — EPSG:3812 — 9,5 Go
curl -L -O --retry 5 --retry-delay 10 -C - \
  "https://geoservices.wallonie.be/geotraitement/spwdatadownload/results/fe13bc84-e371-46ca-9632-8ad4139f1ee5/RELIEF_WALLONIE_MNT_1M_2021_2022_GEOTIFF_3812_PROV_LIEGE.zip"

unzip RELIEF_WALLONIE_MNT_1M_2021_2022_GEOTIFF_3812_PROV_LIEGE.zip
```

`-C -` reprend le téléchargement si ça coupe. 9,5 Go, lance-le et va boire un café.

**Autres provinces** (même pattern, remplacer le suffixe) :

| Province | Suffixe | Poids |
|---|---|---|
| Liège | `_PROV_LIEGE` | 9,5 Go |
| Luxembourg | `_PROV_LUXEMBOURG` | 11,2 Go |
| Namur | `_PROV_NAMUR` | 8,9 Go |
| Hainaut | `_PROV_HAINAUT` | 8,8 Go |
| Brabant wallon | `_PROV_BRABANT_WALLON` | 2,6 Go |
| Wallonie entière | *(pas de suffixe)* | 40,9 Go |

Fiche descriptive : `https://geoportail.wallonie.be/catalogue/fe13bc84-e371-46ca-9632-8ad4139f1ee5.html`

> **Note.** Il existe aussi un MNT **0,5 m** (fiche `a004e570-99d6-4fe5-b83d-49b774409278`).
> Ne pas l'utiliser. 4× le poids pour une précision altimétrique identique (0,12 m) et un
> détail géométrique que le moteur n'affichera jamais. Le 1 m est une production dédiée, pas
> un downsample du 0,5 m.
>
> **MNT ≠ MNS.** Le MNT est le sol nu (ce qu'on veut). Le MNS inclut bâtiments et végétation
> — utile pour la phase 2 si on veut des arbres, inutile maintenant.

## 2. Découper l'AOI

`tools/aoi.json` :

```json
{
  "home": { "lat": 50.5665, "lon": 5.6250, "sizeM": 16000 },
  "east": { "lat": 50.5300, "lon": 5.9000, "sizeM": 64000 }
}
```

`tools/01_prepare_aoi.py` fait, dans l'ordre :

1. **VRT** — `gdalbuildvrt` sur tous les `.tif` de `data/raw/`. Instantané, zéro copie.
2. **bbox** — `pyproj` : centre WGS84 → EPSG:31370, puis ±sizeM/2, arrondi au mètre.
3. **warp** — `gdalwarp` : 3812 → 31370, crop à la bbox, `-tr 1 1`, `-r bilinear`.
4. **fillnodata** — `gdal_fillnodata` (INV-5). Les plans d'eau n'ont pas de retour LiDAR.
5. **overviews** — `gdaladdo -r average` niveaux 2..256. **Indispensable** : sans ça, générer
   une tuile de niveau 0 lit 16000×16000 pixels. Avec, rasterio lit l'overview directement.

Sortie : `data/aoi_home_31370.tif` + son `.ovr`.

**Vérification obligatoire avant d'aller plus loin :**

```bash
gdalinfo -stats data/aoi_home_31370.tif
```

Attendu pour `home` : `Min` ≈ 60-70 m (la Meuse à Liège), `Max` ≈ 350-370 m (les plateaux de
Beaufays / Sprimont). `NoData Value` absent ou `nan` après fillnodata.

Si `Min` est négatif ou proche de −9999 → le fillnodata n'a pas pris, retour étape 4.
Si `Max` > 700 → le crop est faux, tu es sorti de la Wallonie ou la bbox est en 3812.

## 3. Grille de tuiles

Émise dans `public/tiles/{aoi}/grid.json` par le builder. **Aucune de ces valeurs n'est en
dur dans le TypeScript.**

```
CRS            EPSG:31370 (Lambert 72)
ROOT_SIZE      131072 m          (2^17)
ORIGIN         centre AOI − ROOT_SIZE/2, arrondi à 256 m près
LEVELS         0 .. 9
```

Tuile `(z, x, y)` :

```
size  = ROOT_SIZE / 2^z          # niveau 9 -> 256 m
res   = size / 256               # niveau 9 -> 1 m/sample   <- résolution native du MNT
minX  = ORIGIN.x + x * size
minY  = ORIGIN.y + y * size
```

| z | Côté tuile | Résolution |
|---|---|---|
| 0 | 131 072 m | 512 m |
| 5 | 4 096 m | 16 m |
| 7 | 1 024 m | 4 m |
| 9 | **256 m** | **1 m** ← natif |

Le builder ne génère **que** les tuiles qui intersectent l'AOI. Le reste n'existe pas ; le
runtime traite un 404 comme « pas de donnée » et ne subdivise pas.

## 4. Format d'une tuile

**Fichier** : `public/tiles/{aoi}/{z}/{x}/{y}.bin`
**Contenu** : `259 × 259` × `uint16` **little-endian**, sans en-tête. 134 162 octets exactement.

### Layout (INV-3)

- **257 samples utiles**, indices `i ∈ [0, 256]`, sample `i` à `minX + i * res`.
  Les samples `0` et `256` tombent **exactement sur les bords** de la tuile → partagés à
  l'identique avec les tuiles voisines → **zéro fissure** entre tuiles de même niveau.
- **+1 anneau de bordure** de chaque côté (`i ∈ [-1, 257]`) → 259 samples au total.
  Sert uniquement au calcul des normales en différences centrées sur les bords.
- **Ordre des lignes : ligne 0 = Y minimum (sud).** Le builder retourne les lignes de
  rasterio (qui sont nord→sud). Ne pas oublier.

### Encodage

```
u16    = clamp(round((h_m - HEIGHT_OFFSET) / HEIGHT_SCALE), 0, 65535)
h_m    = u16 * HEIGHT_SCALE + HEIGHT_OFFSET

HEIGHT_OFFSET = -100.0
HEIGHT_SCALE  = 0.02
```

Plage utile : **−100 m → +1211 m**, précision **2 cm**.
Le point culminant de Belgique est le Signal de Botrange à 694 m ; la précision absolue du
LiDAR est de 12 cm. Les deux marges sont larges. Ne pas toucher à ces constantes.

### Pourquoi pas du PNG Terrain-RGB (INV-2)

Le format Mapbox encode la hauteur sur 3 canaux 8 bits. Le GPU, en filtrage linéaire,
interpole R, G et B **indépendamment** — puis on décode. `decode(lerp(a,b)) ≠ lerp(decode(a), decode(b))`
dès qu'un canal déborde. Résultat : des pics d'un mètre en damier partout.

Les contournements (NearestFilter + bilinéaire manuel à 4 taps dans le shader) coûtent plus
cher que le problème qu'ils résolvent. Le `.bin` uint16 → `Float32Array` → `DataTexture`
`RedFormat`/`FloatType` se filtre nativement et correctement. C'est plus simple *et* plus juste.

Poids comparable : 134 Ko brut, ~45-60 Ko après brotli (le relief est lisse, ça compresse bien).

## 5. Index

`public/tiles/{aoi}/index.json` :

```json
{
  "aoi": "home",
  "grid": { "crs": "EPSG:31370", "rootSize": 131072, "origin": [180000, 80000], "maxLevel": 9 },
  "encoding": { "raster": 259, "samples": 257, "heightScale": 0.02, "heightOffset": -100.0 },
  "tiles": {
    "9/412/318": { "minZ": 92.4, "maxZ": 271.8 }
  }
}
```

Les `minZ`/`maxZ` par tuile ne sont pas décoratifs : ils donnent la **bounding box verticale**
pour le frustum culling. Sans eux tu culles avec une AABB plate et tu rates les tuiles dont
le sommet entre dans le frustum alors que la base n'y est pas.

## 6. Servir

**Dev** : Vite sert `public/` tel quel. Rien à faire.

**Build** : pré-compresser en brotli et servir avec `Content-Encoding: br`. Vercel le fait
automatiquement pour les statiques, mais **pas** pour les extensions inconnues comme `.bin`.
Vérifier le header dans l'onglet Network. Si absent, précompresser en `.bin.br` et servir
explicitement.

**Poids** (AOI `home`, 16 km) :

| Niveau max | Tuiles | Brut | Brotli (est.) |
|---|---|---|---|
| 6 | ~85 | 11 Mo | ~4 Mo |
| 7 | ~340 | 46 Mo | ~16 Mo |
| 8 | ~1 020 | 137 Mo | ~48 Mo |
| 9 | ~4 060 | 545 Mo | ~190 Mo |

Pendant le dev, `--max-level 6` : le builder tourne en secondes au lieu de minutes, et tu
itères sur le moteur, pas sur la donnée. Repasse à 9 seulement pour les captures.

**Déploiement** : 190 Mo dans le repo git = non. Les tuiles vont sur **Supabase Storage**
(bucket public + CDN, `eu-central-1`). `grid.json` porte l'URL de base. À faire après M2,
pas avant — en local le problème n'existe pas.

## 7. Orthophoto (phase 1.5, pas maintenant)

Service WMS « dernière campagne disponible », 25 cm de résolution :

```
https://geoservices.wallonie.be/arcgis/services/IMAGERIE/ORTHO_LAST/MapServer/WMSServer?request=GetCapabilities&service=WMS
```

CRS supportés : **EPSG:31370**, 4326, 3857. Le 31370 est natif → c'est exactement la raison
de la décision D2 : une requête `GetMap` avec la bbox d'une tuile retourne pixel-parfait
sa texture, sans reprojection.

Version figée si besoin de reproductibilité : `ORTHO_2023_ETE` (même pattern d'URL).

**Mise en cache au build, pas de fetch WMS au runtime.** Le service a ses propres conditions
d'utilisation (distinctes du CC-BY du MNT, voir `LicServicesSPW.pdf` sur le Géoportail) et
marteler un serveur public à chaque frame de jeu n'est pas correct. Un fetch au build, capé à
1 m/px, pour l'AOI seule.

## 8. Licence

MNT 2021-2022 : **CC-BY 4.0**. Utilisation, modification et redistribution libres, y compris
commerciale, **à condition de citer la source**. Citation exacte demandée par le SPW :

```
Service public de Wallonie (SPW) - Relief de la Wallonie - Modèle Numérique de Terrain - 1m
(MNT) 2021-2022 (2024-01-23)
https://geodata.wallonie.be/id/fe13bc84-e371-46ca-9632-8ad4139f1ee5
```

Version courte pour l'écran : `Relief : © SPW — MNT 1m 2021-2022 — CC-BY 4.0`.
