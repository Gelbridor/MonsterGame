// Bonds, breaking, and group splitting.
//
// Rapier 0.21 has no joint-force read-back, so connected pieces share ONE rigid body (a compound of
// box colliders with true masses) and bond stress comes from a structural solve of the bond graph
// (src/destruction/stress.ts): an elastic 6-DOF frame solve under true weight, the apparent gravity
// of a landing body, and measured impact forces.
//   - A bond whose utilisation (compression + tension + shear + bending) reaches 1 breaks. When bonds
//     break the group is split into connected components; each becomes its own body with the
//     velocity of the old body at its centre of mass. A component with a ground bond stays fixed,
//     anything else is dynamic and falls under Rapier's gravity.

import type RAPIER from '@dimforge/rapier3d-compat';
import type { BuildingSpec } from '../city/town-layout';
import type { DestructionRenderer, RenderHandle } from './types';
import type { GenGraph } from './building-gen';
import { StressSolver } from './stress';
import { config } from '../config';

export { StressSolver };

// ------------------------------------------------------------------ bond design

/** Design target: the intact building uses this fraction of every bond's limit (safety factor 1/x). */
const DESIGN_UTIL = 0.35;
const designSolver = new StressSolver();

/**
 * Size every bond so the intact building carries its own weight at DESIGN_UTIL: one accurate
 * elastic solve of the whole building under gravity, then any bond whose load exceeds the design
 * level is strengthened to exactly that level (stiffness does not depend on strength, so one
 * solve suffices). Returns the CG iterations used.
 */
export function designBonds(G: GenGraph): number {
  const np = G.pieces.length, nb = G.bonds.length;
  designSolver.ensure(np, nb);
  const pAlive = new Uint8Array(np).fill(1);
  const bAlive = new Uint8Array(nb).fill(1);
  const list = new Int32Array(np);
  for (let i = 0; i < np; i++) list[i] = i;
  const res = designSolver.solve(G, pAlive, bAlive, list, np, 0, -9.81, 0, true, null, 0, null, 1, null, 4000, 1e-7);
  for (let k = 0; k < designSolver.nBonds; k++) {
    const b = designSolver.bonds[k];
    const u = designSolver.util[b];
    if (u > DESIGN_UTIL) {
      const f = u / DESIGN_UTIL;
      G.fcap[b] *= f;
      G.mcap[b] *= f;
    }
  }
  for (let b = 0; b < nb; b++) {
    G.bonds[b].maxForce = G.fcap[b];
    G.bonds[b].maxMoment = G.mcap[b];
  }
  G.info.designIters = res.iterations;
  return res.iterations;
}

// ------------------------------------------------------------------ runtime structures

export interface Group {
  id: number;
  bld: Building;
  fixed: boolean;
  body: RAPIER.RigidBody;
  pooled: boolean;
  pieces: number[];
  /** Body origin in building-local coordinates. */
  ox: number; oy: number; oz: number;
  mass: number;
  /** Current and previous pose (position + quaternion) for interpolation. */
  cur: Float64Array;
  prev: Float64Array;
  /** Linear velocity at the end of the last step (for acceleration). */
  vx: number; vy: number; vz: number;
  born: number;
  /** Seconds the body has been (nearly) at rest. */
  rest: number;
  needsPush: boolean;
  /** Fixed group: needs a stress solve (graph changed or struck). */
  dirty: boolean;
  /** Step on which a contact-force event touched this group. */
  hitStep: number;
  pendingSplit: boolean;
  /** True while resplit() runs (the cap logic must not merge it). */
  busy: boolean;
  slot: number;
  live: boolean;
}

export interface Building {
  spec: BuildingSpec;
  graph: GenGraph;
  specId: number;
  cs: number;
  sn: number;
  /** Yaw quaternion (about +y). */
  qy: number;
  qw: number;
  alive: Uint8Array;
  health: Float32Array;
  bondAlive: Uint8Array;
  group: Array<Group | null>;
  collider: Array<RAPIER.Collider | null>;
  handle: Int32Array;
  ext: Float32Array;
  extStamp: Int32Array;
  srcStamp: Int32Array;
  /** Per-step impact (peak contact force, N) on each piece, stamped with the step. */
  impact: Float32Array;
  impactStamp: Int32Array;
  liveBonds: number;
  livePieces: number;
  damaged: Uint8Array;
  /** Last solved 6-DOF displacement of every piece (warm start for the next solve). */
  disp: Float64Array;
}

