// Structural stress solver for a building's bond graph (Blast-style, plan.md "Stress decides failure").
//
// Every piece is a rigid node with 6 degrees of freedom (translation u, small rotation θ) in the
// building frame. Every bond is a stiff elastic connection at its contact patch: axial and shear
// springs on the patch's relative displacement, bending and twist springs on the relative rotation.
// Ground bonds connect a piece to the immovable ground. Loads are true weights (m·g, or the
// apparent gravity g − a of a body that is landing) plus measured impact forces from Rapier.
//
//   K x = f   is solved with preconditioned conjugate gradient (6×6 block-Jacobi, matrix-free,
//             warm-started from the last solution of the same building).
//
// The bond loads come from the solved displacements, so redistribution after a support is lost is
// whatever the elastic structure does: neighbours of a missing column pick up its load in
// proportion to their stiffness, an overhang puts real bending into the bonds holding it, and
// soft non-structural cladding only carries load when nothing stiffer is left. Nothing is scripted.
//
// Stiffness: k_axial = E·A/L, k_shear = G·A/L, k_bend = E·I/L, k_twist = G·J/L, with the contact
// patch as the section (I = A²/12, J = A²/6) and L the distance between the two piece centres along
// the bond normal. Bonds to cladding (windows, curtain-wall and frame infill panels) are soft ties.

import type { DMaterial } from './types';
import type { GenGraph } from './building-gen';

/** Effective Young's modulus (Pa) of each material as a bulk structural element. */
const YOUNG: Record<DMaterial, number> = {
  concrete: 30e9,
  brick: 6e9,
  stone: 20e9,
  glass: 50e9,
  steel: 60e9, // effective: a steel "piece" is a frame bay, not solid steel
  wood: 10e9,
};
const SHEAR_RATIO = 0.4;
/** Stiffness multiplier on bonds that touch non-structural cladding (fixings, gaskets, brackets). */
const CLADDING_STIFFNESS = 0.03;
/** Translational / rotational stiffness of a contact support (a landing body's contact pieces). */
const PIN_K = 3e10;
/** Most rigid aggregates in the coarse level of the preconditioner (6 coarse unknowns each). */
const MAX_AGG = 24;
/** Height band (m) of one coarse aggregate. */
const STOREY_BAND = 3;

/** Static per-graph stiffness data (building frame is constant, so this never changes). */
interface Prep {
  /** Anchor relative to piece a / piece b centres (xyz). */
  ra: Float64Array;
  rb: Float64Array;
  kn: Float64Array;
  kt: Float64Array;
  kb: Float64Array;
  kq: Float64Array;
  /** Coarse aggregate key of each piece (storey band x horizontal bin), and the key count. */
  aggKey: Int32Array;
  nKeys: number;
}
const preps = new WeakMap<GenGraph, Prep>();

function prepare(G: GenGraph): Prep {
  let p = preps.get(G);
  if (p) return p;
  const nb = G.bonds.length;
  p = {
    ra: new Float64Array(nb * 3), rb: new Float64Array(nb * 3),
    kn: new Float64Array(nb), kt: new Float64Array(nb), kb: new Float64Array(nb), kq: new Float64Array(nb),
    aggKey: new Int32Array(0), nKeys: 0,
  };
  const { ba, bb, anchor, dir, cen, cladding, pieces } = G;
  for (let b = 0; b < nb; b++) {
    const a = ba[b], c = bb[b];
    const ax = Math.abs(dir[b * 3]) > 0.5 ? 0 : Math.abs(dir[b * 3 + 1]) > 0.5 ? 1 : 2;
    let L = pieces[a].halfExtents[ax];
    let E = YOUNG[pieces[a].material];
    for (let k = 0; k < 3; k++) p.ra[b * 3 + k] = anchor[b * 3 + k] - cen[a * 3 + k];
    let soft = cladding[a] === 1;
    if (c >= 0) {
      L += pieces[c].halfExtents[ax];
      const Eb = YOUNG[pieces[c].material];
      E = (2 * E * Eb) / (E + Eb);
      for (let k = 0; k < 3; k++) p.rb[b * 3 + k] = anchor[b * 3 + k] - cen[c * 3 + k];
      soft = soft || cladding[c] === 1;
    }
    L = Math.max(L, 0.1);
    const A = G.bonds[b].area;
    const f = soft ? CLADDING_STIFFNESS : 1;
    const Gm = E * SHEAR_RATIO;
    p.kn[b] = (f * E * A) / L;
    p.kt[b] = (f * Gm * A) / L;
    p.kb[b] = (f * E * (A * A) / 12) / L;
    p.kq[b] = (f * Gm * (A * A) / 6) / L;
  }
  // Aggregates for the two-level preconditioner: pieces grouped by storey band (by height, so tall
  // stacks such as a clock tower split too) and, along wide buildings, by horizontal bin, keeping
  // the coarse problem at most MAX_AGG rigid bodies.
  const np = G.pieces.length;
  let ymax = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < np; i++) {
    ymax = Math.max(ymax, cen[i * 3 + 1]);
    x0 = Math.min(x0, cen[i * 3]); x1 = Math.max(x1, cen[i * 3]);
    z0 = Math.min(z0, cen[i * 3 + 2]); z1 = Math.max(z1, cen[i * 3 + 2]);
  }
  const ny = Math.max(1, Math.min(MAX_AGG, Math.ceil((ymax + 0.01) / STOREY_BAND)));
  const alongX = x1 - x0 >= z1 - z0;
  const L = Math.max(x1 - x0, z1 - z0);
  const nh = Math.max(1, Math.min(Math.floor(MAX_AGG / ny), Math.ceil(L / 10)));
  p.aggKey = new Int32Array(np);
  for (let i = 0; i < np; i++) {
    const yb = Math.min(ny - 1, Math.floor((cen[i * 3 + 1] / (ymax + 0.01)) * ny));
    const h = alongX ? cen[i * 3] - x0 : cen[i * 3 + 2] - z0;
    const hb = L > 0 ? Math.min(nh - 1, Math.floor((h / (L + 0.01)) * nh)) : 0;
    p.aggKey[i] = yb * nh + hb;
  }
  p.nKeys = ny * nh;
  preps.set(G, p);
  return p;
}

