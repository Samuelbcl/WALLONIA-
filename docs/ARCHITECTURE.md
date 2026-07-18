# ARCHITECTURE

Moteur de rendu. Three.js, WebGL2, quadtree chunké, déplacement en vertex shader.

---

## 1. Arborescence

```
wallonia/
├── CLAUDE.md
├── BRIEF.md
├── IDEAS.md                    # tout ce qui est hors scope phase 1
├── docs/
│   ├── ARCHITECTURE.md
│   └── DATA-PIPELINE.md
├── tools/                      # Python, build-time only
│   ├── requirements.txt
│   ├── aoi.json
│   ├── 01_prepare_aoi.py
│   └── 02_build_tiles.py
├── data/                       # gitignore — GeoTIFF bruts et warpés
├── public/tiles/               # gitignore — sortie du builder
├── index.html
└── src/
    ├── main.ts                 # bootstrap, boucle
    ├── core/
    │   ├── Engine.ts           # renderer, scene, resize, RAF
    │   └── Input.ts            # clavier/souris -> état
    ├── geo/
    │   ├── crs.ts              # 31370 <-> WGS84, CRS <-> espace de rendu
    │   └── grid.ts             # math de tuiles, chargement grid.json/index.json
    ├── terrain/
    │   ├── TerrainSystem.ts    # orchestre : update quadtree, cull, draw
    │   ├── Quadtree.ts         # split/merge, hystérésis
    │   ├── TileNode.ts         # un noeud : état, mesh, bounds
    │   ├── TileLoader.ts       # fetch + worker + cache LRU
    │   ├── decode.worker.ts    # uint16 -> Float32Array
    │   ├── TileGeometry.ts     # la géométrie partagée (surface + skirt)
    │   └── shaders/
    │       ├── terrain.vert.glsl
    │       └── terrain.frag.glsl
    ├── sky/Sky.ts              # ciel Preetham + soleil + fog accordé
    ├── camera/FreeCamera.ts
    └── debug/DebugHUD.ts
```

## 2. Espaces de coordonnées

Trois espaces. Ne jamais les mélanger. Les conversions vivent **uniquement** dans `geo/crs.ts`.

| Espace | Unité | Description |
|---|---|---|
| **WGS84** | degrés | lat/lon. Uniquement pour l'affichage HUD et la config AOI. |
| **CRS** | mètres | EPSG:31370. La donnée, la grille, les POI. X≈235 000, Y≈145 000 autour de Liège. |
| **Rendu** | mètres | Three.js, Y-up. `= CRS − origine AOI`, avec **Nord = −Z**. |

```ts
// geo/crs.ts
export function crsToRender(x: number, y: number): [number, number] {
  return [x - origin.x, -(y - origin.y)];   // INV-4
}
export function renderToCrs(rx: number, rz: number): [number, number] {
  return [rx + origin.x, -rz + origin.y];
}
```

**Pourquoi recentrer (D3).** Un float32 à X = 235 000 a un pas de ~15 mm. Ça passerait, mais
recentrer à ±8 km descend le pas à ~1 mm pour zéro coût. Gratuit, fais-le.

**Pourquoi Nord = −Z (INV-4).** En 31370, Y croît vers le nord. Three est Y-up, main droite :
si X = est et Y = haut, alors +Z pointe vers le sud. Ce flip **inverse la chiralité** → le
winding des triangles doit être inversé dans l'index buffer de `TileGeometry`.

> Si le terrain est invisible ou noir : winding. Si l'Ourthe coule à l'envers : tu as oublié
> le signe. Ces deux bugs sont le même bug.

## 3. Géométrie — une seule, partagée

**Un unique `BufferGeometry`, réutilisé par toutes les tuiles.** Elle ne contient aucune
donnée de position réelle : juste une grille normalisée `[0,1]²`. La position monde est
calculée intégralement dans le vertex shader depuis `uTileMinX/uTileMinY/uTileSize`.

```
Surface :  129 × 129 vertices  (128 × 128 quads)
Skirt   :  4 × 129 vertices  (un anneau, un par vertex de bord)
Total   :  ~17 157 vertices, ~101 376 indices
```