export interface PooledBody {
  body: RAPIER.RigidBody;
  pooled: boolean;
}

export interface Sim {
  R: typeof RAPIER;
  world: RAPIER.World;
  renderer: DestructionRenderer;
  step: number;
  time: number;
  dt: number;
  /** Gravity magnitude (m/s^2). */
  g: number;
  owners: Map<number, number>;
  groups: Group[];
  buildings: Map<number, Building>;
  solver: StressSolver;
  nextGroupId: number;
  brokenThisStep: number;
  /** Energy (J) absorbed by members crushed in the last solveGroup() call. */
  crushEnergy: number;
  /** Pieces crushed / destroyed by impact energy since start (stats). */
  crushedTotal: number;
  /** Optional debug trace (harness). */
  trace?: (msg: string) => void;
  impactKillsTotal: number;
  /** Pieces baked to rubble at rest / early by the chunk cap (stats). */
  bakedRestTotal: number;
  bakedCapTotal: number;
  acquireBody(): PooledBody;
  releaseBody(b: RAPIER.RigidBody, pooled: boolean): void;
  /** Break piece `i` of `bld` into shards (physics debris + visuals). Pose/velocity given in world space. */
  spawnShards(bld: Building, i: number, pos: Float64Array, quat: Float64Array, vel: Float64Array, ang: Float64Array, push: Float64Array, crushed: boolean): void;
  scratchComp: Int32Array;
  scratchQueue: Int32Array;
  splitQueue: Group[];
}

/**
 * Rapier collision groups ((membership << 16) | filter). Building pieces are their own class so
 * pulverised (crushed) debris can skip them: crushed material cannot carry load, it spills out
 * from under the mass it failed beneath, while it still lands on the ground and other debris.
 */
export const CG_PIECE = (0x0002 << 16) | 0xffff;
export const CG_CRUSHED = (0x0004 << 16) | (0xffff & ~0x0002);

const OWNER_PIECE = 4096;
export const pieceCode = (specId: number, i: number): number => specId * OWNER_PIECE + i;
export const decodePiece = (code: number): { spec: number; piece: number } => ({ spec: Math.floor(code / OWNER_PIECE), piece: code % OWNER_PIECE });
export const SHARD_BASE = 1_000_000;
export const STATIC_BASE = 2_000_000;

// small quaternion helpers writing into module scratch (no allocation)
const _v = new Float64Array(3);
/** Rotate (x,y,z) by quaternion (qx,qy,qz,qw) into _v. */
export function rotate(qx: number, qy: number, qz: number, qw: number, x: number, y: number, z: number): Float64Array {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  _v[0] = x + qw * tx + (qy * tz - qz * ty);
  _v[1] = y + qw * ty + (qz * tx - qx * tz);
  _v[2] = z + qw * tz + (qx * ty - qy * tx);
  return _v;
}

/** World position of piece `i` in its group. */
export function pieceWorld(G: Group, i: number, out: Float64Array, useCur = true): void {
  const c = G.bld.graph.cen;
  const p = useCur ? G.cur : G.prev;
  const r = rotate(p[3], p[4], p[5], p[6], c[i * 3] - G.ox, c[i * 3 + 1] - G.oy, c[i * 3 + 2] - G.oz);
  out[0] = p[0] + r[0]; out[1] = p[1] + r[1]; out[2] = p[2] + r[2];
}

export function readPose(G: Group): void {
  const t = G.body.translation();
  const q = G.body.rotation();
  const c = G.cur;
  c[0] = t.x; c[1] = t.y; c[2] = t.z; c[3] = q.x; c[4] = q.y; c[5] = q.z; c[6] = q.w;
}

// ------------------------------------------------------------------ building state

