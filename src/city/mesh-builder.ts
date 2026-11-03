// Tiny static-geometry builder. Everything the town draws is appended to one
// MeshBuilder per material and turned into a single BufferGeometry, so the
// whole town costs a handful of draw calls.
//
// Every vertex carries: position, normal, uv (METRES, so procedural materials
// are real-world scaled) and three free vec4 attributes aA / aB / aC whose
// meaning is defined by the material that consumes the geometry (see
// materials.ts). Builders set `a`, `b`, `c` once and every following
// primitive copies them to its vertices.
//
// A frame (centre x/z + yaw) lets building generators work in a local space
// that matches the BuildingSpec (x along width, z along depth, y up).

import * as THREE from 'three/webgpu';

export type V3 = readonly [number, number, number];
export type V4 = [number, number, number, number];

/** Face bit flags for MeshBuilder.box `skip`. */
export const FACE = { PX: 1, NX: 2, PY: 4, NY: 8, PZ: 16, NZ: 32 } as const;

export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uvs: number[] = [];
  private va: number[] = [];
  private vb: number[] = [];
  private vc: number[] = [];
  private idx: number[] = [];

  a: V4 = [0, 0, 0, 0];
  b: V4 = [0, 0, 0, 0];
  c: V4 = [0, 0, 0, 0];

  private ox = 0;
  private oz = 0;
  private cs = 1;
  private sn = 0;

  get vertexCount(): number {
    return this.pos.length / 3;
  }
  get triangleCount(): number {
    return this.idx.length / 3;
  }

  /** Local frame: subsequent coordinates are relative to (x, z) and rotated by yaw about y. */
  setFrame(x: number, z: number, yaw: number): void {
    this.ox = x;
    this.oz = z;
    this.cs = Math.cos(yaw);
    this.sn = Math.sin(yaw);
  }
  clearFrame(): void {
    this.setFrame(0, 0, 0);
  }
  /** Local -> world (x/z only) for callers that need world positions (lights, etc.). */
  toWorld(lx: number, lz: number): [number, number] {
    return [this.ox + lx * this.cs + lz * this.sn, this.oz - lx * this.sn + lz * this.cs];
  }

  setAttrs(a?: V4, b?: V4, c?: V4): this {
    if (a) this.a = [...a] as V4;
    if (b) this.b = [...b] as V4;
    if (c) this.c = [...c] as V4;
    return this;
  }

  private vtx(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    const { cs, sn } = this;
    this.pos.push(this.ox + x * cs + z * sn, y, this.oz - x * sn + z * cs);
    this.nor.push(nx * cs + nz * sn, ny, -nx * sn + nz * cs);
    this.uvs.push(u, v);
    this.va.push(...this.a);
    this.vb.push(...this.b);
    this.vc.push(...this.c);
    return this.pos.length / 3 - 1;
  }

  /** Quad p0..p3, counter-clockwise seen from the outside. uv per corner (metres). */
  quad(p0: V3, p1: V3, p2: V3, p3: V3, uv0: [number, number], uv1: [number, number], uv2: [number, number], uv3: [number, number], n?: V3): void {
    let nx: number, ny: number, nz: number;
    if (n) [nx, ny, nz] = n;
    else {
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
      const bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
      nx = ay * bz - az * by;
      ny = az * bx - ax * bz;
      nz = ax * by - ay * bx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
    }
    const i = this.vtx(p0[0], p0[1], p0[2], nx, ny, nz, uv0[0], uv0[1]);
    this.vtx(p1[0], p1[1], p1[2], nx, ny, nz, uv1[0], uv1[1]);
    this.vtx(p2[0], p2[1], p2[2], nx, ny, nz, uv2[0], uv2[1]);
    this.vtx(p3[0], p3[1], p3[2], nx, ny, nz, uv3[0], uv3[1]);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  tri(p0: V3, p1: V3, p2: V3, uv0: [number, number], uv1: [number, number], uv2: [number, number], n?: V3): void {
    let nx: number, ny: number, nz: number;
    if (n) [nx, ny, nz] = n;
    else {
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
      const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
      nx = ay * bz - az * by;
      ny = az * bx - ax * bz;
      nz = ax * by - ay * bx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
    }
    const i = this.vtx(p0[0], p0[1], p0[2], nx, ny, nz, uv0[0], uv0[1]);
    this.vtx(p1[0], p1[1], p1[2], nx, ny, nz, uv1[0], uv1[1]);
    this.vtx(p2[0], p2[1], p2[2], nx, ny, nz, uv2[0], uv2[1]);
    this.idx.push(i, i + 1, i + 2);
  }

  /**
   * Axis-aligned (in the local frame) box. UVs in metres: side faces get
   * (horizontal position, y); top / bottom faces get (x, z).
   */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, skip = 0): void {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
    if (!(skip & FACE.PZ)) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0], [x1, y0], [x1, y1], [x0, y1], [0, 0, 1]);
    if (!(skip & FACE.NZ)) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0], [x0, y0], [x0, y1], [x1, y1], [0, 0, -1]);
    if (!(skip & FACE.PX)) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [z1, y0], [z0, y0], [z0, y1], [z1, y1], [1, 0, 0]);
    if (!(skip & FACE.NX)) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [z0, y0], [z1, y0], [z1, y1], [z0, y1], [-1, 0, 0]);
    if (!(skip & FACE.PY)) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [x0, z1], [x1, z1], [x1, z0], [x0, z0], [0, 1, 0]);
    if (!(skip & FACE.NY)) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, z0], [x1, z0], [x1, z1], [x0, z1], [0, -1, 0]);
  }

  /** Box from its base (y0) up to y0 + sy. */
  boxBase(cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, skip = 0): void {
    this.box(cx, y0 + sy / 2, cz, sx, sy, sz, skip);
  }

  /** A box rotated about its own centre by `yaw` (additional to the frame), with arbitrary tilt around z. */
  boxRot(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yaw: number, tiltZ = 0): void {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const cy_ = Math.cos(yaw), sy_ = Math.sin(yaw);
    const ct = Math.cos(tiltZ), st = Math.sin(tiltZ);
    const P = (lx: number, ly: number, lz: number): V3 => {
      // tilt about z (in xy plane), then yaw about y.
      const tx = lx * ct - ly * st;
      const ty = lx * st + ly * ct;
      return [cx + tx * cy_ + lz * sy_, cy + ty, cz - tx * sy_ + lz * cy_];
    };
    const Pn = (lx: number, ly: number, lz: number): V3 => {
      const tx = lx * ct - ly * st;
      const ty = lx * st + ly * ct;
      return [tx * cy_ + lz * sy_, ty, -tx * sy_ + lz * cy_];
    };
    const f = (p: V3[], n: V3): void => this.quad(p[0], p[1], p[2], p[3], [0, 0], [1, 0], [1, 1], [0, 1], Pn(...n));
    f([P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)], [0, 0, 1]);
    f([P(hx, -hy, -hz), P(-hx, -hy, -hz), P(-hx, hy, -hz), P(hx, hy, -hz)], [0, 0, -1]);
    f([P(hx, -hy, hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(hx, hy, hz)], [1, 0, 0]);
    f([P(-hx, -hy, -hz), P(-hx, -hy, hz), P(-hx, hy, hz), P(-hx, hy, -hz)], [-1, 0, 0]);
    f([P(-hx, hy, hz), P(hx, hy, hz), P(hx, hy, -hz), P(-hx, hy, -hz)], [0, 1, 0]);
    f([P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz)], [0, -1, 0]);
  }

  /**
   * Gable roof on a rectangular plan. Ridge runs along local x (alongX) or z.
   * UV: u = metres along the ridge, v = metres up the slope from the eave
   * (so slate courses run along u). Includes the two triangular gable walls
   * when `gables` is true (uv = wall metres).
   */
  gableRoof(cx: number, y0: number, cz: number, len: number, wid: number, rise: number, alongX: boolean, over = 0.3, gables = true): void {
    const hl = len / 2 + (gables ? 0.12 : 0);
    const hw = wid / 2 + over;
    const slope = Math.hypot(hw, rise);
    const ey = y0 - over * (rise / (wid / 2));
    // Frame the plan so "along" is x and "across" is z, then swap if needed.
    const P = (a: number, y: number, c: number): V3 => (alongX ? [cx + a, y, cz + c] : [cx + c, y, cz + a]);
    const N = (c: number, y: number): V3 => {
      const l = Math.hypot(c, y) || 1;
      return alongX ? [0, y / l, c / l] : [c / l, y / l, 0];
    };
    // +across slope (normal points +c and up)
    const nPos = N(rise, hw);
    const nNeg = N(-rise, hw);
    const slopeLen = slope;
    const top = y0 + rise;
    // winding depends on axis orientation; pick so that the normal matches n.
    const mk = (c0: number, c1: number, n: V3): void => {
      const p0 = P(-hl, ey, c0), p1 = P(hl, ey, c0), p2 = P(hl, top, c1), p3 = P(-hl, top, c1);
      // cross((p1-p0),(p3-p0)) sign test
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
      const bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
      const cxn = ay * bz - az * by, cyn = az * bx - ax * bz, czn = ax * by - ay * bx;
      const dot = cxn * n[0] + cyn * n[1] + czn * n[2];
      const u: [number, number][] = [[-hl, 0], [hl, 0], [hl, slopeLen], [-hl, slopeLen]];
      if (dot >= 0) this.quad(p0, p1, p2, p3, u[0], u[1], u[2], u[3], n);
      else this.quad(p0, p3, p2, p1, u[0], u[3], u[2], u[1], n);
    };
    mk(hw, 0, nPos);
    mk(-hw, 0, nNeg);
    if (gables) {
      const gw = wid / 2;
      for (const s of [-1, 1]) {
        const a = s * (len / 2 + 0.02);
        const n: V3 = alongX ? [s, 0, 0] : [0, 0, s];
        const p0 = P(a, y0 - 0.01, -gw), p1 = P(a, y0 - 0.01, gw), p2 = P(a, top, 0);
        const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
        const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
        const dot = (ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2];
        const u0: [number, number] = [-gw, y0], u1: [number, number] = [gw, y0], u2: [number, number] = [0, top];
        if (dot >= 0) this.tri(p0, p1, p2, u0, u1, u2, n);
        else this.tri(p0, p2, p1, u0, u2, u1, n);
      }
    }
  }

  /**
   * Four-sided pyramid / hip cap with an optional flat top of topX x topZ.
   * UV: u = metres along the base edge, v = slope distance from the eave
   * (slate courses horizontal).
   */
  pyramid(cx: number, y0: number, cz: number, sx: number, sz: number, h: number, topX = 0, topZ = 0): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const ay = y0 + h;
    const tx = topX / 2, tz = topZ / 2;
    const corners: V3[] = [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]];
    const tops: V3[] = [[cx - tx, ay, cz + tz], [cx + tx, ay, cz + tz], [cx + tx, ay, cz - tz], [cx - tx, ay, cz - tz]];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const c0 = corners[i], c1 = corners[j];
      const len = Math.hypot(c1[0] - c0[0], c1[2] - c0[2]);
      const mx = (c0[0] + c1[0]) / 2 - (tops[i][0] + tops[j][0]) / 2;
      const mz = (c0[2] + c1[2]) / 2 - (tops[i][2] + tops[j][2]) / 2;
      const slope = Math.hypot(Math.hypot(mx, mz), h);
      const topLen = Math.hypot(tops[j][0] - tops[i][0], tops[j][2] - tops[i][2]);
      if (topLen > 0.001) this.quad(c0, c1, tops[j], tops[i], [-len / 2, 0], [len / 2, 0], [topLen / 2, slope], [-topLen / 2, slope]);
      else this.tri(c0, c1, tops[0], [-len / 2, 0], [len / 2, 0], [0, slope]);
    }
  }

  /** Vertical (or tapered) cylinder with optional caps. uv = (arc length, y). */
  cylinder(cx: number, y0: number, cz: number, rBot: number, rTop: number, h: number, seg = 8, cap = true, capBottom = false): void {
    const slopeN = (rBot - rTop) / h;
    const nl = Math.hypot(1, slopeN);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const ul = (i / seg) * Math.PI * 2 * rBot, ur = ((i + 1) / seg) * Math.PI * 2 * rBot;
      const am = (a0 + a1) / 2;
      this.quad(
        [cx + c1 * rBot, y0, cz + s1 * rBot], [cx + c0 * rBot, y0, cz + s0 * rBot],
        [cx + c0 * rTop, y0 + h, cz + s0 * rTop], [cx + c1 * rTop, y0 + h, cz + s1 * rTop],
        [ur, y0], [ul, y0], [ul, y0 + h], [ur, y0 + h], [Math.cos(am) / nl, slopeN / nl, Math.sin(am) / nl],
      );
      if (cap && rTop > 0.001) {
        this.tri([cx, y0 + h, cz], [cx + c1 * rTop, y0 + h, cz + s1 * rTop], [cx + c0 * rTop, y0 + h, cz + s0 * rTop], [cx, cz], [cx + c1 * rTop, cz + s1 * rTop], [cx + c0 * rTop, cz + s0 * rTop], [0, 1, 0]);
      }
      if (capBottom) {
        this.tri([cx, y0, cz], [cx + c0 * rBot, y0, cz + s0 * rBot], [cx + c1 * rBot, y0, cz + s1 * rBot], [cx, cz], [cx + c0 * rBot, cz + s0 * rBot], [cx + c1 * rBot, cz + s1 * rBot], [0, -1, 0]);
      }
    }
  }

  /** Rectangle in an arbitrary plane. `right` and `up` are unit vectors; uv rect is [u0,v0,u1,v1]. */
  plane(centre: V3, right: V3, up: V3, w: number, h: number, uvRect: [number, number, number, number] = [0, 0, 1, 1]): void {
    const hw = w / 2, hh = h / 2;
    const P = (sx: number, sy: number): V3 => [
      centre[0] + right[0] * hw * sx + up[0] * hh * sy,
      centre[1] + right[1] * hw * sx + up[1] * hh * sy,
      centre[2] + right[2] * hw * sx + up[2] * hh * sy,
    ];
    const n: V3 = [
      right[1] * up[2] - right[2] * up[1],
      right[2] * up[0] - right[0] * up[2],
      right[0] * up[1] - right[1] * up[0],
    ];
    const [u0, v0, u1, v1] = uvRect;
    this.quad(P(-1, -1), P(1, -1), P(1, 1), P(-1, 1), [u0, v0], [u1, v0], [u1, v1], [u0, v1], n);
  }

  /**
   * Convex polygon in a wall plane (a window outline, e.g. a pointed arch).
   * pts are (x, y) in the plane measured from the plane origin; `right` / `up`
   * are unit axes; uv = (x/w, y/h) so shaders see 0..1 across the bounding box.
   */
  convexPoly(origin: V3, right: V3, up: V3, pts: [number, number][], w: number, h: number): void {
    const n: V3 = [
      right[1] * up[2] - right[2] * up[1],
      right[2] * up[0] - right[0] * up[2],
      right[0] * up[1] - right[1] * up[0],
    ];
    const P = (x: number, y: number): V3 => [
      origin[0] + right[0] * x + up[0] * y,
      origin[1] + right[1] * x + up[1] * y,
      origin[2] + right[2] * x + up[2] * y,
    ];
    let cxp = 0, cyp = 0;
    for (const p of pts) { cxp += p[0]; cyp += p[1]; }
    cxp /= pts.length; cyp /= pts.length;
    const c = P(cxp, cyp);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      this.tri(c, P(a[0], a[1]), P(b[0], b[1]), [cxp / w, cyp / h], [a[0] / w, a[1] / h], [b[0] / w, b[1] / h], n);
    }
  }

  /** Append an existing BufferGeometry, transformed by `matrix` (in local-frame coordinates). */
  addGeometry(geo: THREE.BufferGeometry, matrix?: THREE.Matrix4): void {
    const p = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    const uv = geo.getAttribute('uv');
    const index = geo.getIndex();
    const nm = new THREE.Matrix3();
    if (matrix) nm.getNormalMatrix(matrix);
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    const base = this.vertexCount;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      n.fromBufferAttribute(nrm, i);
      if (matrix) {
        v.applyMatrix4(matrix);
        n.applyMatrix3(nm).normalize();
      }
      this.vtx(v.x, v.y, v.z, n.x, n.y, n.z, uv ? uv.getX(i) : v.x, uv ? uv.getY(i) : v.y);
    }
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }

  build(): THREE.BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('aA', new THREE.Float32BufferAttribute(this.va, 4));
    g.setAttribute('aB', new THREE.Float32BufferAttribute(this.vb, 4));
    g.setAttribute('aC', new THREE.Float32BufferAttribute(this.vc, 4));
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
