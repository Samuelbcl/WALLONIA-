import type * as THREE from "three";
import { crsToWgs84, renderToCrs } from "../geo/crs";
import type { FreeCamera } from "../camera/FreeCamera";
import type { TerrainSystem } from "../terrain/TerrainSystem";

const REFRESH_MS = 250;

/** HUD debug en DOM natif : fps, position, altitudes, tuiles, draw calls. */
export class DebugHUD {
  private readonly el: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly terrain: TerrainSystem;
  private readonly freeCam: FreeCamera;
  private readonly aoi: string;
  private frames = 0;
  private lastReport = performance.now();

  constructor(
    el: HTMLElement,
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    terrain: TerrainSystem,
    freeCam: FreeCamera,
    aoi: string,
  ) {
    this.el = el;
    this.renderer = renderer;
    this.camera = camera;
    this.terrain = terrain;
    this.freeCam = freeCam;
    this.aoi = aoi;
  }

  update(): void {
    this.frames++;
    const now = performance.now();
    const elapsed = now - this.lastReport;
    if (elapsed < REFRESH_MS) return;
    const fps = (this.frames * 1000) / elapsed;
    this.frames = 0;
    this.lastReport = now;

    const p = this.camera.position;
    const [crsX, crsY] = renderToCrs(p.x, p.z);
    const [lon, lat] = crsToWgs84(crsX, crsY);
    const ground = this.terrain.getHeightAt(crsX, crsY);
    const agl = ground === null ? "—" : `${(p.y - ground).toFixed(0)} m`;
    const info = this.renderer.info.render;

    this.el.textContent = [
      `WALLONIA — aoi ${this.aoi}`,
      `${fps.toFixed(0)} fps | ${info.calls} draws | ${(info.triangles / 1e6).toFixed(2)} Mtris`,
      `lat ${lat.toFixed(5)}  lon ${lon.toFixed(5)}`,
      `alt ${p.y.toFixed(0)} m AMSL | ${agl} AGL | ${this.freeCam.baseSpeedMps.toFixed(0)} m/s`,
      `tuiles ${this.terrain.tilesRendered} affichées / ${this.terrain.tilesLoaded} en cache / ${this.terrain.tilesInflight} en vol`,
      `clic = souris | WASD/ZQSD | Espace/C | Shift/Ctrl | molette = vitesse`,
    ].join("\n");
  }
}
