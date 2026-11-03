// Bonds, the load/moment solver, breaking, and group splitting.
//
// Rapier 0.21 has no joint-force read-back, so connected pieces share ONE rigid body (a compound of
// box colliders with true masses) and bond stress is computed from real weight:
//   - Load flows from every piece "downhill" along the bond graph towards its supports (the ground
//     for a fixed group, the pieces in contact for a falling one). Each piece splits its carried load
//     over its supporting bonds like a rigid plate on elastic supports (force + moment balance), so
//     an overhang or a lopsided support set puts real shear, tension and bending on the bonds.
//   - A falling group feels an apparent gravity (g minus its measured acceleration), so a floor that
//     lands carries many times its weight and the stack breaks from the contact up: pancaking.
//   - A bond whose utilisation (compression + tension + shear + bending) reaches 1 breaks. When bonds
//     break the group is split into connected components; each becomes its own body with the
//     velocity of the old body at its centre of mass. A component with a ground bond stays fixed,
//     anything else is dynamic and falls under Rapier's gravity.

import type RAPIER from '@dimforge/rapier3d-compat';
import type { BuildingSpec } from '../city/town-layout';
import type { DestructionRenderer, RenderHandle } from './types';
import type { GenGraph } from './building-gen';

// ------------------------------------------------------------------ stress solver

const DELTA2 = 0.25 * 0.25;
/** Design target: the intact building uses this fraction of every bond's limit. */
const DESIGN_UTIL = 0.35;

export class StressSolver {
  P = new Float64Array(0);
  Q = new Float64Array(0);
  E = new Float64Array(0);
  d = new Int32Array(0);
  order = new Int32Array(0);
  util = new Float32Array(0);
  over = new Int32Array(0);
  overD = new Int32Array(0);
  nOver = 0;
  private ob = new Int32Array(1024);
  private ow = new Float64Array(1024);

  ensure(np: number, nb: number): void {
    if (this.P.length < np) {
      const n = Math.max(np, 64);
      this.P = new Float64Array(n);
      this.Q = new Float64Array(n * 3);
      this.E = new Float64Array(n * 3);
      this.d = new Int32Array(n);
      this.order = new Int32Array(n);
    }
    if (this.util.length < nb) {
      const n = Math.max(nb, 128);
      this.util = new Float32Array(n);
      this.over = new Int32Array(n);
      this.overD = new Int32Array(n);
    }
  }

