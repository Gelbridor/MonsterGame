// BuildingSpec -> BuildingGraph: a floors x bays grid of box pieces (columns, slabs, wall panels,
// windows, roof) with real masses, joined by bonds found from touching faces.
//
// Detail follows the quality tier's bond budget (ultra ~800 down to ~100 on phones): the generator
// picks the finest candidate (bay size, floors merged per structural level) that fits the budget.
// Bond limits are then "designed": the intact building is run through the real stress solver and
// every bond is sized so it carries its own load with a safety factor, so an untouched building
// stands and a damaged one fails by redistribution rather than by a scripted rule.

import type { BuildingSpec } from '../city/town-layout';
import type { QualityLevel } from '../core/types';
import type { BondDef, BuildingGraph, DMaterial, PieceDef, PieceKind } from './types';
import { KIND_FILL, KIND_HEALTH, MATERIALS, materialForSpec } from './materials';
import { designBonds } from './joints';

/** Graph plus flat typed arrays the solver reads (no per-step allocation). */
export interface GenGraph extends BuildingGraph {
  /** Piece centres, xyz triplets (building-local). */
  cen: Float64Array;
  mass: Float64Array;
  /** 1 for non-structural cladding. */
  cladding: Uint8Array;
  ba: Int32Array;
  bb: Int32Array;
  /** Bond anchors, xyz triplets. */
  anchor: Float64Array;
  /** Unit vector from piece a towards b (down for ground bonds). */
  dir: Float64Array;
  /** Design-sized limits (kept flat for the solver; mirrored into bonds[i]). */
  fcap: Float64Array;
  mcap: Float64Array;
  tfrac: Float32Array;
  sfrac: Float32Array;
  /** CSR adjacency: bonds touching each piece (ground bonds listed under piece a). */
  adjStart: Int32Array;
  adjBond: Int32Array;
  groundBonds: number;
  info: { bay: number; group: number; levels: number; designIters: number };
}

const BOND_BUDGET: Record<QualityLevel, number> = { ultra: 800, high: 500, medium: 150, low: 100 };
/** Rough bonds-per-piece ratio of the grid layout, used to pick a candidate before bonding. */
const BONDS_PER_PIECE = 2.6;

interface Params {
  bay: number;
  group: number;
  splitSill: boolean;
  interior: boolean;
}

interface Box {
  x0: number; x1: number; y0: number; y1: number; z0: number; z1: number;
}

class Builder {
  pieces: PieceDef[] = [];
  clad: number[] = [];
  excl: Box[] = [];
  constructor(private specId: number) {}

