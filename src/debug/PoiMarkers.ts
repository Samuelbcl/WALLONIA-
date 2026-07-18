import * as THREE from "three";
import { crsToRender, wgs84ToCrs } from "../geo/crs";
import type { TerrainSystem } from "../terrain/TerrainSystem";

/** Vrais lieux (contenu, pas constantes de grille — la grille vient de grid.json). */
const POIS: { name: string; lat: number; lon: number }[] = [
  { name: "Beaufays", lat: 50.5665, lon: 5.625 },
  { name: "La Redoute", lat: 50.4797, lon: 5.7079 },
  { name: "Ourthe — Esneux", lat: 50.5353, lon: 5.5675 },
  { name: "Liège", lat: 50.6326, lon: 5.5797 },
  { name: "Signal de Botrange", lat: 50.5017, lon: 6.0925 },
];

const LABEL_HEIGHT_M = 40;
const MAX_VISIBLE_M = 25_000;

interface Marker {
  el: HTMLDivElement;
  crsX: number;
  crsY: number;
  world: THREE.Vector3;
}

/** Markers DOM projetés à la main — pas de renderer CSS2D, pas de dépendance. */
export class PoiMarkers {
  private readonly markers: Marker[] = [];
  private readonly ndc = new THREE.Vector3();
  private readonly viewSpace = new THREE.Vector3();

  constructor(container: HTMLElement) {
    for (const poi of POIS) {
      const el = document.createElement("div");
      el.className = "marker";
      el.textContent = poi.name;
      el.style.display = "none";
      container.appendChild(el);
      const [crsX, crsY] = wgs84ToCrs(poi.lon, poi.lat);
      this.markers.push({ el, crsX, crsY, world: new THREE.Vector3() });
    }
  }

  update(camera: THREE.PerspectiveCamera, terrain: TerrainSystem): void {
    for (const m of this.markers) {
      const h = terrain.getHeightAt(m.crsX, m.crsY);
      if (h === null) {
        m.el.style.display = "none";
        continue;
      }
      const [rx, rz] = crsToRender(m.crsX, m.crsY);
      m.world.set(rx, h + LABEL_HEIGHT_M, rz);

      this.viewSpace.copy(m.world).applyMatrix4(camera.matrixWorldInverse);
      const dist = m.world.distanceTo(camera.position);
      if (this.viewSpace.z >= 0 || dist > MAX_VISIBLE_M) {
        m.el.style.display = "none";
        continue;
      }
      this.ndc.copy(m.world).project(camera);
      if (Math.abs(this.ndc.x) > 1.05 || Math.abs(this.ndc.y) > 1.05) {
        m.el.style.display = "none";
        continue;
      }
      m.el.style.display = "block";
      m.el.style.left = `${((this.ndc.x + 1) / 2) * window.innerWidth}px`;
      m.el.style.top = `${((1 - this.ndc.y) / 2) * window.innerHeight}px`;
      m.el.style.opacity = `${THREE.MathUtils.clamp(1.5 - dist / MAX_VISIBLE_M, 0, 1)}`;
    }
  }
}
