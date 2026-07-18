uniform sampler2D uHeightmap;
uniform float uTileSize;
uniform float uVerticalScale;
uniform vec2  uUvTransform;     // INV-3 (voir terrain.vert.glsl)
uniform float uSampleUv;        // 1/(samples-1) : un sample de heightmap en unités uv
uniform float uVoidBelow;       // altitude sous laquelle la donnée est du NoData encodé
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uFogColor;
uniform float uFogDensity;

varying vec2  vUv;
varying vec3  vWorldPos;
varying float vAltitude;

vec2 tileUvToTexel(vec2 uv) {
  return uv * uUvTransform.x + uUvTransform.y;
}

float sampleH(vec2 uv) {
  return texture2D(uHeightmap, tileUvToTexel(uv)).r * uVerticalScale;
}

void main() {
  // u16 == 0 -> hors AOI (builder). Le filtrage bilinéaire adoucit la frontière,
  // le seuil est donc légèrement au-dessus de l'offset d'encodage.
  if (vAltitude < uVoidBelow) discard;

  // res = distance monde entre deux samples de la heightmap
  float res = uTileSize * uSampleUv;
  float d = uSampleUv;

  float hL = sampleH(vUv - vec2(d, 0.0));
  float hR = sampleH(vUv + vec2(d, 0.0));
  float hS = sampleH(vUv - vec2(0.0, d));
  float hN = sampleH(vUv + vec2(0.0, d));

  // dérivées centrées sur 2 texels ; Nord = -Z (INV-4) d'où le signe en Z
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

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
