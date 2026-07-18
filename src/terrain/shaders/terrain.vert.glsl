uniform sampler2D uHeightmap;   // R32F, raster×raster, mètres (INV-1)
uniform float uTileMinX;        // CRS
uniform float uTileMinY;        // CRS
uniform float uTileSize;        // mètres
uniform vec2  uOrigin;          // origine de rendu (centre grille), CRS
uniform float uVerticalScale;   // 1.0 (D5)
uniform float uSkirtDepth;      // mètres
uniform vec2  uUvTransform;     // INV-3 : x=(samples-1)/raster, y=(border+0.5)/raster

attribute float aSkirt;

varying vec2  vUv;
varying vec3  vWorldPos;
varying float vAltitude;

// INV-3 : samples utiles 0..256 + 1 texel de bordure -> texel = (uv*256 + 1.5)/259.
// Les facteurs viennent d'index.json via uUvTransform, jamais en dur.
vec2 tileUvToTexel(vec2 uv) {
  return uv * uUvTransform.x + uUvTransform.y;
}

void main() {
  vec2 uv = position.xz;
  vUv = uv;

  float hRaw = texture2D(uHeightmap, tileUvToTexel(uv)).r;
  // vAltitude reste l'altitude réelle : le discard du void et les rampes de
  // couleur doivent tenir quelle que soit l'exagération (D5).
  vAltitude = hRaw;

  float h = hRaw * uVerticalScale - aSkirt * uSkirtDepth;

  float X = uTileMinX + uv.x * uTileSize;
  float Y = uTileMinY + uv.y * uTileSize;

  // INV-4 : Nord = -Z
  vec3 world = vec3(X - uOrigin.x, h, -(Y - uOrigin.y));
  vWorldPos = world;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
