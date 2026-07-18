import * as THREE from "three";
import type { Input } from "../core/Input";

const MOUSE_SENSITIVITY = 0.0022; // rad par pixel
const PITCH_LIMIT_RAD = Math.PI / 2 - 0.01;

/**
 * Caméra libre : WASD/ZQSD + souris (pointer lock), Espace/C monte/descend,
 * Shift ×8, Ctrl ÷6, molette ajuste la vitesse de base.
 */
export class FreeCamera {
  /** Cap compas : 0 = nord (−Z, INV-4), positif vers l'est. */
  headingRad = 0;
  pitchRad = -0.25;
  baseSpeedMps = 80;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly input: Input;
  private readonly move = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, input: Input) {
    this.camera = camera;
    this.input = input;
  }

  update(dt: number): void {
    const [mx, my] = this.input.consumeMouse();
    this.headingRad += mx * MOUSE_SENSITIVITY;
    this.pitchRad = THREE.MathUtils.clamp(
      this.pitchRad - my * MOUSE_SENSITIVITY,
      -PITCH_LIMIT_RAD,
      PITCH_LIMIT_RAD,
    );

    const wheel = this.input.consumeWheel();
    if (wheel !== 0) {
      this.baseSpeedMps = THREE.MathUtils.clamp(
        this.baseSpeedMps * Math.pow(1.25, -wheel),
        2,
        2000,
      );
    }

    // Ordre YXZ : cap autour de Y monde, puis assiette. Nord = −Z, donc cap 0
    // regarde vers −Z et le cap croît vers l'est (+X) : rotation −heading.
    this.camera.quaternion.setFromEuler(
      new THREE.Euler(this.pitchRad, -this.headingRad, 0, "YXZ"),
    );

    let speed = this.baseSpeedMps;
    if (this.input.isDown("ShiftLeft") || this.input.isDown("ShiftRight")) speed *= 8;
    if (this.input.isDown("ControlLeft") || this.input.isDown("ControlRight")) speed /= 6;

    // e.code est positionnel : ZQSD sur AZERTY émet déjà KeyW/KeyA/KeyS/KeyD.
    const fwd = this.input.axis("KeyS", "KeyW");
    const strafe = this.input.axis("KeyA", "KeyD");
    const lift = this.input.axis("KeyC", "Space");

    this.move.set(strafe, 0, -fwd).normalize().multiplyScalar(speed * dt);
    this.move.applyQuaternion(this.camera.quaternion);
    this.move.y += lift * speed * dt;
    this.camera.position.add(this.move);
  }
}
