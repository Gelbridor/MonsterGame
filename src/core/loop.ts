// Fixed 60 Hz physics step, variable-rate rendering.
//
// Each animation frame adds real elapsed time to an accumulator and runs as
// many fixed steps as fit. The leftover fraction (alpha) is passed to render
// so visuals can interpolate between the last two physics states.

import { config } from '../config';

export interface LoopCallbacks {
  /** Called once per fixed step with dt = config.physics.timestep. */
  fixedUpdate(dt: number): void;
  /** Called once per animation frame. */
  frame(frameDt: number, alpha: number, stepsThisFrame: number): void;
}

export interface Loop {
  start(): void;
  stop(): void;
  /** Time scale for slow motion (1 = normal). Physics dt never changes; we just feed it less time. */
  timeScale: number;
}

export function createLoop(cb: LoopCallbacks): Loop {
  let accumulator = 0;
  let last = 0;
  let rafId = 0;
  let running = false;

  const loop: Loop = {
    timeScale: 1,
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      rafId = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
    },
  };

  function tick(now: number) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);

    const step = config.physics.timestep;
    // Clamp huge gaps (tab switch, breakpoint) so we never try to catch up minutes.
    const frameDt = Math.min((now - last) / 1000, 0.25);
    last = now;

    accumulator += frameDt * loop.timeScale;

    let steps = 0;
    while (accumulator >= step && steps < config.physics.maxStepsPerFrame) {
      cb.fixedUpdate(step);
      accumulator -= step;
      steps++;
    }
    // Too slow to keep up: drop the backlog rather than spiral.
    if (steps === config.physics.maxStepsPerFrame && accumulator > step) accumulator = 0;

    cb.frame(frameDt, accumulator / step, steps);
  }

  return loop;
}
