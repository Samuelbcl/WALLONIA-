# CLAUDE.md — Manuel opératoire

Tu construis **WALLONIA**, un moteur de terrain 3D sur données LiDAR réelles du SPW.
Lis `BRIEF.md` avant toute chose. Puis `docs/ARCHITECTURE.md` et `docs/DATA-PIPELINE.md`.

---

## Stack — figée

**Autorisé :**
```
three                 ^0.180
typescript            ^5.6
vite                  ^6
proj4                 ^2.12     (build + runtime, conversions CRS)
lil-gui               ^0.20     (debug uniquement)
stats.js              ^0.17     (debug uniquement)
```

**Python (build-time uniquement) :**
```
rasterio, numpy, pyproj
+ GDAL CLI (gdalbuildvrt, gdalwarp, gdaladdo, gdal_fillnodata)
```

**Interdit sans discussion explicite :**
- Next.js, React, tout framework UI. Le HUD est en DOM natif.
- Toute lib de terrain toute faite (CesiumJS, three-geo, etc.). Le but est de le construire.
- Tout state manager, router, ORM, backend.
- `localStorage` / `sessionStorage`.
- Toute dépendance qui n'est pas dans la liste ci-dessus. Si tu penses en avoir besoin :
  **arrête-toi et demande**, en donnant le poids ajouté et ce que ça remplace.

## Commandes

```bash
npm run dev          # Vite dev server
npm run build        # build statique -> dist/
npm run typecheck    # tsc --noEmit

# Pipeline données (Python, une fois)
python tools/01_prepare_aoi.py --aoi home
python tools/02_build_tiles.py --aoi home --max-level 9
python tools/02_build_tiles.py --aoi home --max-level 6   # itération rapide pendant le dev
```

## Invariants techniques

Ces sept points sont les pièges qui coûtent une journée chacun. Ils sont non négociables.
Si un symptôme de la colonne droite apparaît, va directement à l'invariant correspondant.

| # | Invariant | Symptôme si violé |
|---|---|---|
| **INV-1** | La heightmap est une `DataTexture` **`RedFormat` + `FloatType` + `LinearFilter` + `ClampToEdgeWrapping`**, avec `colorSpace = THREE.NoColorSpace`. | Terrain en escaliers, ou altitudes multipliées par ~2,2 (conversion sRGB appliquée à des données). |
| **INV-2** | On n'utilise **jamais** Terrain-RGB / PNG pour l'élévation. Le `.bin` uint16 est décodé en Float32 côté JS. | Pics de terrain aléatoires aux frontières de canaux (interpoler R,G,B séparément puis décoder ≠ interpoler la hauteur). |
| **INV-3** | Le raster d'une tuile fait **259×259** samples : 257 samples bord-à-bord (indices 0..256, les 0 et 256 sont *partagés* avec les tuiles voisines) + 1 anneau de bordure pour les normales. UV : `texel = (uv * 256.0 + 1.5) / 259.0`. | Fissures entre tuiles de même niveau ; normales fausses sur les bords (couture noire visible). |
| **INV-4** | **Nord = −Z.** `renderPos = vec3(X − originX, h, −(Y − originY))`. Ce flip inverse le winding : l'index buffer de la géométrie doit être bobiné en conséquence. | Terrain miroir (l'Ourthe coule dans le mauvais sens) ; ou terrain invisible / noir (winding inversé + backface culling). |
| **INV-5** | Le NoData du MNT est **rempli au build** (`gdal_fillnodata`), jamais au runtime. Puis clamp `[-100, +1211]` avant encodage. | Puits infinis et pics à −9999 m. Surtout sur les plans d'eau. |
| **INV-6** | Une tuile ne se subdivise que quand **ses 4 enfants sont chargés**. Split et merge ont des seuils **différents** (hystérésis, ratio 1.25). | Trous béants pendant le vol ; ou clignotement/thrashing de LOD à la limite. |
| **INV-7** | Chaque tuile a **son propre clone de `ShaderMaterial`** (`material.clone()`). Three met en cache le programme par source de shader, le clone ne recompile rien. | Toutes les tuiles affichent la même heightmap (uniforms écrasés). |

## Conventions de code

- TypeScript strict. `noUncheckedIndexedAccess: true`. Pas de `any`, pas de `!` non justifié.
- Un fichier = une classe/un système. Pas de fichier > 300 lignes.
- Les shaders sont dans des `.glsl` séparés, importés via `?raw`. Pas de template string dans le TS.
- Unités : **mètres, radians, secondes**. Toujours. Suffixer si ambigu : `altitudeM`, `headingRad`.
- Les constantes de grille (`ROOT_SIZE`, `HEIGHT_SCALE`, `HEIGHT_OFFSET`, origine) viennent
  **exclusivement de `grid.json`** émis par le builder. **Zéro constante géo en dur dans le TS.**
  Si tu écris `235000` quelque part, tu t'es trompé.
- Pas de commentaire qui paraphrase le code. Les commentaires expliquent le *pourquoi* et
  référencent les invariants (`// INV-3: bordure d'un texel`).

## Boucle de travail

1. Lis le jalon courant dans `BRIEF.md` § 5.
2. Annonce le plan en 3-5 lignes. Attends rien, exécute.
3. Implémente **la plus petite tranche verticale visible à l'écran**. Jamais de couche
   abstraite « pour plus tard ». Pas d'interface avec une seule implémentation.
4. `npm run typecheck` doit passer avant de dire que c'est fini.
5. À chaque fin de jalon : rappelle la DoD et dis honnêtement si elle est atteinte ou pas.

## Protocole de debug

Dans l'ordre, avant de proposer une hypothèse :

1. **Regarde l'écran.** Décris ce que tu vois vs. ce qui est attendu.
2. **Compare à la vérité terrain.** La bbox rendue vs. la même bbox dans QGIS ou sur
   [WalOnMap](https://geoportail.wallonie.be/walonmap). Le relief wallon est vérifiable,
   utilise-le.
3. **Isole la couche.** Donnée fausse (inspecte le `.tif` avec `gdalinfo -stats`) ?
   Encodage faux (dump 10 valeurs du `.bin`) ? Shader faux (sors la hauteur en couleur brute) ?
4. **Consulte le tableau des invariants ci-dessus.** 7 fois sur 10 c'est un des sept.
5. Seulement après : hypothèse.

**Ne jamais** « corriger » en ajoutant un facteur d'échelle magique, un offset ou un
`* 0.5` empirique pour que ça ait l'air juste. Si un facteur arbitraire est nécessaire,
c'est qu'un invariant est violé en amont. Trouve-le.

## Quand t'arrêter et demander

- Une dépendance hors liste semble nécessaire.
- Une décision figée (`BRIEF.md` § 4) semble mauvaise et tu as une mesure pour le prouver.
- Le budget perf est dépassé et la solution change l'architecture.
- Une tâche est manifestement hors scope de la phase 1 → note dans `IDEAS.md`, continue.

## Attentes de ton interlocuteur

Samuel code vite et lit vite. Il veut des livrables exécutables, pas des explications.
Sois direct, dense, sans préambule. Si un truc est cassé, dis-le franchement.
Ne dis jamais que quelque chose marche sans l'avoir vu marcher.