export interface SolveResult {
  iterations: number;
  /** Work done: iterations x bonds (the unit of the per-step solver budget). */
  work: number;
  converged: boolean;
  /** Final relative residual |r| / |f|. */
  residual: number;
}

export class StressSolver {
  /** Utilisation per bond (0 = unloaded, 1 = at its limit), valid for the bonds of the last solve. */
  util = new Float32Array(0);
  /** Fraction of each bond's utilisation that is compression (≥ 0.5: it fails by crushing). */
  crush = new Float32Array(0);
  /** Bonds selected to break by the last selectBreaks(). */
  over = new Int32Array(0);
  nOver = 0;
  /** Bonds of the last solve, and their count. */
  bonds = new Int32Array(0);
  nBonds = 0;
  /** Highest utilisation of the last solve. */
  maxUtil = 0;
  /** Total CG iterations run since the counter was last reset (for stats). */
  itersRun = 0;
  /** Total work (iterations x bonds) since the counter was last reset (for budgets). */
  workRun = 0;
  /** Solves run since last reset. */
  solves = 0;

  private loc = new Int32Array(0);
  private nodes = new Int32Array(0);
  private pin = new Uint8Array(0);
  private x = new Float64Array(0);
  private r = new Float64Array(0);
  private z = new Float64Array(0);
  private p = new Float64Array(0);
  private q = new Float64Array(0);
  private f = new Float64Array(0);
  /** Cholesky factor (lower, row-major 6×6) of each node's diagonal block. */
  private blk = new Float64Array(0);
  // ---- coarse level: rigid motions of aggregates
  private agg = new Int32Array(0);
  private keyAgg = new Int32Array(64);
  private aggC = new Float64Array(MAX_AGG * 3);
  private aggN = new Int32Array(MAX_AGG);
  private nAgg = 0;
  private Ac = new Float64Array(MAX_AGG * 6 * MAX_AGG * 6);
  private rc = new Float64Array(MAX_AGG * 6);
  private cenRef: Float64Array | null = null;

  ensure(np: number, nb: number): void {
    if (this.loc.length < np) {
      const n = Math.max(np, 64);
      this.loc = new Int32Array(n).fill(-1);
      this.nodes = new Int32Array(n);
      this.pin = new Uint8Array(n);
      this.x = new Float64Array(n * 6);
      this.r = new Float64Array(n * 6);
      this.z = new Float64Array(n * 6);
      this.p = new Float64Array(n * 6);
      this.q = new Float64Array(n * 6);
      this.f = new Float64Array(n * 6);
      this.blk = new Float64Array(n * 36);
      this.agg = new Int32Array(n);
    }
    if (this.util.length < nb) {
      const n = Math.max(nb, 128);
      this.util = new Float32Array(n);
      this.crush = new Float32Array(n);
      this.over = new Int32Array(n);
      this.bonds = new Int32Array(n);
    }
  }

