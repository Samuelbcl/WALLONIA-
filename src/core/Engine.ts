import * as THREE from "three";

/** Renderer + scène + caméra + RAF. Rien d'autre. */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private onFrame: ((dt: number) => void) | null = null;
  private lastT = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // Sans tone mapping, le ciel Preetham crame en blanc pur (ARCHITECTURE.md § 9).
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.5;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      2,
      250_000,
    );

    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  start(onFrame: (dt: number) => void): void {
    this.onFrame = onFrame;
    this.lastT = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private frame(): void {
    const now = performance.now();
    // dt clampé : un onglet en arrière-plan ne doit pas téléporter la caméra.
    const dt = Math.min((now - this.lastT) / 1000, 0.1);
    this.lastT = now;
    this.onFrame?.(dt);
    this.renderer.render(this.scene, this.camera);
  }
}