  /**
   * Solve the load on every bond of the pieces in `list`. (gx,gy,gz) is the apparent gravity in the
   * building frame. `fixed`: sources are pieces with a live ground bond; otherwise pieces whose
   * srcStamp equals `stamp`. Fills util[] and (if `record`) over[]/overD[].
   */
  solve(
    G: GenGraph, pAlive: Uint8Array, bAlive: Uint8Array, list: ArrayLike<number>, n: number,
    gx: number, gy: number, gz: number, fixed: boolean,
    srcStamp: Int32Array | null, stamp: number, ext: Float32Array | null, scale: number, record: boolean,
  ): void {
    this.nOver = 0;
    const { P, Q, E, d, order, util } = this;
    const { ba, bb, anchor, dir, fcap, mcap, tfrac, sfrac, adjStart, adjBond, cen, mass, cladding } = G;
    let qn = 0;
    for (let k = 0; k < n; k++) d[list[k]] = -1;
    for (let k = 0; k < n; k++) {
      const i = list[k];
      if (!pAlive[i]) continue;
      if (fixed) {
        for (let e = adjStart[i]; e < adjStart[i + 1]; e++) {
          const b = adjBond[e];
          if (bAlive[b] && bb[b] < 0) { d[i] = 0; order[qn++] = i; break; }
        }
      } else if (srcStamp![i] === stamp) {
        d[i] = 0;
        order[qn++] = i;
      }
    }
    if (qn === 0) return;
    for (let head = 0; head < qn; head++) {
      const i = order[head];
      for (let e = adjStart[i]; e < adjStart[i + 1]; e++) {
        const b = adjBond[e];
        if (!bAlive[b]) continue;
        const j = ba[b] === i ? bb[b] : ba[b];
        if (j >= 0 && pAlive[j] && d[j] < 0) { d[j] = d[i] + 1; order[qn++] = j; }
      }
    }
    const gm = Math.hypot(gx, gy, gz);
    let hx = 0, hy = -1, hz = 0;
    if (gm > 1e-6) { hx = gx / gm; hy = gy / gm; hz = gz / gm; }
    // plane basis perpendicular to the load direction
    let tx = 1, ty = 0, tz = 0;
    if (Math.abs(hx) > 0.9) { tx = 0; ty = 1; }
    let u1x = ty * hz - tz * hy, u1y = tz * hx - tx * hz, u1z = tx * hy - ty * hx;
    const ul = Math.hypot(u1x, u1y, u1z);
    u1x /= ul; u1y /= ul; u1z /= ul;
    const u2x = hy * u1z - hz * u1y, u2y = hz * u1x - hx * u1z, u2z = hx * u1y - hy * u1x;

    for (let k = 0; k < qn; k++) {
      const i = order[k];
      let p = mass[i] * gm;
      let ex = 0, ey = 0, ez = 0;
      if (ext) {
        const fx = ext[i * 3], fy = ext[i * 3 + 1], fz = ext[i * 3 + 2];
        const pe = fx * hx + fy * hy + fz * hz;
        p += pe;
        ex = fx - pe * hx; ey = fy - pe * hy; ez = fz - pe * hz;
      }
      P[i] = p;
      Q[i * 3] = p * cen[i * 3]; Q[i * 3 + 1] = p * cen[i * 3 + 1]; Q[i * 3 + 2] = p * cen[i * 3 + 2];
      E[i * 3] = ex; E[i * 3 + 1] = ey; E[i * 3 + 2] = ez;
    }

    const ob = this.ob, ow = this.ow;
    for (let k = qn - 1; k >= 0; k--) {
      const i = order[k];
      if (!fixed && d[i] === 0) continue;
      let nOut = 0, sw = 0;
      for (let e = adjStart[i]; e < adjStart[i + 1]; e++) {
        const b = adjBond[e];
        if (!bAlive[b]) continue;
        const j = ba[b] === i ? bb[b] : ba[b];
        const out = j < 0 ? fixed && d[i] === 0 : pAlive[j] === 1 && d[j] >= 0 && d[j] < d[i];
        if (!out || nOut >= 1024) continue;
        const dd = Math.abs(dir[b * 3] * hx + dir[b * 3 + 1] * hy + dir[b * 3 + 2] * hz);
        let w = fcap[b] * (0.25 + 0.75 * dd);
        // structure does not hand its load to non-structural cladding (unless nothing else is left)
        if (j >= 0 && cladding[j] === 1 && cladding[i] === 0) w *= 0.001;
        ob[nOut] = b; ow[nOut] = w; nOut++; sw += w;
      }
      if (nOut === 0) continue;
      const Pi = P[i];
      let lx = cen[i * 3], ly = cen[i * 3 + 1], lz = cen[i * 3 + 2];
      if (Pi > 1e-9) { lx = Q[i * 3] / Pi; ly = Q[i * 3 + 1] / Pi; lz = Q[i * 3 + 2] / Pi; }
      let cx = 0, cy = 0, cz = 0;
      for (let q = 0; q < nOut; q++) {
        const b = ob[q], w = ow[q];
        cx += w * anchor[b * 3]; cy += w * anchor[b * 3 + 1]; cz += w * anchor[b * 3 + 2];
      }
      cx /= sw; cy /= sw; cz /= sw;
      const ex = lx - cx, ey = ly - cy, ez = lz - cz;
      const e1 = ex * u1x + ey * u1y + ez * u1z;
      const e2 = ex * u2x + ey * u2y + ez * u2z;
      let i11 = sw * DELTA2, i12 = 0, i22 = sw * DELTA2;
      for (let q = 0; q < nOut; q++) {
        const b = ob[q], w = ow[q];
        const ax = anchor[b * 3] - cx, ay = anchor[b * 3 + 1] - cy, az = anchor[b * 3 + 2] - cz;
        const a1 = ax * u1x + ay * u1y + az * u1z;
        const a2 = ax * u2x + ay * u2y + az * u2z;
        i11 += w * a1 * a1; i12 += w * a1 * a2; i22 += w * a2 * a2;
      }
      const det = i11 * i22 - i12 * i12;
      const be1 = (i22 * Pi * e1 - i12 * Pi * e2) / det;
      const be2 = (-i12 * Pi * e1 + i11 * Pi * e2) / det;
      // Rigid-plate reactions, and the moment the reactions could not balance.
      let r1 = Pi * e1, r2 = Pi * e2;
      const Rk = this.ow2(nOut);
      for (let q = 0; q < nOut; q++) {
        const b = ob[q], w = ow[q];
        const ax = anchor[b * 3] - cx, ay = anchor[b * 3 + 1] - cy, az = anchor[b * 3 + 2] - cz;
        const a1 = ax * u1x + ay * u1y + az * u1z;
        const a2 = ax * u2x + ay * u2y + az * u2z;
        const R = w * (Pi / sw + be1 * a1 + be2 * a2);
        Rk[q] = R;
        r1 -= R * a1; r2 -= R * a2;
      }
      const mres = Math.hypot(r1, r2);
      const eix = E[i * 3], eiy = E[i * 3 + 1], eiz = E[i * 3 + 2];
      for (let q = 0; q < nOut; q++) {
        const b = ob[q], w = ow[q];
        const R = Rk[q];
        const fr = w / sw;
        const fx = R * hx + eix * fr, fy = R * hy + eiy * fr, fz = R * hz + eiz * fr;
        const sgn = ba[b] === i ? 1 : -1;
        const dx = dir[b * 3] * sgn, dy = dir[b * 3 + 1] * sgn, dz = dir[b * 3 + 2] * sgn;
        const fn = fx * dx + fy * dy + fz * dz;
        const ft = Math.sqrt(Math.max(0, fx * fx + fy * fy + fz * fz - fn * fn));
        const cap = fcap[b] * scale;
        const mc = mcap[b] * scale;
        const u = (fn >= 0 ? fn / cap : -fn / (cap * tfrac[b])) + ft / (cap * sfrac[b]) + (mres * fr) / mc;
        util[b] = u;
        if (record && u >= 1) {
          this.over[this.nOver] = b;
          this.overD[this.nOver] = d[i];
          this.nOver++;
        }
        const j = ba[b] === i ? bb[b] : ba[b];
        if (j >= 0) {
          P[j] += R;
          Q[j * 3] += R * anchor[b * 3]; Q[j * 3 + 1] += R * anchor[b * 3 + 1]; Q[j * 3 + 2] += R * anchor[b * 3 + 2];
          E[j * 3] += eix * fr; E[j * 3 + 1] += eiy * fr; E[j * 3 + 2] += eiz * fr;
        }
      }
    }
  }