  /**
   * Solve the loads in the bonds among the pieces in `list` (one connected group).
   *
   * (gx, gy, gz): (apparent) gravity in the building frame. `fixed`: the group is held by its
   * ground bonds; otherwise it is a loose body held by its contact pieces (srcStamp[i] === stamp).
   * `ext`: impact forces (N, building frame) per piece, or null. `warm`: per-piece 6-DOF solution
   * of this building from the last solve (read as the start point, written back), or null.
   * Fills util[] for the solved bonds. `maxWork` caps iterations x (bonds + pieces). Returns
   * iteration count, work and convergence.
   */
  solve(
    G: GenGraph, pAlive: Uint8Array, bAlive: Uint8Array, list: ArrayLike<number>, n: number,
    gx: number, gy: number, gz: number, fixed: boolean,
    srcStamp: Int32Array | null, stamp: number, ext: Float32Array | null, scale: number,
    warm: Float64Array | null, maxWork: number, tol: number,
  ): SolveResult {
    this.ensure(G.pieces.length, G.bonds.length);
    const P = prepare(G);
    const { loc, nodes, pin, x, r, z, p, q, f } = this;
    const { ba, bb, adjStart, adjBond, mass } = G;

    // ---- local numbering and the bond list
    let nn = 0;
    for (let k = 0; k < n; k++) {
      const i = list[k];
      if (!pAlive[i]) continue;
      loc[i] = nn;
      nodes[nn] = i;
      pin[nn] = !fixed && srcStamp !== null && srcStamp[i] === stamp ? 1 : 0;
      nn++;
    }
    let nbd = 0;
    let supported = false;
    for (let k = 0; k < nn; k++) {
      const i = nodes[k];
      if (pin[k]) supported = true;
      for (let e = adjStart[i]; e < adjStart[i + 1]; e++) {
        const b = adjBond[e];
        if (!bAlive[b]) continue;
        const j = ba[b] === i ? bb[b] : ba[b];
        if (j < 0) {
          if (!fixed) continue; // a loose body has no ground bonds (they are dead), defensive
          supported = true;
          this.bonds[nbd++] = b;
        } else if (ba[b] === i && pAlive[j] && loc[j] >= 0 && j !== i) {
          this.bonds[nbd++] = b; // listed once, from its `a` side
        }
      }
    }
    this.nBonds = nbd;
    const res: SolveResult = { iterations: 0, work: 0, converged: true, residual: 0 };
    const maxIter = Math.max(2, Math.floor(maxWork / Math.max(1, nbd + nn)));
    this.maxUtil = 0;
    if (nn === 0 || !supported) {
      for (let k = 0; k < nn; k++) loc[nodes[k]] = -1;
      for (let k = 0; k < nbd; k++) this.util[this.bonds[k]] = 0;
      return res;
    }

    // ---- load vector and warm start
    let fn2 = 0;
    for (let k = 0; k < nn; k++) {
      const i = nodes[k], o = k * 6;
      let fx = mass[i] * gx, fy = mass[i] * gy, fz = mass[i] * gz;
      if (ext) { fx += ext[i * 3]; fy += ext[i * 3 + 1]; fz += ext[i * 3 + 2]; }
      f[o] = fx; f[o + 1] = fy; f[o + 2] = fz; f[o + 3] = 0; f[o + 4] = 0; f[o + 5] = 0;
      fn2 += fx * fx + fy * fy + fz * fz;
      for (let d = 0; d < 6; d++) x[o + d] = warm ? warm[i * 6 + d] : 0;
    }
    const fnorm = Math.sqrt(fn2);
    if (fnorm < 1e-9) {
      for (let k = 0; k < nn; k++) loc[nodes[k]] = -1;
      for (let k = 0; k < nbd; k++) this.util[this.bonds[k]] = 0;
      return res;
    }

    // ---- preconditioner: block-Jacobi + rigid-aggregate coarse level
    this.cenRef = G.cen;
    this.buildBlocks(G, P, nn, nbd);
    this.buildCoarse(G, P, nn);

    // ---- PCG
    this.apply(G, P, x, q, nn, nbd);
    if (warm) {
      // Rescale the warm start to the new load (energy-optimal α = x·f / x·Kx): a landing body's
      // load jumps by tens of g in one step, and the shape of the solution changes far less than
      // its size.
      let xf = 0, xq = 0;
      for (let k = 0; k < nn * 6; k++) { xf += x[k] * f[k]; xq += x[k] * q[k]; }
      if (xq > 0 && xf > 0) {
        const a = xf / xq;
        for (let k = 0; k < nn * 6; k++) { x[k] *= a; q[k] *= a; }
      }
    }
    let rr = 0;
    for (let k = 0; k < nn * 6; k++) { r[k] = f[k] - q[k]; rr += r[k] * r[k]; }
    let it = 0;
    const tol2 = tol * tol * fn2;
    if (rr > tol2) {
      this.precond(r, z, nn);
      let rz = 0;
      for (let k = 0; k < nn * 6; k++) { p[k] = z[k]; rz += r[k] * z[k]; }
      for (; it < maxIter; it++) {
        this.apply(G, P, p, q, nn, nbd);
        let pq = 0;
        for (let k = 0; k < nn * 6; k++) pq += p[k] * q[k];
        if (pq <= 0) break;
        const alpha = rz / pq;
        rr = 0;
        for (let k = 0; k < nn * 6; k++) {
          x[k] += alpha * p[k];
          r[k] -= alpha * q[k];
          rr += r[k] * r[k];
        }
        if (rr <= tol2) { it++; break; }
        this.precond(r, z, nn);
        let rz1 = 0;
        for (let k = 0; k < nn * 6; k++) rz1 += r[k] * z[k];
        const beta = rz1 / rz;
        rz = rz1;
        for (let k = 0; k < nn * 6; k++) p[k] = z[k] + beta * p[k];
      }
    }
    this.itersRun += it;
    this.workRun += (it + 2) * (nbd + nn);
    this.solves++;
    res.iterations = it;
    res.work = (it + 2) * (nbd + nn);
    res.residual = Math.sqrt(rr) / fnorm;
    res.converged = rr <= tol2;
    if (warm) for (let k = 0; k < nn; k++) for (let d = 0; d < 6; d++) warm[nodes[k] * 6 + d] = x[k * 6 + d];

    // ---- bond loads -> utilisation
    const { dir, fcap, mcap, tfrac, sfrac } = G;
    let umax = 0;
    for (let k = 0; k < nbd; k++) {
      const b = this.bonds[k];
      const ia = loc[ba[b]] * 6;
      const jb = bb[b] >= 0 ? loc[bb[b]] * 6 : -1;
      // relative displacement at the anchor and relative rotation (b minus a)
      const rax = P.ra[b * 3], ray = P.ra[b * 3 + 1], raz = P.ra[b * 3 + 2];
      let dx = -(x[ia] + x[ia + 4] * raz - x[ia + 5] * ray);
      let dy = -(x[ia + 1] + x[ia + 5] * rax - x[ia + 3] * raz);
      let dz = -(x[ia + 2] + x[ia + 3] * ray - x[ia + 4] * rax);
      let px = -x[ia + 3], py = -x[ia + 4], pz = -x[ia + 5];
      if (jb >= 0) {
        const rbx = P.rb[b * 3], rby = P.rb[b * 3 + 1], rbz = P.rb[b * 3 + 2];
        dx += x[jb] + x[jb + 4] * rbz - x[jb + 5] * rby;
        dy += x[jb + 1] + x[jb + 5] * rbx - x[jb + 3] * rbz;
        dz += x[jb + 2] + x[jb + 3] * rby - x[jb + 4] * rbx;
        px += x[jb + 3]; py += x[jb + 4]; pz += x[jb + 5];
      }
      const nx = dir[b * 3], ny = dir[b * 3 + 1], nz = dir[b * 3 + 2];
      const dn = dx * nx + dy * ny + dz * nz;
      const tx = dx - dn * nx, ty = dy - dn * ny, tz = dz - dn * nz;
      const pn = px * nx + py * ny + pz * nz;
      const qx = px - pn * nx, qy = py - pn * ny, qz = pz - pn * nz;
      const comp = -P.kn[b] * dn; // > 0: compression
      const shear = P.kt[b] * Math.sqrt(tx * tx + ty * ty + tz * tz);
      const moment = P.kb[b] * Math.sqrt(qx * qx + qy * qy + qz * qz) + P.kq[b] * Math.abs(pn);
      const cap = fcap[b] * scale;
      const uc = comp >= 0 ? comp / cap : 0;
      const u = uc + (comp < 0 ? -comp / (cap * tfrac[b]) : 0) + shear / (cap * sfrac[b]) + moment / (mcap[b] * scale);
      this.util[b] = u;
      this.crush[b] = u > 0 ? uc / u : 0;
      if (u > umax) umax = u;
    }
    this.maxUtil = umax;
    for (let k = 0; k < nn; k++) loc[nodes[k]] = -1;
    return res;
  }