  add(kind: PieceKind, material: DMaterial, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, floor: number, clad = false, force = false): void {
    if (hx < 0.02 || hy < 0.02 || hz < 0.02) return;
    if (!force) {
      for (const e of this.excl) {
        if (cx + hx > e.x0 + 0.05 && cx - hx < e.x1 - 0.05 && cy + hy > e.y0 + 0.05 && cy - hy < e.y1 - 0.05 && cz + hz > e.z0 + 0.05 && cz - hz < e.z1 - 0.05) return;
      }
    }
    const m = MATERIALS[material];
    const index = this.pieces.length;
    this.pieces.push({
      index, kind, material,
      center: [cx, cy, cz], halfExtents: [hx, hy, hz],
      mass: m.density * KIND_FILL[kind] * 8 * hx * hy * hz,
      maxHealth: m.health * KIND_HEALTH[kind],
      floor,
      seed: (this.specId * 100003 + index * 7919) >>> 0,
    });
    this.clad.push(clad ? 1 : 0);
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function isFrame(spec: BuildingSpec): boolean {
  return spec.type === 'tower' || spec.type === 'office' || spec.type === 'carPark';
}

type ExtraFn = (k: PieceKind, m: DMaterial, lx: number, by: number, lz: number, w: number, h: number, d: number) => void;

function stackTower(lx: number, lz: number, w: number, h: number, lh: number, mat: DMaterial, extra: ExtraFn): void {
  const n = Math.max(1, Math.round(h / Math.max(lh, 6)));
  for (let i = 0; i < n; i++) extra('wall', mat, lx, (i * h) / n, lz, w, h / n, w);
}

function layout(spec: BuildingSpec, prm: Params, B: Builder): void {
  const W = spec.width, D = spec.depth, H = spec.height;
  const frame = isFrame(spec);
  const floorsN = Math.max(1, spec.floors);
  const group = Math.min(prm.group, floorsN);
  const K = Math.ceil(floorsN / group);
  const lh = H / K;
  const nx = Math.max(1, Math.round(W / prm.bay));
  const nz = Math.max(1, Math.round(D / prm.bay));
  const t = clamp(lh * 0.09, 0.22, 0.5);
  const hh = lh - t;
  const wallMat = materialForSpec(spec.material);
  const curtain = wallMat === 'glass' || wallMat === 'steel';
  const faceMat: DMaterial = curtain ? 'glass' : wallMat === 'wood' ? 'brick' : wallMat;
  const structMat: DMaterial = wallMat === 'steel' ? 'steel' : 'concrete';
  const openDeck = spec.type === 'carPark';

  // Exclusion volume for the tall towers of the town hall / church (their box replaces the grid there).
  const hasTower = spec.type === 'townHall' || spec.type === 'church';
  const tz = spec.type === 'townHall' ? D / 2 - 6 : -D / 2 + 4.5;
  const towerH = spec.type === 'townHall' ? 42 : 26;
  const towerW = spec.type === 'townHall' ? 10 : 9;
  if (hasTower) B.excl.push({ x0: -towerW / 2, x1: towerW / 2, y0: 0, y1: towerH, z0: tz - towerW / 2, z1: tz + towerW / 2 });

  const xs: number[] = [];
  for (let i = 0; i <= nx; i++) xs.push(-W / 2 + (i * W) / nx);
  const zs: number[] = [];
  for (let j = 0; j <= nz; j++) zs.push(-D / 2 + (j * D) / nz);

  const s = frame ? clamp(0.45 + 0.04 * floorsN, 0.5, 0.42 * Math.min(W / nx, D / nz)) : 0;
  const cxs = xs.map((x, i) => (i === 0 ? x + s / 2 : i === nx ? x - s / 2 : x));
  const czs = zs.map((z, j) => (j === 0 ? z + s / 2 : j === nz ? z - s / 2 : z));
  const th = frame ? Math.min(0.3, s * 0.8) : clamp(0.35 + 0.004 * H, 0.4, 0.6);

  for (let k = 0; k < K; k++) {
    const y0 = k * lh;
    const floor = Math.floor((k * floorsN) / K);
    const top = k === K - 1;

    // slabs (one per cell); the top level is the roof deck
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        B.add(top ? 'roof' : 'slab', top && !frame ? 'wood' : structMat,
          (xs[i] + xs[i + 1]) / 2, y0 + lh - t / 2, (zs[j] + zs[j + 1]) / 2,
          (xs[i + 1] - xs[i]) / 2, t / 2, (zs[j + 1] - zs[j]) / 2, floor);
      }
    }

    if (frame) {
      for (let i = 0; i <= nx; i++) {
        for (let j = 0; j <= nz; j++) {
          const perim = i === 0 || i === nx || j === 0 || j === nz;
          if (!perim && !prm.interior) continue;
          B.add('column', structMat, cxs[i], y0 + hh / 2, czs[j], s / 2, hh / 2, s / 2, floor);
        }
      }
    }

    // One facade segment on an edge. alongX: N/S faces (run along x), else E/W faces (run along z).
    const seg = (alongX: boolean, side: number, idx: number, a0: number, a1: number, longFace: boolean): void => {
      if (a1 - a0 < 0.1) return;
      let mid = (a0 + a1) / 2, half = (a1 - a0) / 2;
      const put = (cy: number, hy: number, ht: number, kind: PieceKind, mat: DMaterial, clad: boolean): void => {
        if (alongX) B.add(kind, mat, mid, cy, side * (D / 2 - th / 2), half, hy, ht, floor, clad);
        else B.add(kind, mat, side * (W / 2 - th / 2), cy, mid, ht, hy, half, floor, clad);
      };
      if (openDeck) {
        put(y0 + lh + 0.5, 0.5, th / 2, 'wall', 'concrete', true);
        return;
      }
      let window = curtain;
      if (!curtain && (frame || longFace)) window = (idx + k) % 2 === 1;
      if (!window) {
        put(y0 + hh / 2, hh / 2, th / 2, 'wall', faceMat, frame);
        return;
      }
      if (!frame && !curtain) {
        // masonry: the window sits between two wall piers, so load always has a masonry path
        const pier = Math.max(0.5, (a1 - a0) * 0.22);
        const m0 = (a0 + a1) / 2, h0 = (a1 - a0) / 2;
        mid = a0 + pier / 2; half = pier / 2;
        put(y0 + hh / 2, hh / 2, th / 2, 'wall', faceMat, false);
        mid = a1 - pier / 2;
        put(y0 + hh / 2, hh / 2, th / 2, 'wall', faceMat, false);
        mid = m0; half = h0 - pier;
      }
      if (!curtain && prm.splitSill) {
        const sh = hh * 0.38;
        put(y0 + sh / 2, sh / 2, th / 2, 'wall', faceMat, frame);
        put(y0 + sh + (hh - sh) / 2, (hh - sh) / 2, 0.06, 'window', 'glass', true);
      } else {
        put(y0 + hh / 2, hh / 2, 0.06, 'window', 'glass', true);
      }
    };

    for (const side of [-1, 1]) {
      for (let i = 0; i < nx; i++) {
        const a0 = frame ? cxs[i] + s / 2 : xs[i];
        const a1 = frame ? cxs[i + 1] - s / 2 : xs[i + 1];
        seg(true, side, i, a0, a1, W >= D);
      }
      for (let j = 0; j < nz; j++) {
        const a0 = frame ? czs[j] + s / 2 : j === 0 ? zs[0] + th : zs[j];
        const a1 = frame ? czs[j + 1] - s / 2 : j === nz - 1 ? zs[nz] - th : zs[j + 1];
        seg(false, side, j, a0, a1, W < D);
      }
    }
  }