export function makeBuilding(spec: BuildingSpec, graph: GenGraph): Building {
  const np = graph.pieces.length, nb = graph.bonds.length;
  const half = spec.yaw * 0.5;
  const health = new Float32Array(np);
  for (let i = 0; i < np; i++) health[i] = graph.pieces[i].maxHealth;
  return {
    spec, graph, specId: spec.id,
    cs: Math.cos(spec.yaw), sn: Math.sin(spec.yaw), qy: Math.sin(half), qw: Math.cos(half),
    alive: new Uint8Array(np).fill(1), health, bondAlive: new Uint8Array(nb).fill(1),
    group: new Array<Group | null>(np).fill(null), collider: new Array<RAPIER.Collider | null>(np).fill(null),
    handle: new Int32Array(np).fill(-1),
    ext: new Float32Array(np * 3), extStamp: new Int32Array(np).fill(-1), srcStamp: new Int32Array(np).fill(-1),
    impact: new Float32Array(np), impactStamp: new Int32Array(np).fill(-1),
    liveBonds: nb, livePieces: np, damaged: new Uint8Array(np),
    disp: new Float64Array(np * 6),
  };
}

// ------------------------------------------------------------------ groups and bodies

function addPieceCollider(sim: Sim, bld: Building, i: number, G: Group): void {
  const R = sim.R;
  const p = bld.graph.pieces[i];
  const desc = R.ColliderDesc.cuboid(p.halfExtents[0], p.halfExtents[1], p.halfExtents[2])
    .setTranslation(p.center[0] - G.ox, p.center[1] - G.oy, p.center[2] - G.oz)
    .setMass(p.mass)
    .setFriction(0.8)
    .setRestitution(0.04)
    .setCollisionGroups(CG_PIECE)
    .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
    .setContactForceEventThreshold(p.mass * sim.g * 1.2);
  const c = sim.world.createCollider(desc, G.body);
  bld.collider[i] = c;
  sim.owners.set(c.handle, pieceCode(bld.specId, i));
}

/** Create a group (and its body + colliders) for `pieces`. The body origin is placed at the group's centre of mass. */
export function createGroup(
  sim: Sim, bld: Building, pieces: number[], fixed: boolean,
  // pose of the SOURCE frame: world origin position t, quaternion q, and its building-local origin o
  tx: number, ty: number, tz: number, qx: number, qy: number, qz: number, qw: number, ox: number, oy: number, oz: number,
  lin: Float64Array, ang: Float64Array, comW: Float64Array,
): Group {
  const g = bld.graph;
  let m = 0, cx = 0, cy = 0, cz = 0;
  for (const i of pieces) {
    m += g.mass[i];
    cx += g.mass[i] * g.cen[i * 3]; cy += g.mass[i] * g.cen[i * 3 + 1]; cz += g.mass[i] * g.cen[i * 3 + 2];
  }
  cx /= m; cy /= m; cz /= m;
  // new origin in world
  const r = rotate(qx, qy, qz, qw, cx - ox, cy - oy, cz - oz);
  const nx = tx + r[0], ny = ty + r[1], nz = tz + r[2];
  let body: RAPIER.RigidBody;
  let pooled = false;
  if (fixed) {
    body = sim.world.createRigidBody(sim.R.RigidBodyDesc.fixed().setTranslation(nx, ny, nz).setRotation({ x: qx, y: qy, z: qz, w: qw }));
  } else {
    const pb = sim.acquireBody();
    body = pb.body;
    pooled = pb.pooled;
    body.setTranslation({ x: nx, y: ny, z: nz }, true);
    body.setRotation({ x: qx, y: qy, z: qz, w: qw }, true);
    // v at the new origin = v_cm + w x (origin - comW)
    const rx = nx - comW[0], ry = ny - comW[1], rz = nz - comW[2];
    body.setLinvel({ x: lin[0] + ang[1] * rz - ang[2] * ry, y: lin[1] + ang[2] * rx - ang[0] * rz, z: lin[2] + ang[0] * ry - ang[1] * rx }, true);
    body.setAngvel({ x: ang[0], y: ang[1], z: ang[2] }, true);
  }
  const G: Group = {
    id: sim.nextGroupId++, bld, fixed, body, pooled, pieces, ox: cx, oy: cy, oz: cz, mass: m,
    cur: new Float64Array(7), prev: new Float64Array(7),
    vx: 0, vy: 0, vz: 0, born: sim.time, rest: 0, needsPush: true, dirty: true, hitStep: -1, pendingSplit: false, busy: false, slot: sim.groups.length, live: true,
  };
  for (const i of pieces) {
    addPieceCollider(sim, bld, i, G);
    bld.group[i] = G;
  }
  if (!fixed) {
    const lv = body.linvel();
    G.vx = lv.x; G.vy = lv.y; G.vz = lv.z;
  }
  readPose(G);
  G.prev.set(G.cur);
  sim.groups.push(G);
  return G;
}