  /**
   * Choose the bonds to break after a converged solve: every bond at or over its limit that is
   * within `band` of the worst one (the most overloaded fail first; the solve after the break
   * decides what the rest now carry). Returns the count; the bonds are in over[0..n).
   */
  selectBreaks(band = 0.9): number {
    this.nOver = 0;
    if (this.maxUtil < 1) return 0;
    const lim = Math.max(1, this.maxUtil * band);
    for (let k = 0; k < this.nBonds; k++) {
      const b = this.bonds[k];
      if (this.util[b] >= lim) this.over[this.nOver++] = b;
    }
    return this.nOver;
  }

  // ------------------------------------------------------------------ internals

  /** q = K x (matrix-free over the bond list). */
  private apply(G: GenGraph, P: Prep, x: Float64Array, q: Float64Array, nn: number, nbd: number): void {
    const { ba, bb, dir } = G;
    const loc = this.loc;
    q.fill(0, 0, nn * 6);
    for (let k = 0; k < nn; k++) {
      if (!this.pin[k]) continue;
      const o = k * 6;
      for (let d = 0; d < 6; d++) q[o + d] += PIN_K * x[o + d];
    }
    for (let k = 0; k < nbd; k++) {
      const b = this.bonds[k];
      const ia = loc[ba[b]] * 6;
      const jb = bb[b] >= 0 ? loc[bb[b]] * 6 : -1;
      const rax = P.ra[b * 3], ray = P.ra[b * 3 + 1], raz = P.ra[b * 3 + 2];
      let dx = -(x[ia] + x[ia + 4] * raz - x[ia + 5] * ray);
      let dy = -(x[ia + 1] + x[ia + 5] * rax - x[ia + 3] * raz);
      let dz = -(x[ia + 2] + x[ia + 3] * ray - x[ia + 4] * rax);
      let px = -x[ia + 3], py = -x[ia + 4], pz = -x[ia + 5];
      let rbx = 0, rby = 0, rbz = 0;
      if (jb >= 0) {
        rbx = P.rb[b * 3]; rby = P.rb[b * 3 + 1]; rbz = P.rb[b * 3 + 2];
        dx += x[jb] + x[jb + 4] * rbz - x[jb + 5] * rby;
        dy += x[jb + 1] + x[jb + 5] * rbx - x[jb + 3] * rbz;
        dz += x[jb + 2] + x[jb + 3] * rby - x[jb + 4] * rbx;
        px += x[jb + 3]; py += x[jb + 4]; pz += x[jb + 5];
      }
      const nx = dir[b * 3], ny = dir[b * 3 + 1], nz = dir[b * 3 + 2];
      const kn = P.kn[b], kt = P.kt[b], kb = P.kb[b], kq = P.kq[b];
      const dn = dx * nx + dy * ny + dz * nz;
      // F = Kt δ, M = Kr φ
      const Fx = kt * dx + (kn - kt) * dn * nx;
      const Fy = kt * dy + (kn - kt) * dn * ny;
      const Fz = kt * dz + (kn - kt) * dn * nz;
      const pn = px * nx + py * ny + pz * nz;
      const Mx = kb * px + (kq - kb) * pn * nx;
      const My = kb * py + (kq - kb) * pn * ny;
      const Mz = kb * pz + (kq - kb) * pn * nz;
      // side b: +[F; r_b × F + M], side a: −[F; r_a × F + M]
      if (jb >= 0) {
        q[jb] += Fx; q[jb + 1] += Fy; q[jb + 2] += Fz;
        q[jb + 3] += rby * Fz - rbz * Fy + Mx;
        q[jb + 4] += rbz * Fx - rbx * Fz + My;
        q[jb + 5] += rbx * Fy - rby * Fx + Mz;
      }
      q[ia] -= Fx; q[ia + 1] -= Fy; q[ia + 2] -= Fz;
      q[ia + 3] -= ray * Fz - raz * Fy + Mx;
      q[ia + 4] -= raz * Fx - rax * Fz + My;
      q[ia + 5] -= rax * Fy - ray * Fx + Mz;
    }
  }

