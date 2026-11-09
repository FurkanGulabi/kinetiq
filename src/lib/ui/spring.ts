/**
 * Minimal 1D spring + momentum helpers for draggable widgets (apple-design §3–6).
 *
 * Parameters follow Apple's designer-friendly pair instead of mass/stiffness/damping:
 *   - dampingRatio: 1 = critically damped (no overshoot), < 1 bounces
 *   - response: seconds to (roughly) reach the target; not a fixed duration
 * Springs start from the current on-screen value and velocity, so a new target mid-flight
 * re-targets smoothly instead of restarting (interruptible). X and Y run as independent springs.
 */

export interface SpringConfig {
  dampingRatio: number;
  response: number;
}

/** Default reposition spring (PiP-like): no overshoot. */
export const SPRING_MOVE: SpringConfig = { dampingRatio: 1, response: 0.4 };
/** After a flick: a touch of bounce, because the gesture carried momentum. */
export const SPRING_THROW: SpringConfig = { dampingRatio: 0.86, response: 0.42 };

export interface Spring2D {
  /** Animate to (x, y), starting from the current value and the given velocity (px/s). */
  to(x: number, y: number, config: SpringConfig, velocity?: { x: number; y: number }): void;
  /** Jump without animation (cancels any running motion). */
  set(x: number, y: number): void;
  stop(): void;
  readonly x: number;
  readonly y: number;
  readonly moving: boolean;
}

interface Axis {
  value: number;
  velocity: number;
  target: number;
}

function stepAxis(a: Axis, cfg: SpringConfig, dt: number): void {
  const omega = (2 * Math.PI) / Math.max(cfg.response, 0.01);
  const k = omega * omega;
  const c = 2 * cfg.dampingRatio * omega;
  // Semi-implicit Euler is stable at these step sizes (dt ≤ 1/120 s per sub-step).
  const force = -k * (a.value - a.target) - c * a.velocity;
  a.velocity += force * dt;
  a.value += a.velocity * dt;
}

const settled = (a: Axis) => Math.abs(a.value - a.target) < 0.25 && Math.abs(a.velocity) < 8;

export function createSpring2D(
  x: number,
  y: number,
  onUpdate: (x: number, y: number) => void,
  onRest?: (x: number, y: number) => void,
): Spring2D {
  const ax: Axis = { value: x, velocity: 0, target: x };
  const ay: Axis = { value: y, velocity: 0, target: y };
  let config: SpringConfig = SPRING_MOVE;
  let frame = 0;
  let last = 0;

  const tick = (time: number) => {
    const elapsed = last ? Math.min((time - last) / 1000, 1 / 20) : 1 / 60;
    last = time;
    const steps = Math.max(1, Math.ceil(elapsed * 120));
    const dt = elapsed / steps;
    for (let i = 0; i < steps; i++) {
      stepAxis(ax, config, dt);
      stepAxis(ay, config, dt);
    }
    if (settled(ax) && settled(ay)) {
      ax.value = ax.target;
      ay.value = ay.target;
      ax.velocity = ay.velocity = 0;
      frame = 0;
      last = 0;
      onUpdate(ax.value, ay.value);
      onRest?.(ax.value, ay.value);
      return;
    }
    onUpdate(ax.value, ay.value);
    frame = requestAnimationFrame(tick);
  };

  return {
    to(tx, ty, cfg, velocity) {
      config = cfg;
      ax.target = tx;
      ay.target = ty;
      if (velocity) {
        ax.velocity = velocity.x;
        ay.velocity = velocity.y;
      }
      if (!frame) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    },
    set(nx, ny) {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      ax.value = ax.target = nx;
      ay.value = ay.target = ny;
      ax.velocity = ay.velocity = 0;
      onUpdate(nx, ny);
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      ax.target = ax.value;
      ay.target = ay.value;
      ax.velocity = ay.velocity = 0;
    },
    get x() {
      return ax.value;
    },
    get y() {
      return ay.value;
    },
    get moving() {
      return frame !== 0;
    },
  };
}

/**
 * Where a flick comes to rest (Apple's projection, from "Designing Fluid Interfaces").
 * decelerationRate 0.99 is a snappier, shorter throw than scroll (0.998): widgets should land
 * near where the hand let go, not sail across the screen.
 */
export function project(velocity: number, decelerationRate = 0.99): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Progressive resistance past a boundary instead of a hard stop. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  const sign = Math.sign(overshoot);
  const o = Math.abs(overshoot);
  return (sign * (o * dimension * constant)) / (dimension + constant * o);
}

/** Velocity (px/s) from a short history of pointer samples (last ~80 ms). */
export class VelocityTracker {
  private samples: { x: number; y: number; t: number }[] = [];

  reset(): void {
    this.samples = [];
  }

  add(x: number, y: number, t: number): void {
    this.samples.push({ x, y, t });
    while (this.samples.length > 2 && t - this.samples[0].t > 80) this.samples.shift();
  }

  velocity(now: number): { x: number; y: number } {
    const s = this.samples;
    if (s.length < 2) return { x: 0, y: 0 };
    const last = s[s.length - 1];
    // A pointer that stopped before release carries no momentum.
    if (now - last.t > 60) return { x: 0, y: 0 };
    const first = s[0];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return { x: 0, y: 0 };
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  }
}