  private rk = new Float64Array(1024);
  private ow2(_n: number): Float64Array {
    return this.rk;
  }

  /** Keep only overloaded bonds at the failure front (smallest distance from the supports, plus one). */
  frontier(band: number): number {
    if (this.nOver === 0) return 0;
    let dmin = 1e9;
    for (let k = 0; k < this.nOver; k++) if (this.overD[k] < dmin) dmin = this.overD[k];
    let m = 0;
    for (let k = 0; k < this.nOver; k++) {
      if (this.overD[k] <= dmin + band) this.over[m++] = this.over[k];
    }
    this.nOver = m;
    return m;
  }
}

const designSolver = new StressSolver();

/** Size every bond so the intact building carries its own weight at DESIGN_UTIL. Returns iterations used. */
export function designBonds(G: GenGraph): number {
  const np = G.pieces.length, nb = G.bonds.length;
  designSolver.ensure(np, nb);
  const pAlive = new Uint8Array(np).fill(1);
  const bAlive = new Uint8Array(nb).fill(1);
  const list = new Int32Array(np);
  for (let i = 0; i < np; i++) list[i] = i;
  let it = 0;
  for (; it < 8; it++) {
    designSolver.util.fill(0, 0, nb);
    designSolver.solve(G, pAlive, bAlive, list, np, 0, -9.81, 0, true, null, 0, null, 1, false);
    let changed = false;
    for (let b = 0; b < nb; b++) {
      const u = designSolver.util[b];
      if (u > DESIGN_UTIL * 1.02) {
        const f = u / DESIGN_UTIL;
        G.fcap[b] *= f;
        G.mcap[b] *= f;
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (let b = 0; b < nb; b++) {
    G.bonds[b].maxForce = G.fcap[b];
    G.bonds[b].maxMoment = G.mcap[b];
  }
  return it;
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
  acquireBody(): PooledBody;
  releaseBody(b: RAPIER.RigidBody, pooled: boolean): void;
  /** Break piece `i` of `bld` into shards (physics debris + visuals). Pose/velocity given in world space. */
  spawnShards(bld: Building, i: number, pos: Float64Array, quat: Float64Array, vel: Float64Array, ang: Float64Array, push: Float64Array): void;
  scratchComp: Int32Array;
  scratchQueue: Int32Array;
  splitQueue: Group[];
}

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

/** Destroy a piece: remove it from its body, turn it into shards, drop its bonds. `push` is an extra velocity (m/s). */
export function destroyPiece(sim: Sim, bld: Building, i: number, push: Float64Array): void {
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
  sim.spawnShards(bld, i, _p, _q, _vel, _av, push);
  if (h >= 0) sim.renderer.remove(h as RenderHandle);
  if (G) queueSplit(sim, G);
}

// ------------------------------------------------------------------ stress step for one group

const _gl = new Float64Array(3);

/**
 * Solve the group's bond loads and break the overloaded ones at the failure front.
 * (gx,gy,gz): apparent gravity in the building frame. Returns number of bonds broken.
 */
export function solveGroup(sim: Sim, G: Group, gx: number, gy: number, gz: number, strengthScale: number, useExt: boolean): number {
  const bld = G.bld;
  const s = sim.solver;
  const np = G.pieces.length;
  if (np === 0) return 0;
  s.solve(bld.graph, bld.alive, bld.bondAlive, G.pieces, np, gx, gy, gz, G.fixed, bld.srcStamp, sim.step, useExt ? bld.ext : null, strengthScale, true);
  const n = s.frontier(1);
  for (let k = 0; k < n; k++) killBond(sim, bld, s.over[k]);
  return n;
}

export function gravityInFrame(G: Group, wx: number, wy: number, wz: number): Float64Array {
  // building frame == body frame; world -> body: inverse rotation
  const c = G.cur;
  const r = rotate(-c[3], -c[4], -c[5], c[6], wx, wy, wz);
  _gl[0] = r[0]; _gl[1] = r[1]; _gl[2] = r[2];
  return _gl;
}