  /** Assemble each node's 6×6 diagonal block and factor it (Cholesky, in place). */
  private buildBlocks(G: GenGraph, P: Prep, nn: number, nbd: number): void {
    const blk = this.blk;
    blk.fill(0, 0, nn * 36);
    for (let k = 0; k < nn; k++) {
      if (!this.pin[k]) continue;
      for (let d = 0; d < 6; d++) blk[k * 36 + d * 7] += PIN_K;
    }
    const { ba, bb, dir } = G;
    for (let k = 0; k < nbd; k++) {
      const b = this.bonds[k];
      this.addBlock(this.loc[ba[b]], P.ra, b, dir, P);
      if (bb[b] >= 0) this.addBlock(this.loc[bb[b]], P.rb, b, dir, P);
    }
    for (let k = 0; k < nn; k++) {
      const o = k * 36;
      // tiny regularisation keeps a barely-held node factorable
      let tr = 0;
      for (let d = 0; d < 6; d++) tr += blk[o + d * 7];
      const eps = tr * 1e-9 + 1e-6;
      for (let d = 0; d < 6; d++) blk[o + d * 7] += eps;
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j <= i; j++) {
          let s = blk[o + i * 6 + j];
          for (let m = 0; m < j; m++) s -= blk[o + i * 6 + m] * blk[o + j * 6 + m];
          if (i === j) blk[o + i * 6 + i] = Math.sqrt(Math.max(s, eps));
          else blk[o + i * 6 + j] = s / blk[o + j * 6 + j];
        }
      }
    }
  }

  /** Add one bond's contribution [[Kt, −Kt S], [S Kt, −S Kt S + Kr]] (S = [r]×) to node k's block. */
  private addBlock(k: number, R: Float64Array, b: number, dir: Float64Array, P: Prep): void {
    const blk = this.blk, o = k * 36;
    const rx = R[b * 3], ry = R[b * 3 + 1], rz = R[b * 3 + 2];
    const nx = dir[b * 3], ny = dir[b * 3 + 1], nz = dir[b * 3 + 2];
    const n = [nx, ny, nz];
    const kn = P.kn[b], kt = P.kt[b], kb = P.kb[b], kq = P.kq[b];
    // Kt and Kr
    const Kt = _Kt, Kr = _Kr, S = _S, KS = _KS;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const nn = n[i] * n[j];
        const id = i === j ? 1 : 0;
        Kt[i * 3 + j] = kt * id + (kn - kt) * nn;
        Kr[i * 3 + j] = kb * id + (kq - kb) * nn;
      }
    }
    S[0] = 0; S[1] = -rz; S[2] = ry;
    S[3] = rz; S[4] = 0; S[5] = -rx;
    S[6] = -ry; S[7] = rx; S[8] = 0;
    // KS = Kt S
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let m = 0; m < 3; m++) s += Kt[i * 3 + m] * S[m * 3 + j];
      KS[i * 3 + j] = s;
    }
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        blk[o + i * 6 + j] += Kt[i * 3 + j];
        blk[o + i * 6 + 3 + j] -= KS[i * 3 + j];
        blk[o + (3 + i) * 6 + j] -= KS[j * 3 + i]; // (−Kt S)ᵀ = S Kt... = −(KS)ᵀ
        // −S Kt S = Sᵀ Kt S
        let s = 0;
        for (let m = 0; m < 3; m++) s += S[m * 3 + i] * KS[m * 3 + j];
        blk[o + (3 + i) * 6 + 3 + j] += s + Kr[i * 3 + j];
      }
    }
  }

  /**
   * Coarse level: every aggregate moves as a rigid body (u_i = U_A + Θ_A × (c_i − c_A), θ_i = Θ_A).
   * Its stiffness Ac = Pᵀ K P is assembled exactly from the bonds that cross aggregates (bonds inside
   * one aggregate are not strained by its rigid motion), then factored densely.
   */
  private buildCoarse(G: GenGraph, P: Prep, nn: number): void {
    const { agg, aggC, aggN } = this;
    if (this.keyAgg.length < P.nKeys) this.keyAgg = new Int32Array(P.nKeys);
    const ka = this.keyAgg;
    ka.fill(-1, 0, P.nKeys);
    let na = 0;
    aggC.fill(0); aggN.fill(0);
    const cen = G.cen;
    for (let k = 0; k < nn; k++) {
      const i = this.nodes[k];
      const key = P.aggKey[i];
      let a = ka[key];
      if (a < 0) { a = na++; ka[key] = a; }
      agg[k] = a;
      aggC[a * 3] += cen[i * 3]; aggC[a * 3 + 1] += cen[i * 3 + 1]; aggC[a * 3 + 2] += cen[i * 3 + 2];
      aggN[a]++;
    }
    for (let a = 0; a < na; a++) { aggC[a * 3] /= aggN[a]; aggC[a * 3 + 1] /= aggN[a]; aggC[a * 3 + 2] /= aggN[a]; }
    this.nAgg = na;
    const nc = na * 6;
    const Ac = this.Ac;
    Ac.fill(0, 0, nc * nc);
    const { ba, bb, anchor, dir } = G;
    const loc = this.loc;
    for (let k = 0; k < this.nBonds; k++) {
      const b = this.bonds[k];
      const A = agg[loc[ba[b]]];
      const B = bb[b] >= 0 ? agg[loc[bb[b]]] : -1;
      if (A === B) continue;
      const ax = anchor[b * 3], ay = anchor[b * 3 + 1], az = anchor[b * 3 + 2];
      const rax = ax - aggC[A * 3], ray = ay - aggC[A * 3 + 1], raz = az - aggC[A * 3 + 2];
      const nx = dir[b * 3], ny = dir[b * 3 + 1], nz = dir[b * 3 + 2];
      const kn = P.kn[b], kt = P.kt[b], kb = P.kb[b], kq = P.kq[b];
      coarseBlock(Ac, nc, A, A, rax, ray, raz, rax, ray, raz, nx, ny, nz, kn, kt, kb, kq, 1);
      if (B >= 0) {
        const rbx = ax - aggC[B * 3], rby = ay - aggC[B * 3 + 1], rbz = az - aggC[B * 3 + 2];
        coarseBlock(Ac, nc, B, B, rbx, rby, rbz, rbx, rby, rbz, nx, ny, nz, kn, kt, kb, kq, 1);
        coarseBlock(Ac, nc, A, B, rax, ray, raz, rbx, rby, rbz, nx, ny, nz, kn, kt, kb, kq, -1);
        coarseBlock(Ac, nc, B, A, rbx, rby, rbz, rax, ray, raz, nx, ny, nz, kn, kt, kb, kq, -1);
      }
    }
    for (let k = 0; k < nn; k++) {
      if (!this.pin[k]) continue;
      const i = this.nodes[k], A = agg[k];
      const dx = cen[i * 3] - aggC[A * 3], dy = cen[i * 3 + 1] - aggC[A * 3 + 1], dz = cen[i * 3 + 2] - aggC[A * 3 + 2];
      coarseBlock(Ac, nc, A, A, dx, dy, dz, dx, dy, dz, 0, 1, 0, PIN_K, PIN_K, PIN_K, PIN_K, 1);
    }
    // dense Cholesky, lower triangle in place
    let tr = 0;
    for (let i = 0; i < nc; i++) tr += Ac[i * nc + i];
    const eps = (tr / Math.max(1, nc)) * 1e-10 + 1e-6;
    for (let i = 0; i < nc; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = Ac[i * nc + j];
        for (let m = 0; m < j; m++) sum -= Ac[i * nc + m] * Ac[j * nc + m];
        if (i === j) Ac[i * nc + i] = Math.sqrt(Math.max(sum + eps, eps));
        else Ac[i * nc + j] = sum / Ac[j * nc + j];
      }
    }
  }

  /** z = M⁻¹ r: block-Jacobi plus the coarse correction P Ac⁻¹ Pᵀ r (additive two-level). */
  private precond(r: Float64Array, z: Float64Array, nn: number): void {
    this.precondBlocks(r, z, nn);
    const na = this.nAgg, nc = na * 6;
    if (na === 0) return;
    const { rc, Ac, agg, aggC, nodes } = this;
    const cen = this.cenRef!;
    rc.fill(0, 0, nc);
    // restriction: force sum and moment about each aggregate centre
    for (let k = 0; k < nn; k++) {
      const A = agg[k], a = A * 6, v = k * 6, i = nodes[k];
      const dx = cen[i * 3] - aggC[A * 3], dy = cen[i * 3 + 1] - aggC[A * 3 + 1], dz = cen[i * 3 + 2] - aggC[A * 3 + 2];
      const fx = r[v], fy = r[v + 1], fz = r[v + 2];
      rc[a] += fx; rc[a + 1] += fy; rc[a + 2] += fz;
      rc[a + 3] += r[v + 3] + dy * fz - dz * fy;
      rc[a + 4] += r[v + 4] + dz * fx - dx * fz;
      rc[a + 5] += r[v + 5] + dx * fy - dy * fx;
    }
    // Ac y = rc (factored)
    for (let i = 0; i < nc; i++) {
      let sum = rc[i];
      for (let m = 0; m < i; m++) sum -= Ac[i * nc + m] * rc[m];
      rc[i] = sum / Ac[i * nc + i];
    }
    for (let i = nc - 1; i >= 0; i--) {
      let sum = rc[i];
      for (let m = i + 1; m < nc; m++) sum -= Ac[m * nc + i] * rc[m];
      rc[i] = sum / Ac[i * nc + i];
    }
    // prolongation
    for (let k = 0; k < nn; k++) {
      const A = agg[k], a = A * 6, v = k * 6, i = nodes[k];
      const dx = cen[i * 3] - aggC[A * 3], dy = cen[i * 3 + 1] - aggC[A * 3 + 1], dz = cen[i * 3 + 2] - aggC[A * 3 + 2];
      const tx = rc[a + 3], ty = rc[a + 4], tz = rc[a + 5];
      z[v] += rc[a] + ty * dz - tz * dy;
      z[v + 1] += rc[a + 1] + tz * dx - tx * dz;
      z[v + 2] += rc[a + 2] + tx * dy - ty * dx;
      z[v + 3] += tx; z[v + 4] += ty; z[v + 5] += tz;
    }
  }

  /** z = (block diagonal)⁻¹ r with the factored blocks. */
  private precondBlocks(r: Float64Array, z: Float64Array, nn: number): void {
    const blk = this.blk;
    for (let k = 0; k < nn; k++) {
      const o = k * 36, v = k * 6;
      // forward: L y = r
      for (let i = 0; i < 6; i++) {
        let s = r[v + i];
        for (let m = 0; m < i; m++) s -= blk[o + i * 6 + m] * z[v + m];
        z[v + i] = s / blk[o + i * 6 + i];
      }
      // back: Lᵀ z = y
      for (let i = 5; i >= 0; i--) {
        let s = z[v + i];
        for (let m = i + 1; m < 6; m++) s -= blk[o + m * 6 + i] * z[v + m];
        z[v + i] = s / blk[o + i * 6 + i];
      }
    }
  }
}

