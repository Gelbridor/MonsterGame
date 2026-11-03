// Waking sleeping buildings, the debris lifecycle (lifetime -> sleep -> merged into static
// rubble), the body pool and the hard cap on active chunks.
//
// All dynamic destruction bodies (loose building groups and shards) come from one fixed pool of
// pre-created Rapier bodies (disabled when idle), so play never creates dynamic bodies. When the
// pool or the tier's `maxActiveChunks` cap is hit, the oldest chunks are merged into rubble early.

import type RAPIER from '@dimforge/rapier3d-compat';
import type { BuildingSpec } from '../city/town-layout';
import type { QualityLevel } from '../core/types';
import { config } from '../config';
import { generateBuilding } from './building-gen';
import { MATERIALS } from './materials';
import {
  CG_CRUSHED, SHARD_BASE, createGroup, makeBuilding, readPose, resplit, retireGroup, rotate,
  type Building, type Group, type PooledBody, type Sim,
} from './joints';
import type { FractureResult, RenderHandle } from './types';

interface Debris {
  used: boolean;
  body: RAPIER.RigidBody | null;
  pooled: boolean;
  collider: RAPIER.Collider | null;
  handle: RenderHandle;
  born: number;
  life: number;
  rest: number;
  cur: Float64Array;
  prev: Float64Array;
  /** Shard geometry for the rubble collider (hull points relative to the body origin) or null for a box. */
  hull: Float32Array | null;
  hx: number; hy: number; hz: number;
  /** Pulverised by compressive failure: does not collide with building pieces. */
  crushed: boolean;
}

export interface SleepSystem {
  sim: Sim;
  debris: Debris[];
  rubbleBody: RAPIER.RigidBody;
  rubbleCount: number;
  poolSize: number;
  /** Dynamic bodies currently alive (groups + shards). */
  chunkCount(): number;
  wake(spec: BuildingSpec, statics: RAPIER.Collider[] | undefined): Building | null;
  update(dt: number): void;
  enforceCap(): void;
  /** Merge a loose group into rubble now. */
  bakeGroup(G: Group): void;
}

export interface SleepOptions {
  level: QualityLevel;
  maxActiveChunks: number;
}

/** Loose groups with at most this many pieces are baked to rubble once at rest. */
const BAKE_MAX_PIECES = 6;
/** Shards a crushed (pulverised) piece breaks into. */
const CRUSHED_SHARDS = 3;
/**
 * Shard colliders are this fraction of the shard's size (visuals stay full size). Shards are cut to
 * tile their piece exactly, so full-size colliders would start in face contact with every sibling
 * and neighbour; Rapier then builds all those contacts in one step (about 20 ms per broken piece).
 */
const SHARD_COLLIDER_SCALE = 0.9;
/** Most shard bodies created per physics step; further breaks wait a step or two (no frame spike). */
const SHARDS_PER_STEP = 24;

interface SpawnReq {
  bld: Building; i: number; crushed: boolean; step: number;
  pos: Float64Array; quat: Float64Array; vel: Float64Array; ang: Float64Array; push: Float64Array;
}

