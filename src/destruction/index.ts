// Destruction simulation entry point: createDestruction(...) -> Destruction.
//
// Per fixed step (after physics.step()):
//   1. read Rapier's contact-force events (impacts, sources of load, wake-ups)
//   2. wake sleeping buildings that were struck
//   3. stress solve: fixed groups when their graph changed or were struck, falling groups when
//      they have contact (apparent gravity from measured acceleration); break overloaded bonds
//   4. impact damage from kinetic energy; destroyed pieces become shards
//   5. split groups into new bodies, then debris lifecycle and the chunk cap

import type RAPIER from '@dimforge/rapier3d-compat';
import type { BuildingSpec } from '../city/town-layout';
import type { Physics, QualityPreset } from '../core/types';
import { config } from '../config';
import { MATERIALS } from './materials';
import { createSleepSystem, type SleepSystem } from './sleep';
import {
  STATIC_BASE, SHARD_BASE, StressSolver, destroyPiece, flushSplits, gravityInFrame, pieceWorld, readPose,
  rotate, solveGroup,
  type Building, type Group, type Sim,
} from './joints';
import type { Destruction, DamageEvent, DestructionRenderer, DestructionStats } from './types';

export interface DestructionOptions {
  physics: Physics;
  renderer: DestructionRenderer;
  specs: BuildingSpec[];
  quality: QualityPreset;
  /** Static collider handles per building id (from addBuildingColliders). */
  buildingColliders: Map<number, unknown[]>;
}

export interface DestructionSystem extends Destruction {
  readonly sim: Sim;
  readonly sleep: SleepSystem;
  /** Wake a building now (also done automatically by damage and impacts). */
  wakeBuilding(specId: number): Building | null;
  /** Kill piece `i` of building `specId` (wakes it first). Test hook. */
  killPiece(specId: number, i: number): void;
  /** Number of bonds broken during the last fixed step. */
  lastBroken(): number;
}

/** Joules of absorbed kinetic energy that destroy one unit of piece health. */
const JOULES_PER_HEALTH = 4000;
/** Kinetic energy (J) of an impact on a sleeping building that wakes it. */
const WAKE_ENERGY = 4e4;
/** Largest apparent-gravity multiple a falling group can feel. */
const MAX_K = 150;