const _Kt = new Float64Array(9), _Kr = new Float64Array(9), _S = new Float64Array(9), _KS = new Float64Array(9);

/**
 * Add sign x [[Kt, -Kt S2], [S1 Kt, -S1 Kt S2 + Kr]] (S = [r]x) to block (row aggregate A, column
 * aggregate B) of the dense coarse matrix: the bond element between rigid bodies whose centres are
 * r1 / r2 from the anchor. Diagonal blocks use r1 = r2.
 */
function coarseBlock(
  Ac: Float64Array, nc: number, A: number, B: number,
  r1x: number, r1y: number, r1z: number, r2x: number, r2y: number, r2z: number,
  nx: number, ny: number, nz: number, kn: number, kt: number, kb: number, kq: number, sign: number,
): void {
  const n = _n3;
  n[0] = nx; n[1] = ny; n[2] = nz;
  const Kt = _Kt, Kr = _Kr, S1 = _S, S2 = _S2, KS = _KS, SK = _SK;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const nn = n[i] * n[j];
      const id = i === j ? 1 : 0;
      Kt[i * 3 + j] = kt * id + (kn - kt) * nn;
      Kr[i * 3 + j] = kb * id + (kq - kb) * nn;
    }
  }
  S1[0] = 0; S1[1] = -r1z; S1[2] = r1y; S1[3] = r1z; S1[4] = 0; S1[5] = -r1x; S1[6] = -r1y; S1[7] = r1x; S1[8] = 0;
  S2[0] = 0; S2[1] = -r2z; S2[2] = r2y; S2[3] = r2z; S2[4] = 0; S2[5] = -r2x; S2[6] = -r2y; S2[7] = r2x; S2[8] = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let a = 0, b = 0;
    for (let m = 0; m < 3; m++) { a += Kt[i * 3 + m] * S2[m * 3 + j]; b += S1[i * 3 + m] * Kt[m * 3 + j]; }
    KS[i * 3 + j] = a; // Kt S2
    SK[i * 3 + j] = b; // S1 Kt
  }
  const r0 = A * 6, c0 = B * 6;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sks = 0;
      for (let m = 0; m < 3; m++) sks += S1[i * 3 + m] * KS[m * 3 + j];
      Ac[(r0 + i) * nc + c0 + j] += sign * Kt[i * 3 + j];
      Ac[(r0 + i) * nc + c0 + 3 + j] -= sign * KS[i * 3 + j];
      Ac[(r0 + 3 + i) * nc + c0 + j] += sign * SK[i * 3 + j];
      Ac[(r0 + 3 + i) * nc + c0 + 3 + j] += sign * (-sks + Kr[i * 3 + j]);
    }
  }
}
const _n3 = new Float64Array(3), _S2 = new Float64Array(9), _SK = new Float64Array(9);