  // Roof / plant / tower extras: the same boxes the sleeping building's colliders use.
  const extra: ExtraFn = (kind, mat, lx, baseY, lz, w, h, d) => {
    B.add(kind, mat, lx, baseY + h / 2, lz, w / 2, h / 2, d / 2, floorsN - 1, false, true);
  };
  switch (spec.type) {
    case 'terrace':
    case 'cornerShop': {
      const alongX = W >= D;
      extra('roof', 'wood', 0, H, 0, alongX ? W + 0.4 : W * 0.7, 2.4, alongX ? D * 0.7 : D + 0.4);
      break;
    }
    case 'tower':
      extra('roof', 'concrete', 0, H, 0, 7, 3.5, 7);
      break;
    case 'office':
      extra('roof', 'concrete', 0, H, 0, W * 0.45, 3, D * 0.45);
      break;
    case 'carPark':
      extra('roof', 'concrete', -W / 2 + 5, H, -D / 2 + 5, 7, 3.5, 7);
      break;
    case 'substation':
      extra('roof', 'concrete', 0, H, 0, W + 0.6, 0.4, D + 0.6);
      break;
    case 'townHall':
      extra('roof', 'stone', 0, H, 0, W + 1, 1.2, D + 1);
      stackTower(0, tz, towerW, towerH, lh, 'stone', extra);
      extra('roof', 'stone', 0, towerH, tz, 5, 6, 5);
      break;
    case 'church':
      extra('roof', 'wood', 0, H, 0, W * 0.75, 4.5, D);
      stackTower(0, tz, towerW, towerH, lh, 'stone', extra);
      for (const [hw, y0, hgt] of [[3.2, 26, 6], [2.2, 32, 6], [1.2, 38, 6]] as const) extra('roof', 'stone', 0, y0, tz, hw * 2, hgt, hw * 2);
      break;
    default:
      break;
  }
}