export function retireGroup(sim: Sim, G: Group): void {
  if (!G.live) return;
  G.live = false;
  const body = G.body;
  for (const i of G.pieces) {
    const c = G.bld.collider[i];
    if (c) sim.owners.delete(c.handle);
    G.bld.collider[i] = null;
    G.bld.group[i] = null;
  }
  if (G.pooled) sim.releaseBody(body, true);
  else sim.world.removeRigidBody(body);
  const last = sim.groups[sim.groups.length - 1];
  sim.groups[G.slot] = last;
  last.slot = G.slot;
  sim.groups.pop();
}

const _lin = new Float64Array(3), _ang = new Float64Array(3), _com = new Float64Array(3);

/** Recompute connectivity of a group after bonds/pieces were removed; split into bodies as needed. */
export function resplit(sim: Sim, G: Group): void {
  G.pendingSplit = false;
  if (!G.live) return;
  G.busy = true;
  const bld = G.bld, g = bld.graph;
  const comp = sim.scratchComp, queue = sim.scratchQueue;
  const alive: number[] = [];
  for (const i of G.pieces) if (bld.alive[i]) alive.push(i);
  for (const i of alive) comp[i] = -1;
  const comps: number[][] = [];
  const grounded: boolean[] = [];
  for (const s of alive) {
    if (comp[s] >= 0) continue;
    const id = comps.length;
    const list: number[] = [];
    let qh = 0, qt = 0, gnd = false;
    queue[qt++] = s; comp[s] = id;
    while (qh < qt) {
      const i = queue[qh++];
      list.push(i);
      for (let e = g.adjStart[i]; e < g.adjStart[i + 1]; e++) {
        const b = g.adjBond[e];
        if (!bld.bondAlive[b]) continue;
        const j = g.ba[b] === i ? g.bb[b] : g.ba[b];
        if (j < 0) { gnd = true; continue; }
        if (comp[j] < 0 && bld.alive[j]) { comp[j] = id; queue[qt++] = j; }
      }
    }
    comps.push(list);
    grounded.push(gnd);
  }
  if (comps.length === 0) {
    G.busy = false;
    retireGroup(sim, G);
    return;
  }
  if (comps.length === 1 && grounded[0] === G.fixed) {
    G.pieces = comps[0];
    G.dirty = true;
    G.busy = false;
    return;
  }
  // keeper = largest component
  let keep = 0;
  for (let c = 1; c < comps.length; c++) if (comps[c].length > comps[keep].length) keep = c;

  const body = G.body;
  const t = body.translation(), q = body.rotation();
  if (G.fixed) {
    _lin.fill(0); _ang.fill(0);
    _com[0] = t.x; _com[1] = t.y; _com[2] = t.z;
  } else {
    const lv = body.linvel(), av = body.angvel(), wc = body.worldCom();
    _lin[0] = lv.x; _lin[1] = lv.y; _lin[2] = lv.z;
    _ang[0] = av.x; _ang[1] = av.y; _ang[2] = av.z;
    _com[0] = wc.x; _com[1] = wc.y; _com[2] = wc.z;
  }
  const ox = G.ox, oy = G.oy, oz = G.oz;
  const lin0 = _lin.slice(), ang0 = _ang.slice(), com0 = _com.slice();

  for (let c = 0; c < comps.length; c++) {
    if (c === keep) continue;
    for (const i of comps[c]) {
      const col = bld.collider[i];
      if (col) { sim.owners.delete(col.handle); sim.world.removeCollider(col, false); }
      bld.collider[i] = null;
      bld.group[i] = null;
    }
    createGroup(sim, bld, comps[c], grounded[c], t.x, t.y, t.z, q.x, q.y, q.z, q.w, ox, oy, oz, lin0, ang0, com0);
  }
  // pieces destroyed earlier are already detached; rebuild the keeper's list and mass
  G.pieces = comps[keep];
  let m = 0, cx = 0, cy = 0, cz = 0;
  for (const i of G.pieces) {
    m += g.mass[i];
    cx += g.mass[i] * g.cen[i * 3]; cy += g.mass[i] * g.cen[i * 3 + 1]; cz += g.mass[i] * g.cen[i * 3 + 2];
  }
  G.mass = m;
  if (G.fixed && !grounded[keep]) {
    body.setBodyType(sim.R.RigidBodyType.Dynamic, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    G.fixed = false;
    G.vx = G.vy = G.vz = 0;
    G.rest = 0;
  } else if (!G.fixed) {
    // the centre of mass moved when colliders were removed; keep the velocity field continuous
    cx /= m; cy /= m; cz /= m;
    const r = rotate(q.x, q.y, q.z, q.w, cx - ox, cy - oy, cz - oz);
    const rx = t.x + r[0] - com0[0], ry = t.y + r[1] - com0[1], rz = t.z + r[2] - com0[2];
    const nv = { x: lin0[0] + ang0[1] * rz - ang0[2] * ry, y: lin0[1] + ang0[2] * rx - ang0[0] * rz, z: lin0[2] + ang0[0] * ry - ang0[1] * rx };
    body.setLinvel(nv, true);
    G.vx = nv.x; G.vy = nv.y; G.vz = nv.z;
  }
  G.needsPush = true;
  G.dirty = true;
  G.busy = false;
}

export function flushSplits(sim: Sim): void {
  // resplit may enqueue more (it never does today) so index loop
  for (let k = 0; k < sim.splitQueue.length; k++) resplit(sim, sim.splitQueue[k]);
  sim.splitQueue.length = 0;
}

export function queueSplit(sim: Sim, G: Group): void {
  if (!G.pendingSplit) {
    G.pendingSplit = true;
    sim.splitQueue.push(G);
  }
}

/** Kill bond `b` (no-op if already dead) and queue its group for a split check. */
export function killBond(sim: Sim, bld: Building, b: number): void {
  if (!bld.bondAlive[b]) return;
  bld.bondAlive[b] = 0;
  bld.liveBonds--;
  sim.brokenThisStep++;
  const g = bld.graph;
  const G = bld.group[g.ba[b]];
  if (G) queueSplit(sim, G);
}

const _p = new Float64Array(3), _q = new Float64Array(4), _vel = new Float64Array(3), _av = new Float64Array(3);

/**
 * Destroy a piece: remove it from its body, turn it into shards, drop its bonds. `push` is an extra
 * velocity (m/s). `crushed`: it failed in compression, so its shards are pulverised (see CG_CRUSHED).
 */
export function destroyPiece(sim: Sim, bld: Building, i: number, push: Float64Array, crushed = false): void {
  if (!bld.alive[i]) return;
  const G = bld.group[i];
  const g = bld.graph;
  if (G) {
    pieceWorld(G, i, _p);
    const c = G.cur;
    _q[0] = c[3]; _q[1] = c[4]; _q[2] = c[5]; _q[3] = c[6];
    if (G.fixed) {
      _vel.fill(0); _av.fill(0);
    } else {
      const lv = G.body.linvel(), av = G.body.angvel(), wc = G.body.worldCom();
      const rx = _p[0] - wc.x, ry = _p[1] - wc.y, rz = _p[2] - wc.z;
      _vel[0] = lv.x + av.y * rz - av.z * ry;
      _vel[1] = lv.y + av.z * rx - av.x * rz;
      _vel[2] = lv.z + av.x * ry - av.y * rx;
      _av[0] = av.x; _av[1] = av.y; _av[2] = av.z;
    }
    const col = bld.collider[i];
    if (col) { sim.owners.delete(col.handle); sim.world.removeCollider(col, false); }
    bld.collider[i] = null;
    bld.group[i] = null;
  } else {
    _p[0] = bld.spec.x; _p[1] = g.cen[i * 3 + 1]; _p[2] = bld.spec.z;
    _q[0] = 0; _q[1] = bld.qy; _q[2] = 0; _q[3] = bld.qw;
    _vel.fill(0); _av.fill(0);
  }
  bld.alive[i] = 0;
  bld.livePieces--;
  for (let e = g.adjStart[i]; e < g.adjStart[i + 1]; e++) {
    const b = g.adjBond[e];
    if (bld.bondAlive[b]) { bld.bondAlive[b] = 0; bld.liveBonds--; sim.brokenThisStep++; }
  }
  const h = bld.handle[i];
  bld.handle[i] = -1;
  sim.spawnShards(bld, i, _p, _q, _vel, _av, push, crushed);
  if (h >= 0) sim.renderer.remove(h as RenderHandle);
  if (G) queueSplit(sim, G);
}

// ------------------------------------------------------------------ stress step for one group

const _gl = new Float64Array(3);

/**
 * Solve the group's bond loads and break the overloaded ones.
 * (gx,gy,gz): apparent gravity in the building frame. Returns the number of bonds broken, or -1 if
 * the solve did not converge within `maxIter` (the warm start keeps the progress; call again).
 */
export function solveGroup(sim: Sim, G: Group, gx: number, gy: number, gz: number, strengthScale: number, useExt: boolean, maxIter: number): number {
  const bld = G.bld;
  const s = sim.solver;
  const np = G.pieces.length;
  if (np === 0) return 0;
  const res = s.solve(bld.graph, bld.alive, bld.bondAlive, G.pieces, np, gx, gy, gz, G.fixed, bld.srcStamp, sim.step, useExt ? bld.ext : null, strengthScale, bld.disp, maxIter, SOLVE_TOL);
  // A fixed group can wait for its solve to finish over the next steps. A loose body's load is a
  // transient (a landing lasts a step or two), so a nearly converged answer now beats none.
  if (sim.trace && !G.fixed) sim.trace(`solve g${G.id} ${np}p k=(${gx.toFixed(1)},${gy.toFixed(1)},${gz.toFixed(1)}) it ${res.iterations} res ${res.residual.toExponential(1)} max ${s.maxUtil.toFixed(2)} bonds ${s.nBonds}`);
  if (!res.converged && (G.fixed || res.residual > LOOSE_TOL)) return -1;
  const n = s.selectBreaks();
  const g = bld.graph;
  sim.crushEnergy = 0;
  for (let k = 0; k < n; k++) {
    const b = s.over[k];
    if (!bld.bondAlive[b]) continue;
    if (s.crush[b] >= CRUSH_FRACTION) {
      // Compressive failure crushes the member: the lighter of the two pieces (the column or wall,
      // not the slab it carries; always the piece for a ground bond) breaks up into rubble, and
      // whatever it held drops onto what is left.
      const a = g.ba[b], c = g.bb[b];
      const victim = c < 0 || g.mass[a] <= g.mass[c] ? a : c;
      if (!bld.alive[victim]) continue;
      // work done crushing it: the bond's capacity over the member's length along the load
      const ax = Math.abs(g.dir[b * 3]) > 0.5 ? 0 : Math.abs(g.dir[b * 3 + 1]) > 0.5 ? 1 : 2;
      sim.crushEnergy += config.destruction.crushWork * g.fcap[b] * strengthScale * 2 * g.pieces[victim].halfExtents[ax];
      sim.crushedTotal++;
      destroyPiece(sim, bld, victim, _zero3, true);
    } else {
      killBond(sim, bld, b);
    }
  }
  return n;
}

/** Bonds that fail with at least this fraction of their load in compression crush a piece. */
const CRUSH_FRACTION = 0.5;
const _zero3 = new Float64Array(3);

/** Relative residual at which a stress solve counts as converged. */
export const SOLVE_TOL = 1e-4;
/** Residual a loose (landing) body's solve may stop at and still be acted on. */
const LOOSE_TOL = 0.02;

export function gravityInFrame(G: Group, wx: number, wy: number, wz: number): Float64Array {
  // building frame == body frame; world -> body: inverse rotation
  const c = G.cur;
  const r = rotate(-c[3], -c[4], -c[5], c[6], wx, wy, wz);
  _gl[0] = r[0]; _gl[1] = r[1]; _gl[2] = r[2];
  return _gl;
}
