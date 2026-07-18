# WALLONIA — BRIEF

> Moteur de terrain 3D basé sur les données LiDAR réelles du Service public de Wallonie.
> Phase 1 : le terrain. Rien d'autre.

---

## 1. La vision (contexte, pas scope)

Un seul projet, trois couches, construites dans cet ordre :

| Couche | Description | Statut |
|---|---|---|
| **TERRAIN** | Moteur de rendu du relief wallon réel, LiDAR 1 m, LOD quadtree, caméra libre | ← **CE DOSSIER** |
| **VOL** | Planeur : portance, traînée, thermiques. Se pose sur le terrain. | Phase 2 |
| **ROUTE** | Vélo : GPX Liège-Bastogne-Liège, watts, pente, multi temps réel. Même moteur. | Phase 3 |
| **GLOBE** | Globe 3D en écran d'accueil qui morphe vers le terrain au zoom. | Phase 4 (cerise) |

Le terrain est 70 % du travail et le socle des trois autres. **On ne code que lui.**

Toute suggestion d'ajouter un avion, un vélo, un menu, un globe, un score, un compte
utilisateur ou un multi pendant la phase 1 est hors scope. Noter dans `IDEAS.md` et continuer.

## 2. Le critère de réussite

Un seul :

> Je lance `npm run dev`, je vole en caméra libre au-dessus de Beaufays, et je reconnais
> ma vallée. Le relief est le vrai. À 60 fps.

Si c'est atteint, la phase 1 est finie. Pas de feature en plus.

## 3. La donnée

**Source** : SPW — *Relief de la Wallonie — Modèle Numérique de Terrain 1 m (MNT) 2021-2022*, issu d'une acquisition LiDAR aéroportée réalisée entre février 2021 et mars 2022.

| Propriété | Valeur |
|---|---|
| Résolution | 1 m (production dédiée, pas un downsample du 0,5 m) |
| CRS source | Lambert Belge 2008 — **EPSG:3812** |
| Réf. altimétrique | Deuxième Nivellement Général — EPSG:5710 |
| Précision altimétrique | ~0,12 m en absolu |
| Densité LiDAR | 6,8 pts/m² |
| Licence | **CC-BY 4.0** — utilisation et modification libres, citation obligatoire |
| Volume Province de Liège | 9,5 Go (zip GeoTIFF) |
| Contact données | lidar@spw.wallonie.be |

**Mention légale à afficher dans le jeu** (obligatoire, CC-BY) :

```
Relief : © Service public de Wallonie (SPW) — MNT 1m 2021-2022 — CC-BY 4.0
```

Le détail complet du pipeline (URL exactes, commandes GDAL, encodage) est dans
[`docs/DATA-PIPELINE.md`](docs/DATA-PIPELINE.md).

## 4. Décisions figées

Ces décisions sont prises. Ne pas les rediscuter sans raison mesurée.

| # | Décision | Pourquoi |
|---|---|---|
| D1 | **Vite + TypeScript + Three.js**, build statique. Pas de Next.js. | C'est un jeu, pas une app. Zéro SSR, zéro router, zéro API. |
| D2 | **CRS monde = EPSG:31370 (Lambert 72)**, reprojeté au build depuis 3812. | Les orthophotos WMS du SPW servent nativement le 31370. Reprojeter une fois au build > mille fois au runtime. |
| D3 | **Espace de rendu = CRS − origine AOI.** Coords sous ±65 km. | Précision float32 à X≈235 000 m est de ~15 mm. Recentrer descend à ~4 mm. Gratuit. |
| D4 | **Tuiles = Float32 brut (`.bin` uint16 décodé), pas Terrain-RGB PNG.** | Terrain-RGB interpolé linéairement est faux (on interpole R,G,B séparément). Le `.bin` → DataTexture Float32 filtre correctement. Voir INV-2. |
| D5 | **Exagération verticale = 1.0.** Uniform configurable, défaut 1.0. | La justesse du relief EST le projet. On triche pas. |
| D6 | **Couleur procédurale (altitude + pente) en phase 1.** Orthophoto en phase 1.5. | L'ortho ajoute 3 jours de pipeline pour zéro apprentissage. Le ciel + le brouillard font 80 % de la claque. |
| D7 | **Normales calculées en fragment shader** depuis la heightmap, pas de normal map. | 4 fetchs vs. doubler le poids des tuiles. |
| D8 | **Skirts pour les fissures**, pas de stitching de maillage. | Le stitching quadtree est un cauchemar. Les skirts marchent, coûtent 3 % de triangles. |

