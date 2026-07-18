import * as THREE from "three";
import GUI from "lil-gui";
import Stats from "stats.js";
import { FreeCamera } from "./camera/FreeCamera";
import { Engine } from "./core/Engine";
import { Input } from "./core/Input";
import { DebugHUD } from "./debug/DebugHUD";
import { PoiMarkers } from "./debug/PoiMarkers";
import { setRenderOrigin } from "./geo/crs";
import { loadTileGrid, type TileGrid } from "./geo/grid";
import { SkySystem } from "./sky/Sky";
import { TerrainSystem, type Lighting } from "./terrain/TerrainSystem";

/** Les ids viennent d'index.html, servi avec ce bundle : absent = bug de build. */
function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`élément #${id} absent d'index.html`);
  return el;
}

const notice = byId("notice");

declare global {
  interface Window {
    /** Hook debug pour l'outillage (tools/screenshot.mjs). */
    wallonia?: {
      tilesInflight(): number;
      tilesRendered(): number;
      setView(altM: number, headingDeg: number, pitchDeg: number): void;
    };
  }
}

async function resolveGrid(): Promise<TileGrid | null> {
  const requested = new URLSearchParams(location.search).get("aoi") ?? "home";
  try {
    return await loadTileGrid(requested);
  } catch (err) {
    console.error(`AOI « ${requested} » : /tiles/${requested}/index.json illisible`, err);
    if (requested !== "synthetic") {
      try {
        const grid = await loadTileGrid("synthetic");
        notice.textContent =
          "Données SPW absentes — relief SYNTHÉTIQUE de test. " +
          "Lancer le pipeline (docs/DATA-PIPELINE.md) puis recharger.";
        return grid;
      } catch (errSynth) {
        console.error("AOI « synthetic » : /tiles/synthetic/index.json illisible", errSynth);
      }
    }
    notice.textContent =
      `Aucune tuile pour l'AOI « ${requested} ». ` +
      "Pipeline : python tools/01_prepare_aoi.py --aoi home && python tools/02_build_tiles.py --aoi home " +
      "— ou node tools/make_synthetic_tiles.mjs pour un relief de test.";
    return null;
  }
}

async function boot(): Promise<void> {
  const grid = await resolveGrid();
  if (!grid) return;

  // D3 : l'espace de rendu est recentré sur le centre de la grille racine.
  const [cx, cy] = grid.center();
  setRenderOrigin(cx, cy);

  const engine = new Engine(byId("app"));
  // INV-1 : la heightmap R32F exige cette extension pour le filtrage linéaire.
  // Universelle sur GPU desktop, mais si elle manque le terrain serait plat en silence.
  if (!engine.renderer.extensions.has("OES_texture_float_linear")) {
    notice.textContent = "GPU sans OES_texture_float_linear : filtrage du terrain dégradé.";
    console.error("OES_texture_float_linear absent (INV-1) : LinearFilter sur R32F indisponible.");
  }
  const input = new Input(engine.renderer.domElement);
  const freeCam = new FreeCamera(engine.camera, input);
  const sky = new SkySystem(engine.scene);
  const terrain = new TerrainSystem(grid, engine.scene);
  const hud = new DebugHUD(
    byId("hud"),
    engine.renderer,
    engine.camera,
    terrain,
    freeCam,
    grid.aoi,
  );
  const poi = new PoiMarkers(byId("poi"));

  // Départ : au-dessus du centre AOI, cap nord-ouest vers la vallée.
  // Overrides debug par URL : ?alt= (m AMSL), ?heading= et ?pitch= (degrés).
  const q = new URLSearchParams(location.search);
  const rootMax = grid.record(0, 0, 0)?.maxZ ?? 400;
  engine.camera.position.set(0, Number(q.get("alt")) || rootMax + 500, 0);
  freeCam.headingRad = THREE.MathUtils.degToRad(Number(q.get("heading")) || 315);
  freeCam.pitchRad = THREE.MathUtils.degToRad(
    q.has("pitch") ? Number(q.get("pitch")) : -20,
  );

  const stats = new Stats();
  stats.showPanel(0);
  document.body.appendChild(stats.dom);
  stats.dom.style.left = "auto";
  stats.dom.style.right = "8px";

  const lighting: Lighting = {
    sunDir: new THREE.Vector3(),
    sunColor: new THREE.Color(),
    skyColor: new THREE.Color(),
    fogColor: new THREE.Color(),
    fogDensity: 2.5e-5,
  };
  const gui = new GUI({ title: "debug" });
  const sun = gui.addFolder("soleil");
  const sunParams = { elevation: 12, azimuth: 315 };
  sun.add(sunParams, "elevation", 1, 90, 0.5);
  sun.add(sunParams, "azimuth", 0, 360, 1);
  gui.add(sky, "turbidity", 1, 20, 0.1);
  gui.add(lighting, "fogDensity", 0, 2e-4, 1e-6);
  gui.add(terrain, "verticalScale", 0.5, 3, 0.05).name("exagération (D5=1)");
  gui.close();

  window.wallonia = {
    tilesInflight: () => terrain.tilesInflight,
    tilesRendered: () => terrain.tilesRendered,
    setView: (altM, headingDeg, pitchDeg) => {
      engine.camera.position.y = altM;
      freeCam.headingRad = THREE.MathUtils.degToRad(headingDeg);
      freeCam.pitchRad = THREE.MathUtils.degToRad(pitchDeg);
    },
  };

  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  engine.start((dt) => {
    freeCam.update(dt);
    sky.elevationRad = THREE.MathUtils.degToRad(sunParams.elevation);
    sky.azimuthRad = THREE.MathUtils.degToRad(sunParams.azimuth);
    sky.update(engine.camera);

    lighting.sunDir.copy(sky.sunDir);
    sky.sunColor(lighting.sunColor).multiplyScalar(2.5);
    sky.sampleSkyColor(up, lighting.skyColor);
    // uFogColor = ciel Preetham dans la direction du regard (§ 5), à l'horizon.
    engine.camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() > 1e-6) {
      fwd.normalize();
      fwd.y = 0.01;
      sky.sampleSkyColor(fwd.normalize(), lighting.fogColor);
    }

    terrain.update(engine.camera, lighting);
    hud.update();
    poi.update(engine.camera, terrain);
    stats.update();
  });
}

void boot();
