import * as THREE from "three";

/**
 * LA géométrie, unique et partagée par toutes les tuiles (ARCHITECTURE.md § 3).
 * Grille normalisée [0,1]² : position = vec3(u, 0, v), la position monde est
 * entièrement calculée dans le vertex shader. `aSkirt` = 1 sur l'anneau de jupe.
 */

const QUADS = 128; // résolution géométrique par tuile — choix moteur, pas une constante géo
const N = QUADS + 1; // 129 vertices par côté

export function buildTileGeometry(): THREE.BufferGeometry {
  const surfaceCount = N * N;
  const skirtCount = 4 * N;
  const positions = new Float32Array((surfaceCount + skirtCount) * 3);
  const skirt = new Float32Array(surfaceCount + skirtCount);
  // 17 157 vertices < 65 536 : l'index tient en Uint16.
  const indices = new Uint16Array((QUADS * QUADS * 2 + 4 * QUADS * 2) * 3);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      positions[i * 3 + 0] = x / QUADS;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = y / QUADS;
    }
  }

  // INV-4 : le rendu applique Z = −v, ce qui inverse la chiralité. L'ordre
  // [a, b, d] / [a, d, c] ci-dessous est CCW vu de dessus APRÈS ce flip.
  let ptr = 0;
  for (let y = 0; y < QUADS; y++) {
    for (let x = 0; x < QUADS; x++) {
      const a = y * N + x;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      indices[ptr++] = a;
      indices[ptr++] = b;
      indices[ptr++] = d;
      indices[ptr++] = a;
      indices[ptr++] = d;
      indices[ptr++] = c;
    }
  }

  // Jupes (D8) : chaque vertex de bord dupliqué avec aSkirt = 1, poussé vers le
  // bas dans le vertex shader. Bouche les fissures entre niveaux différents.
  let skirtBase = surfaceCount;
  const addSkirtRing = (
    surfaceIndex: (k: number) => number,
    flipWinding: boolean,
  ): void => {
    const base = skirtBase;
    for (let k = 0; k < N; k++) {
      const s = surfaceIndex(k);
      const j = base + k;
      positions[j * 3 + 0] = positions[s * 3 + 0] ?? 0;
      positions[j * 3 + 1] = 0;
      positions[j * 3 + 2] = positions[s * 3 + 2] ?? 0;
      skirt[j] = 1;
    }
    for (let k = 0; k < QUADS; k++) {
      const s0 = surfaceIndex(k);
      const s1 = surfaceIndex(k + 1);
      const k0 = base + k;
      const k1 = base + k + 1;
      if (flipWinding) {
        indices[ptr++] = s0;
        indices[ptr++] = s1;
        indices[ptr++] = k0;
        indices[ptr++] = s1;
        indices[ptr++] = k1;
        indices[ptr++] = k0;
      } else {
        indices[ptr++] = s0;
        indices[ptr++] = k0;
        indices[ptr++] = s1;
        indices[ptr++] = s1;
        indices[ptr++] = k0;
        indices[ptr++] = k1;
      }
    }
    skirtBase += N;
  };

  // Orientations dérivées du mapping (u,v) -> (u, h, −v), faces vers l'extérieur :
  addSkirtRing((k) => k, false); // sud  (v=0) -> +Z
  addSkirtRing((k) => QUADS * N + k, true); // nord (v=1) -> −Z
  addSkirtRing((k) => k * N, true); // ouest (u=0) -> −X
  addSkirtRing((k) => k * N + QUADS, false); // est  (u=1) -> +X

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("aSkirt", new THREE.BufferAttribute(skirt, 1));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  // Bounds fictives : le culling est manuel par tuile (ARCHITECTURE.md § 6),
  // les meshes ont frustumCulled = false.
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0, 0.5), 1);
  return geom;
}