Attributs :
- `position` : `vec3(u, 0, v)`, `u,v ∈ [0,1]`. Sert aussi d'UV.
- `aSkirt` : `float`, 0 = surface, 1 = jupe.

**Résolution géométrique** : 128 quads sur une tuile de niveau 9 (256 m) = **2 m entre
vertices**. La heightmap est à 1 m. On perd donc du détail géométrique — c'est **volontaire** :
le détail 1 m revient intégralement par les **normales** calculées en fragment shader
(§ 5), qui échantillonnent la heightmap à sa résolution native. C'est ce que font tous les
moteurs de terrain sérieux : la silhouette est basse résolution, l'ombrage est haute
résolution, et l'œil ne voit que l'ombrage.

Budget : ~128 tuiles visibles × 17 k = **~2,2 M vertices**. Confortable en WebGL2.

**Skirts (INV-4/D8).** Chaque vertex de bord est dupliqué avec `aSkirt = 1` et poussé de
`uSkirtDepth` (60 m) vers le bas. Quand deux tuiles de niveaux différents se touchent, la
jupe bouche le trou. Coût : 3 % de triangles. L'alternative — stitcher les maillages — est
un cauchemar combinatoire pour un gain nul.

## 4. Vertex shader

```glsl
// terrain.vert.glsl
uniform sampler2D uHeightmap;   // R32F, 259x259, mètres
uniform float uTileMinX;        // CRS
uniform float uTileMinY;        // CRS
uniform float uTileSize;        // mètres
uniform vec2  uOrigin;          // origine AOI, CRS
uniform float uVerticalScale;   // 1.0 (D5)
uniform float uSkirtDepth;      // 60.0

attribute float aSkirt;

varying vec2  vUv;
varying vec3  vWorldPos;
varying float vAltitude;

// INV-3 : 257 samples utiles (0..256) + 1 texel de bordure de chaque côté = 259.
// uv=0 -> sample 0 -> texel 1 -> centre (1+0.5)/259
// uv=1 -> sample 256 -> texel 257 -> centre (257+0.5)/259
vec2 tileUvToTexel(vec2 uv) {
  return (uv * 256.0 + 1.5) / 259.0;
}

void main() {
  vec2 uv = position.xz;
  vUv = uv;

  float h = texture2D(uHeightmap, tileUvToTexel(uv)).r * uVerticalScale;
  vAltitude = h;

  h -= aSkirt * uSkirtDepth;

  float X = uTileMinX + uv.x * uTileSize;
  float Y = uTileMinY + uv.y * uTileSize;

  // INV-4 : Nord = -Z
  vec3 world = vec3(X - uOrigin.x, h, -(Y - uOrigin.y));
  vWorldPos = world;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
```

Le vertex texture fetch est garanti en WebGL2 (`MAX_VERTEX_TEXTURE_IMAGE_UNITS ≥ 16`).
Pas de fallback à prévoir.

## 5. Fragment shader — normales et couleur