export function createDestruction(opts: DestructionOptions): DestructionSystem {
  const { physics, renderer, specs, quality } = opts;
  const world = physics.world;
  const specById = new Map<number, BuildingSpec>();
  for (const s of specs) specById.set(s.id, s);

  const sim: Sim = {
    R: physics.RAPIER,
    world,
    renderer,
    step: 0,
    time: 0,
    dt: config.physics.timestep,
    g: config.physics.gravity * config.physics.gravityScale,
    owners: new Map(),
    groups: [],
    buildings: new Map(),
    solver: new StressSolver(),
    nextGroupId: 1,
    brokenThisStep: 0,
    acquireBody: () => { throw new Error('pool not ready'); },
    releaseBody: () => undefined,
    spawnShards: () => undefined,
    scratchComp: new Int32Array(4096),
    scratchQueue: new Int32Array(4096),
    splitQueue: [],
  };
  const sleep = createSleepSystem(sim, { level: quality.level, maxActiveChunks: quality.maxActiveChunks });
  sim.solver.ensure(1024, 4096);

  // Tag every sleeping building's static colliders so impacts on them wake the building.
  for (const [id, list] of opts.buildingColliders) {
    for (const c of list as RAPIER.Collider[]) sim.owners.set(c.handle, STATIC_BASE + id);
  }

  const tmp = new Float64Array(3);
  const wakeQueue: number[] = [];
  const impactCodes: number[] = [];
  const impactEnergy = new Map<number, number>();

  const wakeBuilding = (specId: number): Building | null => {
    const existing = sim.buildings.get(specId);
    if (existing) return existing;
    const spec = specById.get(specId);
    if (!spec) return null;
    const list = opts.buildingColliders.get(specId) as RAPIER.Collider[] | undefined;
    const b = sleep.wake(spec, list);
    if (b) opts.buildingColliders.delete(specId);
    return b;
  };

  // ------------------------------------------------------------ contact events

  /** Mass and previous-step velocity of whatever owns a collider code; infinite mass for fixed things. */
  const kin = new Float64Array(4); // mass (Infinity = immovable), vx, vy, vz
  const kinematics = (code: number | undefined, handle: number): void => {
    kin[0] = Infinity; kin[1] = 0; kin[2] = 0; kin[3] = 0;
    if (code === undefined || code >= STATIC_BASE) return;
    if (code >= SHARD_BASE) {
      const col = world.getCollider(handle);
      const b = col?.parent();
      if (b) {
        const v = b.linvel();
        kin[0] = b.mass(); kin[1] = v.x; kin[2] = v.y; kin[3] = v.z;
      }
      return;
    }
    const bld = sim.buildings.get(Math.floor(code / 4096));
    const G = bld?.group[code % 4096];
    if (G && !G.fixed) {
      kin[0] = G.mass; kin[1] = G.vx; kin[2] = G.vy; kin[3] = G.vz;
    }
  };

  const onForce = (h1: number, h2: number, fx: number, fy: number, fz: number, mag: number): void => {
    const c1 = sim.owners.get(h1), c2 = sim.owners.get(h2);
    if (c1 === undefined && c2 === undefined) return;
    // kinetic data of both sides (previous-step velocities, before this step's impact registers)
    kinematics(c1, h1);
    const m1 = kin[0], v1x = kin[1], v1y = kin[2], v1z = kin[3];
    kinematics(c2, h2);
    const m2 = kin[0], v2x = kin[1], v2y = kin[2], v2z = kin[3];
    const vr = Math.hypot(v1x - v2x, v1y - v2y, v1z - v2z);
    const mu = m1 === Infinity ? (m2 === Infinity ? 0 : m2) : m2 === Infinity ? m1 : (m1 * m2) / (m1 + m2);
    const energy = 0.5 * mu * vr * vr;
    for (let side = 0; side < 2; side++) {
      const code = side === 0 ? c1 : c2;
      const other = side === 0 ? c2 : c1;
      if (code === undefined) continue;
      if (code >= STATIC_BASE) {
        if (energy > WAKE_ENERGY || mag > 4e5) {
          const id = code - STATIC_BASE;
          if (!wakeQueue.includes(id)) wakeQueue.push(id);
        }
        continue;
      }
      if (code >= SHARD_BASE) continue;
      const bld = sim.buildings.get(Math.floor(code / 4096));
      if (!bld) continue;
      const i = code % 4096;
      if (!bld.alive[i]) continue;
      const G = bld.group[i];
      if (!G) continue;
      G.hitStep = sim.step;
      if (!G.fixed) {
        bld.srcStamp[i] = sim.step;
      } else {
        // direction of the force on this piece: away from the other body
        let dx = 0, dy = 1, dz = 0;
        const oc = other === undefined ? undefined : other;
        if (oc !== undefined && oc < STATIC_BASE) {
          const oh = side === 0 ? h2 : h1;
          const col = world.getCollider(oh);
          if (col) {
            const t = col.translation();
            pieceWorld(G, i, tmp);
            dx = tmp[0] - t.x; dy = tmp[1] - t.y; dz = tmp[2] - t.z;
            const l = Math.hypot(dx, dy, dz) || 1;
            dx /= l; dy /= l; dz /= l;
          }
        } else {
          const l = Math.hypot(fx, fy, fz);
          if (l > 0) { dx = fx / l; dy = fy / l; dz = fz / l; if (dy < 0) { dx = -dx; dy = -dy; dz = -dz; } }
        }
        const r = rotate(-G.cur[3], -G.cur[4], -G.cur[5], G.cur[6], dx, dy, dz);
        bld.ext[i * 3] += r[0] * mag; bld.ext[i * 3 + 1] += r[1] * mag; bld.ext[i * 3 + 2] += r[2] * mag;
      }
      if (energy > 0) {
        if (bld.impactStamp[i] !== sim.step) {
          bld.impactStamp[i] = sim.step;
          bld.impact[i] = 0;
          impactCodes.push(code);
        }
        bld.impact[i] += energy;
      }
    }
  };

  // ------------------------------------------------------------ step

  const push0 = new Float64Array(3);
  const lastBroken = { n: 0 };

  const fixedUpdate = (dt: number): void => {
    sim.step++;
    sim.time += dt;
    sim.dt = dt;
    sim.g = config.physics.gravity * config.physics.gravityScale;
    sim.brokenThisStep = 0;
    const scale = config.destruction.bondStrengthScale;

    impactCodes.length = 0;
    physics.drainContactForces(onForce);
    for (let k = 0; k < wakeQueue.length; k++) wakeBuilding(wakeQueue[k]);
    wakeQueue.length = 0;

    const groups = sim.groups;
    const n = groups.length;
    for (let k = 0; k < n; k++) {
      const G = groups[k];
      if (!G.live) continue;
      const bld = G.bld;
      if (G.fixed) {
        if (G.dirty || G.hitStep === sim.step) {
          const useExt = G.hitStep === sim.step;
          G.dirty = false;
          const broke = solveGroup(sim, G, 0, -sim.g, 0, scale, useExt);
          if (broke > 0) G.dirty = true;
          if (useExt) for (const i of G.pieces) { bld.ext[i * 3] = 0; bld.ext[i * 3 + 1] = 0; bld.ext[i * 3 + 2] = 0; }
        }
        continue;
      }
      const body = G.body;
      if (body.isSleeping()) continue;
      G.prev.set(G.cur);
      readPose(G);
      const lv = body.linvel();
      const ax = (lv.x - G.vx) / dt, ay = (lv.y - G.vy) / dt, az = (lv.z - G.vz) / dt;
      G.vx = lv.x; G.vy = lv.y; G.vz = lv.z;
      if (G.hitStep === sim.step) {
        // apparent gravity = g - a (in the group's own frame)
        let wx = -ax, wy = -sim.g - ay, wz = -az;
        const mag = Math.hypot(wx, wy, wz);
        const maxMag = sim.g * MAX_K;
        if (mag > maxMag) { const s = maxMag / mag; wx *= s; wy *= s; wz *= s; }
        const kfac = mag / sim.g;
        if (kfac > 1.3 || (sim.step + G.id) % 4 === 0) {
          const gl = gravityInFrame(G, wx, wy, wz);
          solveGroup(sim, G, gl[0], gl[1], gl[2], scale, false);
        }
      }
    }

    // impact damage: absorbed kinetic energy
    for (let k = 0; k < impactCodes.length; k++) {
      const code = impactCodes[k];
      const bld = sim.buildings.get(Math.floor(code / 4096));
      if (!bld) continue;
      const i = code % 4096;
      if (!bld.alive[i]) continue;
      const piece = bld.graph.pieces[i];
      const dmg = bld.impact[i] / JOULES_PER_HEALTH / (MATERIALS[piece.material].impactG / 10);
      if (dmg < 0.5) continue;
      bld.health[i] -= dmg;
      if (bld.health[i] <= 0) destroyPiece(sim, bld, i, push0);
      else sim.renderer.setDamage(bld.handle[i], 1 - bld.health[i] / piece.maxHealth);
    }
    flushSplits(sim);

    sleep.update(dt);
    sleep.enforceCap();
    lastBroken.n = sim.brokenThisStep;
  };

  // ------------------------------------------------------------ damage

  const probes: number[] = [];
  const bp = new Float64Array(3);

  const shapeProbes = (ev: DamageEvent): number => {
    probes.length = 0;
    const s = ev.shape;
    if (s.kind === 'sphere' || s.kind === 'ring') probes.push(s.center.x, s.center.y, s.center.z);
    else {
      probes.push(s.a.x, s.a.y, s.a.z, (s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, (s.a.z + s.b.z) / 2, s.b.x, s.b.y, s.b.z);
    }
    return s.radius;
  };

  /** Distance from the shape to an axis-aligned (in the group frame) piece box, probes given in building-local coords. */
  const boxDist = (lp: number[], b: Building, i: number): number => {
    const g = b.graph;
    const hx = g.pieces[i].halfExtents[0], hy = g.pieces[i].halfExtents[1], hz = g.pieces[i].halfExtents[2];
    let best = Infinity;
    for (let p = 0; p < lp.length; p += 3) {
      const dx = Math.max(Math.abs(lp[p] - g.cen[i * 3]) - hx, 0);
      const dy = Math.max(Math.abs(lp[p + 1] - g.cen[i * 3 + 1]) - hy, 0);
      const dz = Math.max(Math.abs(lp[p + 2] - g.cen[i * 3 + 2]) - hz, 0);
      const d = Math.hypot(dx, dy, dz);
      if (d < best) best = d;
    }
    return best;
  };

  const spec2probeDist = (spec: BuildingSpec): number => {
    const cs = Math.cos(spec.yaw), sn = Math.sin(spec.yaw);
    let best = Infinity;
    for (let p = 0; p < probes.length; p += 3) {
      const dx = probes[p] - spec.x, dz = probes[p + 2] - spec.z;
      const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      const ex = Math.max(Math.abs(lx) - spec.width / 2, 0);
      const ez = Math.max(Math.abs(lz) - spec.depth / 2, 0);
      const ey = Math.max(-probes[p + 1], probes[p + 1] - (spec.height + 8), 0);
      const d = Math.hypot(ex, ey, ez);
      if (d < best) best = d;
    }
    return best;
  };

  const applyDamage = (ev: DamageEvent): void => {
    let radius = shapeProbes(ev);
    if (ev.shape.kind === 'ring') radius = Math.max(3, radius * 0.25);
    // wake buildings in range
    for (const spec of specs) {
      if (sim.buildings.has(spec.id) || spec.type === 'gasholder') continue;
      if (spec2probeDist(spec) <= radius + config.destruction.wakeRadius) wakeBuilding(spec.id);
    }
    const healthScale = Math.max(0.01, config.destruction.healthScale);
    const kills: Array<{ b: Building; i: number; dx: number; dy: number; dz: number; f: number }> = [];
    const lp: number[] = [];
    const ringShape = ev.shape.kind === 'ring' ? ev.shape : null;
    for (const bld of sim.buildings.values()) {
      const spec = bld.spec;
      if (spec2probeDist(spec) > radius + 6) continue;
      for (const G of sim.groups) {
        if (G.bld !== bld || !G.live) continue;
        // probes into the group's building-local frame
        lp.length = 0;
        const c = G.cur;
        for (let p = 0; p < probes.length; p += 3) {
          const r = rotate(-c[3], -c[4], -c[5], c[6], probes[p] - c[0], probes[p + 1] - c[1], probes[p + 2] - c[2]);
          lp.push(r[0] + G.ox, r[1] + G.oy, r[2] + G.oz);
        }
        let hitMass = 0, hitF = 0;
        for (const i of G.pieces) {
          if (!bld.alive[i]) continue;
          let d: number;
          if (ringShape) {
            pieceWorld(G, i, bp);
            const dh = Math.abs(Math.hypot(bp[0] - ringShape.center.x, bp[2] - ringShape.center.z) - ringShape.radius);
            const dy = Math.max(Math.abs(bp[1] - ringShape.center.y) - ringShape.height / 2, 0);
            d = Math.max(0, Math.hypot(dh, dy) - Math.hypot(...bld.graph.pieces[i].halfExtents) * 0.5);
          } else {
            d = boxDist(lp, bld, i);
          }
          const piece = bld.graph.pieces[i];
          const isGlass = piece.material === 'glass';
          const reach = isGlass ? radius * 2 : radius;
          if (d >= reach) continue;
          const f = 1 - d / reach;
          const dmg = (ev.damage * f * f * (isGlass ? 4 : 1)) / healthScale;
          bld.health[i] -= dmg;
          hitMass += piece.mass; hitF += f * piece.mass;
          if (bld.health[i] <= 0) {
            pieceWorld(G, i, bp);
            let dx = bp[0] - probes[0], dy = bp[1] - probes[1] + 0.3, dz = bp[2] - probes[2];
            if (ev.direction) { dx += ev.direction.x * radius; dy += ev.direction.y * radius; dz += ev.direction.z * radius; }
            const l = Math.hypot(dx, dy, dz) || 1;
            kills.push({ b: bld, i, dx: dx / l, dy: dy / l, dz: dz / l, f });
          } else {
            sim.renderer.setDamage(bld.handle[i], 1 - bld.health[i] / piece.maxHealth);
          }
        }
        // loose (falling) groups also get shoved
        if (!G.fixed && hitMass > 0) {
          const fAvg = hitF / hitMass;
          const dv = Math.min(12, (ev.impulse * fAvg) / Math.max(G.mass, 1));
          const wc = G.body.worldCom();
          let dx = wc.x - probes[0], dy = wc.y - probes[1] + 0.3, dz = wc.z - probes[2];
          const l = Math.hypot(dx, dy, dz) || 1;
          dx /= l; dy /= l; dz /= l;
          const lv = G.body.linvel();
          G.body.setLinvel({ x: lv.x + dx * dv, y: lv.y + dy * dv, z: lv.z + dz * dv }, true);
        }
      }
    }
    for (const k of kills) {
      if (!k.b.alive[k.i]) continue;
      const m = k.b.graph.pieces[k.i].mass;
      const sp = Math.max(2, Math.min(18, (ev.impulse * k.f) / m));
      push0[0] = k.dx * sp; push0[1] = k.dy * sp; push0[2] = k.dz * sp;
      destroyPiece(sim, k.b, k.i, push0);
    }
    push0.fill(0);
    flushSplits(sim);
  };

  // ------------------------------------------------------------ visuals

  const pos = { x: 0, y: 0, z: 0 };
  const quat = { x: 0, y: 0, z: 0, w: 1 };

  const syncVisual = (alpha: number): void => {
    for (const G of sim.groups) {
      if (!G.live) continue;
      const moving = !G.fixed && !G.body.isSleeping();
      if (!moving && !G.needsPush) continue;
      G.needsPush = false;
      const a = G.prev, b = G.cur;
      const t = G.fixed ? 1 : alpha;
      const sg = a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6] < 0 ? -1 : 1;
      let qx = a[3] + (sg * b[3] - a[3]) * t, qy = a[4] + (sg * b[4] - a[4]) * t, qz = a[5] + (sg * b[5] - a[5]) * t, qw = a[6] + (sg * b[6] - a[6]) * t;
      const ql = Math.hypot(qx, qy, qz, qw) || 1;
      qx /= ql; qy /= ql; qz /= ql; qw /= ql;
      quat.x = qx; quat.y = qy; quat.z = qz; quat.w = qw;
      const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t, pz = a[2] + (b[2] - a[2]) * t;
      const bld = G.bld;
      const cen = bld.graph.cen;
      for (const i of G.pieces) {
        const h = bld.handle[i];
        if (h < 0 || !bld.alive[i]) continue;
        const r = rotate(qx, qy, qz, qw, cen[i * 3] - G.ox, cen[i * 3 + 1] - G.oy, cen[i * 3 + 2] - G.oz);
        pos.x = px + r[0]; pos.y = py + r[1]; pos.z = pz + r[2];
        renderer.setTransform(h, pos, quat);
      }
    }
    for (const d of sleep.debris) {
      if (!d.used || d.handle < 0 || !d.body || d.body.isSleeping()) continue;
      const a = d.prev, b = d.cur;
      quat.x = a[3] + (b[3] - a[3]) * alpha; quat.y = a[4] + (b[4] - a[4]) * alpha;
      quat.z = a[5] + (b[5] - a[5]) * alpha; quat.w = a[6] + (b[6] - a[6]) * alpha;
      const ql = Math.hypot(quat.x, quat.y, quat.z, quat.w) || 1;
      quat.x /= ql; quat.y /= ql; quat.z /= ql; quat.w /= ql;
      pos.x = a[0] + (b[0] - a[0]) * alpha; pos.y = a[1] + (b[1] - a[1]) * alpha; pos.z = a[2] + (b[2] - a[2]) * alpha;
      renderer.setTransform(d.handle, pos, quat);
    }
    renderer.update();
  };

  const statsOut: DestructionStats = { awakeBuildings: 0, activeChunks: 0, liveBonds: 0, rubbleBodies: 0 };
  const stats = (): DestructionStats => {
    let bonds = 0;
    for (const b of sim.buildings.values()) bonds += b.liveBonds;
    statsOut.awakeBuildings = sim.buildings.size;
    statsOut.activeChunks = sleep.chunkCount();
    statsOut.liveBonds = bonds;
    statsOut.rubbleBodies = sleep.rubbleCount;
    return statsOut;
  };

  return {
    sim,
    sleep,
    applyDamage,
    fixedUpdate,
    syncVisual,
    stats,
    wakeBuilding,
    lastBroken: () => lastBroken.n,
    killPiece(specId: number, i: number): void {
      const b = wakeBuilding(specId);
      if (!b || !b.alive[i]) return;
      push0.fill(0);
      destroyPiece(sim, b, i, push0);
      flushSplits(sim);
    },
  };
}

export type { Group };
