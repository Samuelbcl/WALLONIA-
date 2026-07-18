/** Clavier/souris -> état interrogeable. Pointer lock sur clic canvas. */
export class Input {
  private keys = new Set<string>();
  private dx = 0;
  private dy = 0;
  private wheelSteps = 0;
  private locked = false;

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());

    canvas.addEventListener("click", () => {
      if (!this.locked) void canvas.requestPointerLock();
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    window.addEventListener("wheel", (e) => {
      this.wheelSteps += Math.sign(e.deltaY);
    });
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Axe -1/0/+1 entre deux touches. */
  axis(neg: string, pos: string): number {
    return (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0);
  }

  /** Delta souris accumulé depuis le dernier appel, puis remis à zéro. */
  consumeMouse(): [number, number] {
    const d: [number, number] = [this.dx, this.dy];
    this.dx = 0;
    this.dy = 0;
    return d;
  }

  /** Crans de molette accumulés (+1 = vers l'utilisateur). */
  consumeWheel(): number {
    const w = this.wheelSteps;
    this.wheelSteps = 0;
    return w;
  }

  get pointerLocked(): boolean {
    return this.locked;
  }
}