```glsl
// terrain.frag.glsl
uniform sampler2D uHeightmap;
uniform float uTileSize;
uniform float uVerticalScale;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uFogColor;
uniform float uFogDensity;

varying vec2  vUv;
varying vec3  vWorldPos;
varying float vAltitude;

vec2 tileUvToTexel(vec2 uv) { return (uv * 256.0 + 1.5) / 259.0; }

float sampleH(vec2 uv) {
  return texture2D(uHeightmap, tileUvToTexel(uv)).r * uVerticalScale;
}

void main() {
  // res = distance monde entre deux samples de la heightmap
  float res = uTileSize / 256.0;
  // un pas de 1/256 en uv = exactement un texel = res mètres
  float d = 1.0 / 256.0;

  float hL = sampleH(vUv - vec2(d, 0.0));
  float hR = sampleH(vUv + vec2(d, 0.0));
  float hS = sampleH(vUv - vec2(0.0, d));
  float hN = sampleH(vUv + vec2(0.0, d));

  // dérivées centrées sur 2 texels ; Nord = -Z (INV-4) d'où le signe sur la composante Z
  vec3 n = normalize(vec3(hL - hR, 2.0 * res, hN - hS));

  float slope = 1.0 - n.y;                      // 0 = plat, 1 = mur
  float ndl   = max(dot(n, normalize(uSunDir)), 0.0);

  // --- Couleur procédurale (D6, temporaire jusqu'à l'ortho) ---
  vec3 lowland  = vec3(0.34, 0.42, 0.24);       // prairies mosanes
  vec3 upland   = vec3(0.26, 0.33, 0.21);       // forêt ardennaise
  vec3 rock     = vec3(0.44, 0.42, 0.39);       // schiste
  vec3 albedo   = mix(lowland, upland, smoothstep(180.0, 450.0, vAltitude));
  albedo        = mix(albedo, rock, smoothstep(0.35, 0.62, slope));

  // --- Éclairage ---
  vec3 direct   = uSunColor * ndl;
  vec3 ambient  = uSkyColor * (0.35 + 0.65 * n.y);   // ciel plus fort sur les faces plates
  vec3 color    = albedo * (direct + ambient);

  // --- Perspective aérienne : LA chose qui donne l'échelle ---
  float dist    = length(vWorldPos - cameraPosition);
  float fog     = 1.0 - exp(-uFogDensity * dist);
  color         = mix(color, uFogColor, fog);

  gl_FragColor = vec4(color, 1.0);
}
```

**Le brouillard n'est pas une option.** Sans perspective aérienne, un terrain à l'échelle 1:1
ressemble à une maquette en plastique. `uFogDensity` de départ : `2.5e-5` (visibilité utile
~40 km). `uFogColor` doit être **échantillonné sur le ciel Preetham dans la direction du
regard**, pas une constante grise — sinon l'horizon a une couture visible.

## 6. Quadtree

### Critère de subdivision

Distance caméra → centre de la tuile, rapportée à sa taille :

```ts
const dist = camera.position.distanceTo(node.boundsCenter);
const ratio = dist / node.size;

if (ratio < SPLIT_RATIO && node.level < maxLevel) → split
if (ratio > MERGE_RATIO)                          → merge

SPLIT_RATIO = 2.0
MERGE_RATIO = 2.5     // INV-6 : hystérésis, ratio 1.25
```

Sans hystérésis, une tuile pile à la limite split/merge oscille à chaque frame et tu passes
ton temps à charger/décharger. Le ratio 1.25 est un point de départ, à ajuster au feeling.

### Règles

- **INV-6** : `split` uniquement si les **4 enfants sont chargés**. Sinon on garde le parent
  affiché et on lance les fetchs. C'est ce qui évite les trous béants pendant le vol.
- `merge` : libère les enfants, remet le parent. Le cache LRU garde les tuiles ~30 s : un
  aller-retour ne re-fetche rien.
- Un 404 sur une tuile = « pas de donnée ici » → le nœud est marqué stérile, on ne subdivise
  plus, on ne re-fetche jamais.

### Culling

AABB par tuile en espace de rendu : `[minX, minZ] × [minZ_h, maxZ_h] × [minY, maxY]`,
où les hauteurs viennent de `index.json` (§ 5 de DATA-PIPELINE). Frustum test manuel sur le
nœud. Les meshes ont `frustumCulled = false` — on cull nous-mêmes, Three ne connaît pas nos
bounds réelles (la géométrie est normalisée).

## 7. Chargement

```
TileLoader.request(z, x, y)
  → fetch(`${baseUrl}/${z}/${x}/${y}.bin`)      # AbortController si le nœud merge entre-temps
  → ArrayBuffer -> decode.worker.ts             # Uint16Array -> Float32Array (h = u*0.02 - 100)
  → transferable postMessage (zéro copie)
  → new THREE.DataTexture(f32, 259, 259, THREE.RedFormat, THREE.FloatType)
       texture.colorSpace   = THREE.NoColorSpace     // INV-1 !!
       texture.minFilter    = THREE.LinearFilter
       texture.magFilter    = THREE.LinearFilter
       texture.wrapS/wrapT  = THREE.ClampToEdgeWrapping
       texture.generateMipmaps = false
       texture.needsUpdate  = true
```