## 5. Jalons

Chaque jalon est **jouable seul**. Pas de jalon "infrastructure".

### M0 — « Ça monte » (jour 1)
- Repo Vite + TS + Three, scène vide, caméra orbit, un cube.
- Province de Liège téléchargée, dézippée, VRT construit.
- AOI *Beaufays 16 km* découpée et reprojetée → `data/aoi_31370.tif`.
- Un `PlaneGeometry` unique, déplacé par la tuile centrale. Une bosse grise à l'écran.
- **DoD** : le relief affiché correspond à une capture QGIS de la même bbox.

### M1 — « Putain j'ai fait ça » (jours 2-3)
- Pyramide de tuiles générée (`public/tiles/{z}/{x}/{y}.bin` + `index.json` + `grid.json`).
- Quadtree LOD avec chargement async, hystérésis, culling par tuile.
- Caméra libre (WASD + souris + shift/ctrl vitesse).
- Ciel Preetham + soleil directionnel synchronisé + **brouillard exponentiel accordé au ciel**.
- Couleur procédurale altitude + pente.
- **DoD** : 60 fps à 500 m d'altitude, vue à 30 km, zéro fissure visible, zéro hitch au chargement.

> Le brouillard n'est pas cosmétique. La perspective aérienne est **la seule** chose qui
> donne l'échelle. Sans elle, l'Ardenne ressemble à une maquette. Ne pas le reporter.

### M2 — « C'est propre » (jours 4-5)
- HUD debug : fps, alt AMSL, alt AGL, lat/lon, tuiles chargées/en vol, draw calls, triangles.
- Décodage `.bin` en Web Worker (pas de hitch main thread).
- Markers POI sur les vrais lieux : Beaufays, La Redoute, Ourthe, Signal de Botrange.
- Extension AOI → *Est 64 km* (Liège → Hautes Fagnes).
- Mention légale CC-BY affichée.
- **DoD** : je peux voler 10 minutes sans que rien ne casse ni ne pop.

### M3 — Orthophoto (optionnel, phase 1.5)
- Couche `ORTHO_LAST` WMS, mise en cache au build à 1 m/px.
- Blend ortho / procédural selon la distance.

## 6. AOI

Définies dans `tools/aoi.json`. Centre en WGS84, côté en mètres. Le build calcule tout le reste.

| Nom | Centre (lat, lon) | Côté | Usage |
|---|---|---|---|
| `home` | 50.5665, 5.6250 (Beaufays) | 16 km | M0 → M2. Couvre Liège, l'Ourthe, Esneux, La Redoute. |
| `east` | 50.5300, 5.9000 | 64 km | M2+. Liège → Hautes Fagnes → Botrange (694 m). |

Commencer par `home`. **Ne pas générer `east` avant M2** : 64 km à 1 m = 4 Go de tuiles,
tu vas passer ta journée à attendre le builder pour rien.

## 7. Budget & limites connues

| Contrainte | Valeur | Conséquence |
|---|---|---|
| AOI `home` niveau 9 complet | ~3 969 tuiles, ~520 Mo | OK en local. Trop lourd pour un déploiement statique naïf. |
| Déploiement | Vercel static a des limites de taille | Les tuiles vont sur **Supabase Storage** (bucket public + CDN), pas dans le repo. À traiter après M2, pas avant. |
| VRAM | ~128 tuiles visibles × 259² × 4 o | ~34 Mo. Confortable. |
| Draw calls | 1 par tuile, ~128 | Confortable. L'instancing est une optimisation prématurée ici. |

`public/tiles/` et `data/` sont **gitignorés**. Le repo ne contient que du code.

## 8. Ce que ce projet n'est pas

- Pas un Google Earth. Une AOI, pas la planète.
- Pas un moteur générique réutilisable. Un moteur pour la Wallonie, en dur.
- Pas multi-CRS. Lambert 72, point.
- Pas mobile-first. Desktop, WebGL2, GPU dédié assumé.