/** Candidates, most detailed first. */
const CAND: Params[] = [];
for (const group of [1, 2, 3, 4, 6, 8, 12]) {
  for (const bay of [3.2, 4.2, 5.5, 7, 9, 12, 16, 24]) {
    CAND.push({ bay, group, splitSill: bay <= 4.2 && group === 1, interior: bay <= 5.5 && group <= 2 });
  }
}

function pieceCount(spec: BuildingSpec, prm: Params): number {
  const B = new Builder(spec.id);
  layout(spec, prm, B);
  return B.pieces.length;
}

export function generateBuilding(spec: BuildingSpec, level: QualityLevel): GenGraph | null {
  if (spec.type === 'gasholder') return null;
  const budget = BOND_BUDGET[level];
  let idx = CAND.length - 1;
  for (let i = 0; i < CAND.length; i++) {
    if (pieceCount(spec, CAND[i]) * BONDS_PER_PIECE <= budget) {
      idx = i;
      break;
    }
  }
  let g = build(spec, CAND[idx], false);
  // The estimate can be off; step coarser while clearly over budget.
  while (g.bonds.length > budget * 1.25 && idx < CAND.length - 1) {
    idx++;
    g = build(spec, CAND[idx], false);
  }
  designBonds(g);
  return g;
}

function build(spec: BuildingSpec, prm: Params, design: boolean): GenGraph {
  const B = new Builder(spec.id);
  layout(spec, prm, B);
  const pieces = B.pieces;
  const np = pieces.length;
  const frame = isFrame(spec);

  const cen = new Float64Array(np * 3);
  const mass = new Float64Array(np);
  const cladding = Uint8Array.from(B.clad);
  for (let i = 0; i < np; i++) {
    cen[i * 3] = pieces[i].center[0];
    cen[i * 3 + 1] = pieces[i].center[1];
    cen[i * 3 + 2] = pieces[i].center[2];
    mass[i] = pieces[i].mass;
  }

  const bonds: BondDef[] = [];
  const baL: number[] = [], bbL: number[] = [], anc: number[] = [], dirL: number[] = [], tf: number[] = [], sf: number[] = [];
  const push = (a: number, b: number, ax: number, ay: number, az: number, area: number, dx: number, dy: number, dz: number, ma: DMaterial, mb: DMaterial | null): void => {
    const A = MATERIALS[ma];
    const Bm = mb ? MATERIALS[mb] : A;
    let strength = Math.min(A.strength, Bm.strength);
    if (frame && (cladding[a] || (b >= 0 && cladding[b]))) strength *= 0.1;
    const maxForce = strength * area;
    const maxMoment = maxForce * 0.2 * Math.sqrt(area);
    bonds.push({ a, b, anchor: [ax, ay, az], area, maxForce, maxMoment });
    baL.push(a); bbL.push(b); anc.push(ax, ay, az); dirL.push(dx, dy, dz);
    tf.push(Math.min(A.tension, Bm.tension)); sf.push(Math.min(A.shear, Bm.shear));
  };

  const EPS = 0.03;
  const ci = [0, 0, 0], cj = [0, 0, 0], hi = [0, 0, 0], hj = [0, 0, 0], gaps = [0, 0, 0], an = [0, 0, 0];
  for (let i = 0; i < np; i++) {
    const pi = pieces[i];
    ci[0] = pi.center[0]; ci[1] = pi.center[1]; ci[2] = pi.center[2];
    hi[0] = pi.halfExtents[0]; hi[1] = pi.halfExtents[1]; hi[2] = pi.halfExtents[2];
    for (let j = i + 1; j < np; j++) {
      const pj = pieces[j];
      cj[0] = pj.center[0]; cj[1] = pj.center[1]; cj[2] = pj.center[2];
      hj[0] = pj.halfExtents[0]; hj[1] = pj.halfExtents[1]; hj[2] = pj.halfExtents[2];
      let skip = false;
      let touch = -1;
      let overlaps = 0;
      for (let k = 0; k < 3; k++) {
        const gp = Math.abs(ci[k] - cj[k]) - (hi[k] + hj[k]);
        gaps[k] = gp;
        if (gp > EPS) { skip = true; break; }
        if (gp < -EPS) overlaps++;
        else touch = k;
      }
      if (skip || overlaps !== 2 || touch < 0) continue;
      let area = 1;
      for (let k = 0; k < 3; k++) {
        if (k === touch) {
          an[k] = ci[k] + (cj[k] >= ci[k] ? 1 : -1) * hi[k];
        } else {
          const lo = Math.max(ci[k] - hi[k], cj[k] - hj[k]);
          const up = Math.min(ci[k] + hi[k], cj[k] + hj[k]);
          area *= up - lo;
          an[k] = (lo + up) / 2;
        }
      }
      if (area < 0.02) continue;
      const sgn = cj[touch] >= ci[touch] ? 1 : -1;
      push(i, j, an[0], an[1], an[2], area, touch === 0 ? sgn : 0, touch === 1 ? sgn : 0, touch === 2 ? sgn : 0, pi.material, pj.material);
    }
    if (ci[1] - hi[1] <= 0.03) {
      push(i, -1, ci[0], 0, ci[2], 4 * hi[0] * hi[2], 0, -1, 0, pi.material, null);
    }
  }

  const nb = bonds.length;
  const adjStart = new Int32Array(np + 1);
  for (let b = 0; b < nb; b++) {
    adjStart[baL[b] + 1]++;
    if (bbL[b] >= 0) adjStart[bbL[b] + 1]++;
  }
  for (let i = 0; i < np; i++) adjStart[i + 1] += adjStart[i];
  const fillPos = adjStart.slice(0, np);
  const adjBond = new Int32Array(adjStart[np]);
  for (let b = 0; b < nb; b++) {
    adjBond[fillPos[baL[b]]++] = b;
    if (bbL[b] >= 0) adjBond[fillPos[bbL[b]]++] = b;
  }

  const levels = Math.ceil(Math.max(1, spec.floors) / Math.min(prm.group, Math.max(1, spec.floors)));
  const g: GenGraph = {
    specId: spec.id, x: spec.x, z: spec.z, yaw: spec.yaw, pieces, bonds,
    cen, mass, cladding,
    ba: Int32Array.from(baL), bb: Int32Array.from(bbL),
    anchor: Float64Array.from(anc), dir: Float64Array.from(dirL),
    fcap: Float64Array.from(bonds, (b) => b.maxForce),
    mcap: Float64Array.from(bonds, (b) => b.maxMoment),
    tfrac: Float32Array.from(tf), sfrac: Float32Array.from(sf),
    adjStart, adjBond,
    groundBonds: bbL.filter((v) => v < 0).length,
    info: { bay: prm.bay, group: prm.group, levels, designIters: 0 },
  };
  if (design) designBonds(g);
  return g;
}

/** Copy the solver-side limits back into the public BondDef records (after design). */
export function syncBondDefs(g: GenGraph): void {
  for (let b = 0; b < g.bonds.length; b++) {
    g.bonds[b].maxForce = g.fcap[b];
    g.bonds[b].maxMoment = g.mcap[b];
  }
}