**INV-1, le bug qui coûte une journée.** Si `colorSpace` reste au défaut, Three applique une
conversion sRGB → tes altitudes sont écrasées par une courbe de gamma. Le terrain a l'air
« presque bon », juste bizarrement bosselé. Tu vas chercher pendant des heures dans le
quadtree. C'est là. `NoColorSpace`.

**Concurrence** : max 6 fetchs simultanés (limite HTTP/1.1 par host ; en HTTP/2 sur Vercel
c'est plus, mais 6 suffit et évite de noyer le worker). File priorisée par distance caméra.

**Cache LRU** : ~256 tuiles. `dispose()` la `DataTexture` à l'éviction, sinon fuite VRAM.

## 8. Matériau — un clone par tuile (INV-7)

```ts
const mat = baseTerrainMaterial.clone();
mat.uniforms.uHeightmap.value = tile.texture;
mat.uniforms.uTileMinX.value  = tile.minX;
// ...
```

Three met en cache le **programme GPU par source de shader** : 128 clones = 1 seule
compilation. Le clone ne coûte que l'objet uniforms JS.

Ne **pas** essayer de partager un matériau unique en réassignant les uniforms dans
`onBeforeRender` : Three n'upload pas les uniforms par objet de façon fiable dans ce cas, et
toutes tes tuiles finiront par afficher la même heightmap. Clone. C'est le chemin sûr.

## 9. Ciel et soleil

- `three/examples/jsm/objects/Sky.js` — Preetham. `turbidity ≈ 4`, `rayleigh ≈ 2`,
  `mieCoefficient ≈ 0.005`, `mieDirectionalG ≈ 0.8`.
- `DirectionalLight` dont la position **suit exactement** le vecteur soleil du ciel.
  Désynchronisés, ton ombrage contredit ton ciel et l'œil le voit immédiatement.
- Soleil rasant (élévation 8-15°) : c'est là que le relief LiDAR est le plus lisible.
  Angle par défaut → soleil bas au nord-ouest. Slider `lil-gui` pour azimut/élévation.
- `renderer.toneMapping = THREE.ACESFilmicToneMapping`, `toneMappingExposure ≈ 0.5`.
  Sans tone mapping, le Preetham crame en blanc pur.
- `uFogColor` échantillonné sur le ciel dans la direction du regard, pas constant.

## 10. Budget perf

| Métrique | Cible | Mesure |
|---|---|---|
| FPS @ 500 m, vue 30 km | 60 | `stats.js` |
| Draw calls | < 200 | `renderer.info.render.calls` |
| Triangles | < 2,5 M | `renderer.info.render.triangles` |
| VRAM textures | < 60 Mo | `renderer.info.memory.textures` × 259²×4 o |
| Hitch au chargement | 0 frame > 20 ms | Performance panel |

Si le budget explose, dans cet ordre : baisser `maxLevel` → baisser `SPLIT_RATIO` →
descendre la géométrie à 65×65. **Jamais** réduire la résolution de la heightmap : c'est
elle qui porte tout le détail visible via les normales.

## 11. Ordre d'implémentation

Chaque étape se voit à l'écran. Pas d'étape « architecture ».

1. `Engine` + `FreeCamera` + un cube. Ça tourne.
2. `crs.ts` + `grid.ts`, chargement `grid.json`/`index.json`. Log la bbox, vérifie-la sur WalOnMap.
3. `TileGeometry` — une seule tuile, hardcodée, celle du centre. **Une bosse à l'écran (M0).**
4. `TileLoader` + worker. La bosse devient la vraie topo de Beaufays.
5. `Quadtree` sans LOD : tout au niveau 6. Une nappe complète.
6. LOD + hystérésis + skirts. **Ça vole (M1).**
7. `Sky` + fog. **Ça claque (M1).**
8. `DebugHUD`, POI, LRU, polish (M2).
