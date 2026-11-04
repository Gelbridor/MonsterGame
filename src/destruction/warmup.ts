// Load-time warm-up for the destruction path.
//
// Rapier's WebAssembly is compiled lazily, function by function, the first time each is called, and
// the destruction code is JIT-compiled the same way. Left alone, the first punch pays for all of it
// at once: 70-90 ms in physics.step() alone (compound bodies, convex-hull shards, contact-force
// events, the solver for dynamic bodies), plus the sim's own first wake. This runs the whole path
// once in a throwaway world while the loading screen is up: wake a building, punch it, knock its
// ground floor out, simulate the collapse and the debris until it is baked to rubble.

import type { BuildingSpec } from '../city/town-layout';
import type { QualityPreset } from '../core/types';
import { createPhysicsWorld } from '../physics/world';
import { config } from '../config';
import { createDestruction } from './index';
import { createNullRenderer } from './debug-render';
import { fractureBox } from './fracture';
import type { GenGraph } from './building-gen';

/** Run the warm-up; returns the milliseconds it took. `graphs` is the game's (prepared) graph cache. */
export function warmUpDestruction(specs: BuildingSpec[], quality: QualityPreset, graphs: Map<number, GenGraph | null>, steps = 80): number {
  const t0 = performance.now();
  // the smallest non-trivial building, moved to the origin of an empty world
  let src: BuildingSpec | null = null;
  for (const s of specs) {
    const g = graphs.get(s.id);
    if (!g || g.pieces.length < 12) continue;
    if (!src || g.pieces.length < graphs.get(src.id)!.pieces.length) src = s;
  }
  if (!src) return 0;
  const spec: BuildingSpec = { ...src, x: 0, z: 0 };
  const physics = createPhysicsWorld();
  try {
    physics.addStaticBox({ x: 0, y: -1, z: 0 }, { x: 200, y: 1, z: 200 });
    // a sleeping building's static colliders (so the wake path removes them, as in the game)
    const statics = new Map<number, unknown[]>();
    statics.set(spec.id, [physics.addStaticBox({ x: 0, y: spec.height / 2, z: 0 }, { x: spec.width / 2, y: spec.height / 2, z: spec.depth / 2 }, spec.yaw)]);
    const local = new Map<number, GenGraph | null>([[spec.id, graphs.get(src.id)!]]);
    const d = createDestruction({ physics, renderer: createNullRenderer(['low', 'medium', 'high', 'ultra'].indexOf(quality.level)), specs: [spec], quality, buildingColliders: statics, graphs: local });
    const dt = config.physics.timestep;
    // a punch on the front face, then the ground supports removed: shards, a split, a loose body
    // that falls and lands (landing solve, crushing), contact events, sleeping and rubble baking
    d.applyDamage({
      shape: { kind: 'sphere', center: { x: 0, y: 2, z: spec.depth / 2 + 0.5 }, radius: config.destruction.punchRadius },
      damage: config.destruction.punchDamage, impulse: config.destruction.punchImpulse, direction: { x: 0, y: 0, z: -1 },
    });
    const b = d.sim.buildings.get(spec.id);
    if (b) {
      const g = b.graph;
      for (let k = 0; k < g.bonds.length; k++) if (g.bb[k] < 0 && b.alive[g.ba[k]]) d.killPiece(spec.id, g.ba[k], k % 2 === 0);
    }
    for (let i = 0; i < steps; i++) {
      physics.step();
      d.fixedUpdate(dt);
      if (i % 10 === 0) d.syncVisual(1);
    }
    // the real (Voronoi) fracture the game's renderer uses
    if (b) {
      for (let k = 0; k < Math.min(4, b.graph.pieces.length); k++) {
        const p = b.graph.pieces[k];
        fractureBox(p.halfExtents[0], p.halfExtents[1], p.halfExtents[2], p.material, p.kind, p.seed + 7919, 6);
      }
    }
  } finally {
    physics.world.free();
  }
  return performance.now() - t0;
}