export function createSleepSystem(sim: Sim, opts: SleepOptions): SleepSystem {
  const R = sim.R;
  const world = sim.world;
  const cap = opts.maxActiveChunks;
  // pool of dynamic bodies, one per chunk plus headroom for loose groups
  const poolSize = cap + 32;
  const pool: RAPIER.RigidBody[] = [];
  const free: number[] = [];
  const poolIndex = new Map<number, number>();
  for (let i = 0; i < poolSize; i++) {
    const b = world.createRigidBody(
      R.RigidBodyDesc.dynamic().setEnabled(false).setLinearDamping(0.03).setAngularDamping(0.12).setCanSleep(true),
    );
    pool.push(b);
    poolIndex.set(b.handle, i);
    free.push(i);
  }
  const rubbleBody = world.createRigidBody(R.RigidBodyDesc.fixed());

  const debris: Debris[] = [];
  for (let i = 0; i < poolSize; i++) {
    debris.push({
      used: false, body: null, pooled: true, collider: null, handle: -1, born: 0, life: 5, rest: 0,
      cur: new Float64Array(7), prev: new Float64Array(7), hull: null, hx: 0, hy: 0, hz: 0, crushed: false,
    });
  }
  const debrisFree: number[] = [];
  for (let i = poolSize - 1; i >= 0; i--) debrisFree.push(i);
  let usedDebris = 0;

  let seed = 0x1234567;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /**
   * True if a building piece of another body rests on (touches) this collider. Such debris is
   * carrying load and must stay a live body: baking it to static rubble would freeze whatever it
   * holds up in mid-air.
   */
  let probeSelf: Group | null = null;
  let probeHit = false;
  const probeCb = (o: RAPIER.Collider): void => {
    if (probeHit) return;
    const code = sim.owners.get(o.handle);
    if (code === undefined || code >= SHARD_BASE) return;
    const bld = sim.buildings.get(Math.floor(code / 4096));
    const G = bld?.group[code % 4096];
    if (G && G !== probeSelf && !G.fixed) probeHit = true;
  };
  const carriesPieces = (col: RAPIER.Collider | null, self: Group | null): boolean => {
    if (!col) return false;
    probeSelf = self;
    probeHit = false;
    world.contactPairsWith(col, probeCb);
    return probeHit;
  };
  const groupCarries = (G: Group): boolean => {
    for (const i of G.pieces) if (carriesPieces(G.bld.collider[i], G)) return true;
    return false;
  };

  const self: SleepSystem = {
    sim, debris, rubbleBody, rubbleCount: 0, poolSize,
    chunkCount() {
      let n = usedDebris;
      for (const G of sim.groups) if (!G.fixed) n++;
      return n;
    },
    wake, update, enforceCap, bakeGroup,
  };

  // ---- body pool
  sim.acquireBody = (): PooledBody => {
    let idx = free.pop();
    if (idx === undefined) {
      enforceCapTo(self.chunkCount() - 1);
      idx = free.pop();
    }
    if (idx === undefined) {
      // pool exhausted even after merging: fall back to a fresh body (released by removal)
      const b = world.createRigidBody(R.RigidBodyDesc.dynamic().setLinearDamping(0.03).setAngularDamping(0.12));
      return { body: b, pooled: false };
    }
    const b = pool[idx];
    b.setEnabled(true);
    return { body: b, pooled: true };
  };
  sim.releaseBody = (b: RAPIER.RigidBody, pooled: boolean): void => {
    if (!pooled) {
      world.removeRigidBody(b);
      return;
    }
    while (b.numColliders() > 0) {
      const c = b.collider(0);
      sim.owners.delete(c.handle);
      world.removeCollider(c, false);
    }
    b.setLinvel({ x: 0, y: 0, z: 0 }, false);
    b.setAngvel({ x: 0, y: 0, z: 0 }, false);
    b.setEnabled(false);
    const idx = poolIndex.get(b.handle);
    if (idx !== undefined) free.push(idx);
  };

  // ---- shards
  const shardCountFor = (matShards: number): number => {
    const d = config.destruction;
    const t = Math.min(1, opts.maxActiveChunks / 1500);
    const base = d.shardsMin + (d.shardsMax - d.shardsMin) * t;
    return Math.max(3, Math.min(d.shardsMax, Math.round(base * matShards)));
  };

  const lerpPose = new Float64Array(7);
  void lerpPose;

  // Breaks are queued and turned into shard bodies a few per step (see SHARDS_PER_STEP).
  const spawnQueue: SpawnReq[] = [];
  const spawnFree: SpawnReq[] = [];
  sim.spawnShards = (bld: Building, i: number, pos: Float64Array, quat: Float64Array, vel: Float64Array, ang: Float64Array, push: Float64Array, crushed: boolean): void => {
    const r = spawnFree.pop() ?? {
      bld, i, crushed, step: 0,
      pos: new Float64Array(3), quat: new Float64Array(4), vel: new Float64Array(3), ang: new Float64Array(3), push: new Float64Array(3),
    };
    r.bld = bld; r.i = i; r.crushed = crushed; r.step = sim.step;
    r.pos.set(pos); r.quat.set(quat); r.vel.set(vel); r.ang.set(ang); r.push.set(push);
    spawnQueue.push(r);
  };
  const flushSpawns = (dt: number): void => {
    let made = 0, k = 0;
    for (; k < spawnQueue.length && made < SHARDS_PER_STEP; k++) {
      const r = spawnQueue[k];
      // the piece kept moving while it waited
      const late = (sim.step - r.step) * dt;
      for (let a = 0; a < 3; a++) r.pos[a] += r.vel[a] * late;
      made += spawnNow(r.bld, r.i, r.pos, r.quat, r.vel, r.ang, r.push, r.crushed);
      spawnFree.push(r);
    }
    if (k > 0) spawnQueue.splice(0, k);
  };
  (self as SleepSystem & { pendingSpawns: () => number }).pendingSpawns = () => spawnQueue.length;

  const spawnNow = (bld: Building, i: number, pos: Float64Array, quat: Float64Array, vel: Float64Array, ang: Float64Array, push: Float64Array, crushed: boolean): number => {
    const piece = bld.graph.pieces[i];
    const mat = MATERIALS[piece.material];
    // pulverised members break into a few big lumps (the rest is dust, an effect, not bodies)
    const fr: FractureResult = sim.renderer.fracture(piece, crushed ? CRUSHED_SHARDS : shardCountFor(mat.shards));
    const n = fr.shards.length;
    const volTotal = piece.halfExtents[0] * piece.halfExtents[1] * piece.halfExtents[2] * 8;
    for (let k = 0; k < n; k++) {
      let di = debrisFree.pop();
      if (di === undefined) {
        enforceCapTo(self.chunkCount() - 1);
        di = debrisFree.pop();
        if (di === undefined) return k;
      }
      const sh = fr.shards[k];
      const d = debris[di];
      const pb = sim.acquireBody();
      const body = pb.body;
      const r = rotate(quat[0], quat[1], quat[2], quat[3], sh.center[0], sh.center[1], sh.center[2]);
      const px = pos[0] + r[0], py = pos[1] + r[1], pz = pos[2] + r[2];
      const sp = 1 + rnd() * 1.5;
      let dx = r[0], dy = r[1], dz = r[2];
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      const vx = vel[0] + (ang[1] * r[2] - ang[2] * r[1]) + push[0] + dx * sp + (rnd() - 0.5);
      const vy = vel[1] + (ang[2] * r[0] - ang[0] * r[2]) + push[1] + dy * sp + rnd();
      const vz = vel[2] + (ang[0] * r[1] - ang[1] * r[0]) + push[2] + dz * sp + (rnd() - 0.5);
      body.setTranslation({ x: px, y: py, z: pz }, true);
      body.setRotation({ x: quat[0], y: quat[1], z: quat[2], w: quat[3] }, true);
      body.setLinvel({ x: vx, y: vy, z: vz }, true);
      body.setAngvel({ x: ang[0] + (rnd() - 0.5) * 6, y: ang[1] + (rnd() - 0.5) * 6, z: ang[2] + (rnd() - 0.5) * 6 }, true);
      const mass = Math.max(1, Math.min(piece.mass * (sh.volume / volTotal), piece.mass));
      const hull = sh.hull.length >= 12 ? sh.hull.map((v) => v * SHARD_COLLIDER_SCALE) : null;
      let desc = hull ? R.ColliderDesc.convexHull(hull) : null;
      let hx = 0, hy = 0, hz = 0;
      if (!desc) {
        const e = (Math.cbrt(Math.max(sh.volume, 1e-4)) / 2) * SHARD_COLLIDER_SCALE;
        hx = hy = hz = e;
        desc = R.ColliderDesc.cuboid(e, e, e);
      }
      if (crushed) desc.setCollisionGroups(CG_CRUSHED);
      desc.setMass(mass).setFriction(0.7).setRestitution(0.1)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(mass * sim.g * 6);
      const col = world.createCollider(desc, body);
      sim.owners.set(col.handle, SHARD_BASE + di);
      d.used = true; d.body = body; d.pooled = pb.pooled; d.collider = col;
      d.handle = sim.renderer.addShard(piece, fr, k);
      d.born = sim.time;
      d.life = config.destruction.debrisLifetime * (0.6 + rnd() * 0.9);
      d.rest = 0;
      d.hull = desc === null || hx > 0 ? null : hull;
      d.hx = hx; d.hy = hy; d.hz = hz;
      d.crushed = crushed;
      d.cur[0] = px; d.cur[1] = py; d.cur[2] = pz;
      d.cur[3] = quat[0]; d.cur[4] = quat[1]; d.cur[5] = quat[2]; d.cur[6] = quat[3];
      d.prev.set(d.cur);
      usedDebris++;
    }
    return n;
  };

  // ---- rubble
  const rq = { x: 0, y: 0, z: 0, w: 1 };
  const addRubble = (desc: RAPIER.ColliderDesc, x: number, y: number, z: number, q0: number, q1: number, q2: number, q3: number, crushed = false): void => {
    rq.x = q0; rq.y = q1; rq.z = q2; rq.w = q3;
    desc.setTranslation(x, y, z).setRotation(rq).setFriction(0.9);
    if (crushed) desc.setCollisionGroups(CG_CRUSHED);
    world.createCollider(desc, rubbleBody);
    self.rubbleCount++;
  };

  const bakeDebris = (di: number): void => {
    const d = debris[di];
    if (!d.used || !d.body) return;
    const t = d.body.translation();
    const q = d.body.rotation();
    const desc = d.hull ? R.ColliderDesc.convexHull(d.hull) : R.ColliderDesc.cuboid(d.hx, d.hy, d.hz);
    if (desc) addRubble(desc, t.x, t.y, t.z, q.x, q.y, q.z, q.w, d.crushed);
    const col = d.collider;
    if (col) sim.owners.delete(col.handle);
    sim.releaseBody(d.body, d.pooled);
    if (d.handle >= 0) sim.renderer.bakeToRubble([d.handle]);
    d.used = false; d.body = null; d.collider = null; d.handle = -1;
    debrisFree.push(di);
    usedDebris--;
  };

  function bakeGroup(G: Group): void {
    if (!G.live) return;
    const bld = G.bld, g = bld.graph;
    readPose(G);
    const c = G.cur;
    const handles: number[] = [];
    for (const i of G.pieces) {
      if (!bld.alive[i]) continue;
      const p = g.pieces[i];
      const r = rotate(c[3], c[4], c[5], c[6], g.cen[i * 3] - G.ox, g.cen[i * 3 + 1] - G.oy, g.cen[i * 3 + 2] - G.oz);
      addRubble(R.ColliderDesc.cuboid(p.halfExtents[0], p.halfExtents[1], p.halfExtents[2]), c[0] + r[0], c[1] + r[1], c[2] + r[2], c[3], c[4], c[5], c[6]);
      if (bld.handle[i] >= 0) handles.push(bld.handle[i]);
      bld.alive[i] = 0;
      bld.livePieces--;
      for (let e = g.adjStart[i]; e < g.adjStart[i + 1]; e++) {
        const b = g.adjBond[e];
        if (bld.bondAlive[b]) { bld.bondAlive[b] = 0; bld.liveBonds--; }
      }
      bld.handle[i] = -1;
    }
    if (handles.length) sim.renderer.bakeToRubble(handles);
    retireGroup(sim, G);
  }

  // ---- cap / early merge
  function enforceCapTo(limit: number): void {
    let n = self.chunkCount();
    if (n <= limit) return;
    // gather candidates oldest-first (debris shards and loose groups)
    const cand: Array<{ born: number; di: number; G: Group | null }> = [];
    for (let i = 0; i < debris.length; i++) if (debris[i].used) cand.push({ born: debris[i].born, di: i, G: null });
    // loose groups only once at rest: baking a falling body would freeze it in mid-air
    for (const G of sim.groups) if (!G.fixed && !G.busy && !G.pendingSplit && G.body.isSleeping()) cand.push({ born: G.born, di: -1, G });
    cand.sort((a, b) => a.born - b.born);
    for (let k = 0; k < cand.length && n > limit; k++) {
      const c = cand[k];
      if (c.G) { if (c.G.live) { sim.bakedCapTotal += c.G.pieces.length; bakeGroup(c.G); n--; } } else { bakeDebris(c.di); n--; }
    }
  }
  function enforceCap(): void {
    enforceCapTo(opts.maxActiveChunks);
  }

  // ---- per step
  function update(dt: number): void {
    flushSpawns(dt);
    const lifetime = config.destruction.debrisLifetime;
    for (let i = 0; i < debris.length; i++) {
      const d = debris[i];
      if (!d.used || !d.body) continue;
      const b = d.body;
      d.prev.set(d.cur);
      if (!b.isSleeping()) {
        const t = b.translation(), q = b.rotation();
        d.cur[0] = t.x; d.cur[1] = t.y; d.cur[2] = t.z; d.cur[3] = q.x; d.cur[4] = q.y; d.cur[5] = q.z; d.cur[6] = q.w;
        if (t.y < -40) { bakeDebris(i); continue; }
      }
      const age = sim.time - d.born;
      if (age < d.life) continue;
      if (b.isSleeping()) d.rest += dt;
      else {
        const v = b.linvel();
        if (v.x * v.x + v.y * v.y + v.z * v.z < 0.25) d.rest += dt;
        else d.rest = 0;
      }
      if ((d.rest > 0.4 || age > d.life * 3 + lifetime) && !carriesPieces(d.collider, null)) bakeDebris(i);
    }
    for (let k = sim.groups.length - 1; k >= 0; k--) {
      const G = sim.groups[k];
      if (G.fixed || !G.live) continue;
      if (G.body.isSleeping()) G.rest += dt;
      else G.rest = 0;
      // Small loose groups at rest become static rubble. Big ones (a fallen floor, a standing
      // remnant) stay as sleeping bodies so they can still be broken, and are only merged
      // early by the chunk cap.
      if (G.pieces.length <= BAKE_MAX_PIECES && (G.rest > 0.6 || sim.time - G.born > 40) && !groupCarries(G)) { sim.bakedRestTotal += G.pieces.length; bakeGroup(G); }
    }
  }

  // ---- waking
  function wake(spec: BuildingSpec, statics: RAPIER.Collider[] | undefined): Building | null {
    if (sim.buildings.has(spec.id)) return sim.buildings.get(spec.id)!;
    const graph = generateBuilding(spec, opts.level);
    if (!graph) return null;
    const bld = makeBuilding(spec, graph);
    sim.buildings.set(spec.id, bld);
    if (statics) {
      for (const c of statics) {
        sim.owners.delete(c.handle);
        const parent = c.parent();
        if (parent) world.removeRigidBody(parent);
        else world.removeCollider(c, false);
      }
    }
    sim.renderer.hideBuilding(spec.id);
    for (const piece of graph.pieces) bld.handle[piece.index] = sim.renderer.addPiece(graph, piece);
    const all: number[] = [];
    for (let i = 0; i < graph.pieces.length; i++) all.push(i);
    const zero = new Float64Array(3);
    const G = createGroup(sim, bld, all, true, spec.x, 0, spec.z, 0, bld.qy, 0, bld.qw, 0, 0, 0, zero, zero, zero);
    resplit(sim, G);
    return bld;
  }

  return self;
}
