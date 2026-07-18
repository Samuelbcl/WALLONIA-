import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";

/**
 * Ciel Preetham + soleil directionnel synchronisé + échantillonnage CPU du même
 * modèle pour le brouillard (ARCHITECTURE.md § 9) : uFogColor est la couleur du
 * ciel Preetham dans la direction du regard, sinon couture visible à l'horizon.
 */

// Constantes du modèle Preetham, identiques au shader de three/examples Sky.js.
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const EE = 1000.0;
const CUTOFF_ANGLE = Math.PI / 1.95;
const STEEPNESS = 1.5;
const THREE_OVER_SIXTEEN_PI = 0.05968310365946075;
const ONE_OVER_FOUR_PI = 0.07957747154594767;

export class SkySystem {
  /** Élévation du soleil au-dessus de l'horizon. Rasant (8-15°) = relief lisible. */
  elevationRad = THREE.MathUtils.degToRad(12);
  /** Azimut compas : 0 = nord, π/2 = est. Défaut : soleil bas au nord-ouest. */
  azimuthRad = THREE.MathUtils.degToRad(315);
  turbidity = 4;
  rayleigh = 2;
  mieCoefficient = 0.005;
  mieDirectionalG = 0.8;

  readonly sunDir = new THREE.Vector3();
  readonly sunLight: THREE.DirectionalLight;

  private readonly sky: Sky;

  constructor(scene: THREE.Scene) {
    this.sky = new Sky();
    this.sky.scale.setScalar(450_000);
    scene.add(this.sky);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 2);
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);
  }

  update(camera: THREE.PerspectiveCamera): void {
    // Compas -> sphérique Three : theta = π − azimut pour que 0 pointe nord (−Z, INV-4).
    const phi = Math.PI / 2 - this.elevationRad;
    const theta = Math.PI - this.azimuthRad;
    this.sunDir.setFromSphericalCoords(1, phi, theta);

    const u = this.sky.material.uniforms;
    const set = (name: string, value: number): void => {
      const uniform = u[name];
      if (uniform) uniform.value = value;
    };
    set("turbidity", this.turbidity);
    set("rayleigh", this.rayleigh);
    set("mieCoefficient", this.mieCoefficient);
    set("mieDirectionalG", this.mieDirectionalG);
    (u["sunPosition"]?.value as THREE.Vector3 | undefined)?.copy(this.sunDir);

    // Le dôme suit la caméra : à ±8 km de vol, ses parois restent hors de portée.
    this.sky.position.copy(camera.position);

    // Ombrage synchronisé avec le ciel, sinon l'œil le voit immédiatement (§ 9).
    this.sunLight.position.copy(this.sunDir).multiplyScalar(10_000).add(camera.position);
    this.sunLight.target.position.copy(camera.position);
  }

  /**
   * Couleur du ciel Preetham dans une direction (CPU, mêmes formules que le
   * shader de Sky.js, sans le disque solaire). Sortie dans l'espace pré-tone
   * mapping : le terrain applique ensuite les mêmes chunks ACES + sRGB.
   */
  sampleSkyColor(dir: THREE.Vector3, out: THREE.Color): THREE.Color {
    const sunfade = 1.0 - THREE.MathUtils.clamp(1.0 - Math.exp(this.sunDir.y / 450_000), 0, 1);
    const rayleighCoeff = this.rayleigh - (1.0 - sunfade);

    const c = 0.2 * this.turbidity * 10e-18;
    const betaR = TOTAL_RAYLEIGH.map((v) => v * rayleighCoeff) as [number, number, number];
    const betaM = MIE_CONST.map((v) => 0.434 * c * v * this.mieCoefficient) as [
      number,
      number,
      number,
    ];

    const cosZenithSun = THREE.MathUtils.clamp(this.sunDir.y, -1, 1);
    const sunE = EE * Math.max(0, 1.0 - Math.exp(-((CUTOFF_ANGLE - Math.acos(cosZenithSun)) / STEEPNESS)));

    const zenith = Math.acos(Math.max(0, dir.y));
    const inv =
      1.0 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180.0) / Math.PI, -1.253));
    const sR = RAYLEIGH_ZENITH_LENGTH * inv;
    const sM = MIE_ZENITH_LENGTH * inv;

    const fex = betaR.map((br, i) => Math.exp(-(br * sR + betaM[i]! * sM))) as [
      number,
      number,
      number,
    ];

    const cosTheta = dir.dot(this.sunDir);
    // Sky.js appelle rayleighPhase(cosTheta * 0.5 + 0.5) — écart = couture à l'horizon.
    const rTerm = cosTheta * 0.5 + 0.5;
    const rPhase = THREE_OVER_SIXTEEN_PI * (1.0 + rTerm * rTerm);
    const g = this.mieDirectionalG;
    const mPhase =
      (ONE_OVER_FOUR_PI * (1.0 - g * g)) / Math.pow(1.0 - 2.0 * g * cosTheta + g * g, 1.5);

    const upDotSun = Math.max(0, this.sunDir.y);
    const linFactor = Math.pow(1.0 - upDotSun, 5.0);

    const rgb: number[] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const beta = betaR[i]! + betaM[i]!;
      const betaTheta = betaR[i]! * rPhase + betaM[i]! * mPhase;
      let lin = Math.pow(sunE * (betaTheta / beta) * (1.0 - fex[i]!), 1.5);
      lin *= THREE.MathUtils.lerp(
        1.0,
        Math.pow(sunE * (betaTheta / beta) * fex[i]!, 0.5),
        THREE.MathUtils.clamp(linFactor, 0, 1),
      );
      const l0 = 0.1 * fex[i]!;
      const texColor = (lin + l0) * 0.04 + [0.0, 0.0003, 0.00075][i]!;
      rgb[i] = Math.pow(texColor, 1.0 / (1.2 + 1.2 * sunfade));
    }
    return out.setRGB(rgb[0]!, rgb[1]!, rgb[2]!);
  }

  /** Transmittance atmosphérique vers le soleil -> couleur de la lumière directe. */
  sunColor(out: THREE.Color): THREE.Color {
    const zenith = Math.acos(Math.max(0, THREE.MathUtils.clamp(this.sunDir.y, -1, 1)));
    const inv =
      1.0 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180.0) / Math.PI, -1.253));
    const c = 0.2 * this.turbidity * 10e-18;
    const strength = THREE.MathUtils.clamp(this.sunDir.y * 8.0, 0, 1);
    const rgb = TOTAL_RAYLEIGH.map((br, i) => {
      const bm = 0.434 * c * MIE_CONST[i]! * this.mieCoefficient;
      return Math.exp(-(br * this.rayleigh * RAYLEIGH_ZENITH_LENGTH * inv + bm * MIE_ZENITH_LENGTH * inv));
    });
    return out.setRGB(rgb[0]! * strength, rgb[1]! * strength, rgb[2]! * strength);
  }
}
