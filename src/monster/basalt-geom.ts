// Procedural rock geometry for Basalt: noise-displaced icosahedron blobs, hexagonal
// basalt columns, jittered slabs and spikes. Everything is non-indexed with flat
// face normals (crisp facets), and each vertex carries the extra attributes the
// rock material needs:
//
//   aRest  vec3  position in the monster's rest pose (a stable domain for the lava
//                 crack field, so cracks stay glued to the body while bones move)
//   aEdge  vec4  distances (m) to the nearest edge of the polygon face it belongs
//                 to (min of the 4 comps) -> worn-edge highlights
//   aMat   vec4  x = molten amount (0 rock .. 1 pure lava), y = crack density
//                 multiplier, z = tint (brightness multiplier), w = per-chunk random
//
// Chunks are built in unit-ish local space, then placed into a bone with a
// matrix; MeshBuilder merges every chunk of one bone into one BufferGeometry.

import * as THREE from 'three/webgpu';

// ------------------------------------------------------------------ random

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** Smooth 3D value noise in [-1, 1]. */
export function vnoise(x: number, y: number, z: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  let acc = 0;
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const w = (i ? ux : 1 - ux) * (j ? uy : 1 - uy) * (k ? uz : 1 - uz);
        acc += w * hash3(ix + i, iy + j, iz + k, seed);
      }
    }
  }
  return acc;
}

// ------------------------------------------------------------------ chunks

type V3 = [number, number, number];

/** A bag of triangles (positions + per-vertex edge distances) in chunk-local space. */
export interface Chunk {
  p: number[];
  e: number[];
  /** Used to orient faces outward (all chunks are roughly convex). */
  centre: V3;
}

class Sink {
  p: number[] = [];
  e: number[] = [];

  tri(a: V3, b: V3, c: V3): void {
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
    const ca = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const ha = area2 / Math.max(1e-6, bc); // altitude from a, i.e. distance to edge bc
    const hb = area2 / Math.max(1e-6, ca);
    const hc = area2 / Math.max(1e-6, ab);
    this.p.push(...a, ...b, ...c);
    this.e.push(ha, 0, 0, 99, 0, hb, 0, 99, 0, 0, hc, 99);
  }

  /** Quad a,b,c,d in ring order (a-b is the u axis, a-d the v axis). */
  quad(a: V3, b: V3, c: V3, d: V3): void {
    const w = (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) + Math.hypot(c[0] - d[0], c[1] - d[1], c[2] - d[2])) / 2;
    const h = (Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]) + Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2])) / 2;
    const ev = (u: number, v: number): number[] => [u * w, (1 - u) * w, v * h, (1 - v) * h];
    this.p.push(...a, ...b, ...c, ...a, ...c, ...d);
    this.e.push(...ev(0, 0), ...ev(1, 0), ...ev(1, 1), ...ev(0, 0), ...ev(1, 1), ...ev(0, 1));
  }

  /** Convex polygon cap as a fan around its centroid (only the outer edge counts for highlights). */
  fan(ring: V3[], centre: V3): void {
    const n = ring.length;
    let apothem = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      const mx = (a[0] + b[0]) / 2 - centre[0];
      const my = (a[1] + b[1]) / 2 - centre[1];
      const mz = (a[2] + b[2]) / 2 - centre[2];
      apothem += Math.hypot(mx, my, mz);
    }
    apothem /= n;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      this.p.push(...centre, ...a, ...b);
      this.e.push(apothem, 99, 99, 99, 0, 99, 99, 99, 0, 99, 99, 99);
    }
  }

  chunk(centre: V3): Chunk {
    return { p: this.p, e: this.e, centre };
  }
}

// ------------------------------------------------------------------ generators

const icoCache = new Map<number, Float32Array>();
function icoPositions(detail: number): Float32Array {
  let cached = icoCache.get(detail);
  if (!cached) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    cached = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    icoCache.set(detail, cached);
  }
  return cached;
}

export interface BlobOptions {
  /** Icosahedron subdivision (0 = 20 tris, 1 = 80, 2 = 180, 3 = 320). */
  detail: number;
  seed: number;
  /** Radial noise amplitude (fraction of radius). */
  amp?: number;
  /** Noise frequency over the unit sphere. */
  freq?: number;
  /** 0..1 pulls vertices towards a faceted ellipsoid-with-flat-ends (squarer boulder). */
  squarish?: number;
}

/** A lumpy unit "boulder": displaced icosahedron. Scale it with the placement matrix. */
export function blob(o: BlobOptions): Chunk {
  const pos = icoPositions(o.detail);
  const amp = o.amp ?? 0.28;
  const freq = o.freq ?? 1.5;
  const sq = o.squarish ?? 0;
  const sink = new Sink();
  const v: V3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const sd = o.seed * 7.31;
  for (let t = 0; t < pos.length; t += 9) {
    for (let k = 0; k < 3; k++) {
      let x = pos[t + k * 3];
      let y = pos[t + k * 3 + 1];
      let z = pos[t + k * 3 + 2];
      const n = vnoise(x * freq + sd, y * freq - sd, z * freq + sd * 0.5, o.seed) * 0.8 + vnoise(x * freq * 2.3, y * freq * 2.3, z * freq * 2.3 + sd, o.seed + 9) * 0.35;
      let r = 1 + amp * n;
      if (sq > 0) {
        // Blend towards a cube projection so boulders look quarried rather than egg-shaped.
        const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
        r *= 1 - sq + sq / m;
      }
      x *= r;
      y *= r;
      z *= r;
      v[k] = [x, y, z];
    }
    sink.tri(v[0], v[1], v[2]);
  }
  return sink.chunk([0, 0, 0]);
}

export interface ColumnOptions {
  sides?: number;
  /** Radius at the bottom / top (circumradius). */
  rBot: number;
  rTop?: number;
  h: number;
  seed: number;
  /** Random top-height jitter as a fraction of rTop. */
  jag?: number;
  /** Top plane slant (rise per unit across the column), random sign if undefined. */
  slant?: number;
  /** If > 0, the top ends in a point this much taller than h. */
  tip?: number;
  /** Close the bottom with a cap (free-standing columns). */
  capBottom?: boolean;
  /** Ring rotation (rad). */
  rot?: number;
}

/** Basalt column along +Y from y=0 to y=h. */
export function column(o: ColumnOptions): Chunk {
  const n = o.sides ?? 6;
  const rng = makeRng(o.seed * 977 + 13);
  const rTop = o.rTop ?? o.rBot;
  const jag = o.jag ?? 0.35;
  const rot = o.rot ?? 0;
  const slant = o.slant ?? (rng() - 0.5) * 1.1;
  const slantDir = rng() * Math.PI * 2;
  const sx = Math.cos(slantDir) * slant;
  const sz = Math.sin(slantDir) * slant;
  const bot: V3[] = [];
  const top: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    const jb = 1 + (rng() - 0.5) * 0.08;
    const jt = 1 + (rng() - 0.5) * 0.08;
    const bx = Math.cos(a) * o.rBot * jb;
    const bz = Math.sin(a) * o.rBot * jb;
    const tx = Math.cos(a) * rTop * jt;
    const tz = Math.sin(a) * rTop * jt;
    bot.push([bx, 0, bz]);
    top.push([tx, o.h + (rng() - 0.5) * jag * rTop + sx * tx + sz * tz, tz]);
  }
  const sink = new Sink();
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // Winding is fixed up globally by the builder, so order only matters for the quad split.
    sink.quad(bot[i], bot[j], top[j], top[i]);
  }
  let ty = 0;
  for (const t of top) ty += t[1];
  ty /= n;
  if (o.tip && o.tip > 0) {
    const apex: V3 = [0, ty + o.tip, 0];
    for (let i = 0; i < n; i++) sink.tri(top[i], top[(i + 1) % n], apex);
  } else {
    sink.fan(top, [0, ty + (rng() - 0.3) * 0.1 * rTop, 0]);
  }
  if (o.capBottom) sink.fan(bot, [0, 0, 0]);
  return sink.chunk([0, o.h * 0.45, 0]);
}

export interface SlabOptions {
  seed: number;
  jitter?: number;
}

/** Unit cube [-0.5, 0.5]^3 with jittered corners: a quarried slab / plate. */
export function slab(o: SlabOptions): Chunk {
  const rng = makeRng(o.seed * 613 + 5);
  const j = o.jitter ?? 0.12;
  const c: V3[] = [];
  for (let i = 0; i < 8; i++) {
    c.push([
      (i & 1 ? 0.5 : -0.5) + (rng() - 0.5) * j,
      (i & 2 ? 0.5 : -0.5) + (rng() - 0.5) * j,
      (i & 4 ? 0.5 : -0.5) + (rng() - 0.5) * j,
    ]);
  }
  const sink = new Sink();
  // faces: -x, +x, -y, +y, -z, +z
  sink.quad(c[0], c[4], c[6], c[2]);
  sink.quad(c[1], c[3], c[7], c[5]);
  sink.quad(c[0], c[1], c[5], c[4]);
  sink.quad(c[2], c[6], c[7], c[3]);
  sink.quad(c[0], c[2], c[3], c[1]);
  sink.quad(c[4], c[5], c[7], c[6]);
  return sink.chunk([0, 0, 0]);
}

/** Pointed spike / claw along +Y, y in [0, h]. */
export function spike(r: number, h: number, seed: number, sides = 5): Chunk {
  return column({ sides, rBot: r, rTop: r * 0.12, h: h * 0.82, tip: h * 0.18, seed, jag: 0.05, slant: 0, capBottom: true });
}

// ------------------------------------------------------------------ builder

export interface PlaceOptions {
  p?: [number, number, number];
  /** Euler XYZ rotation (rad). */
  r?: [number, number, number];
  /** Non-uniform or uniform scale. */
  s?: [number, number, number] | number;
}

export interface MatOptions {
  /** 0..1: how molten the surface is regardless of the crack field. */
  lava?: number;
  /** Crack density multiplier (0 = no cracks, 1 = default, 2+ = riddled). */
  crack?: number;
  /** Brightness multiplier on the rock albedo (chunk-to-chunk variation). */
  tint?: number;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

export function placeMatrix(o: PlaceOptions): THREE.Matrix4 {
  const p = o.p ?? [0, 0, 0];
  const r = o.r ?? [0, 0, 0];
  const s = typeof o.s === 'number' ? [o.s, o.s, o.s] : (o.s ?? [1, 1, 1]);
  _e.set(r[0], r[1], r[2], 'YXZ');
  _q.setFromEuler(_e);
  _v.set(p[0], p[1], p[2]);
  _s.set(s[0], s[1], s[2]);
  return new THREE.Matrix4().compose(_v, _q, _s);
}

/** Accumulates chunks for ONE bone into one geometry. */
export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private rest: number[] = [];
  private edge: number[] = [];
  private mat: number[] = [];
  private rng: () => number;
  /** Chunks, for stats. */
  count = 0;

  /** @param restOffset bone's origin in rest-pose model space (bones have identity rest rotation). */
  constructor(
    readonly restOffset: THREE.Vector3,
    seed: number,
  ) {
    this.rng = makeRng(seed * 31 + 7);
  }

  get triangles(): number {
    return this.pos.length / 9;
  }

  add(chunk: Chunk, place: PlaceOptions | THREE.Matrix4, m: MatOptions = {}): void {
    const matrix = place instanceof THREE.Matrix4 ? place : placeMatrix(place);
    const lava = m.lava ?? 0;
    const crack = m.crack ?? 1;
    const tint = m.tint ?? 0.85 + this.rng() * 0.3;
    const rnd = this.rng();
    const cen = new THREE.Vector3(chunk.centre[0], chunk.centre[1], chunk.centre[2]).applyMatrix4(matrix);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const tris = chunk.p.length / 9;
    const mirrored = matrix.determinant() < 0;
    for (let t = 0; t < tris; t++) {
      a.set(chunk.p[t * 9], chunk.p[t * 9 + 1], chunk.p[t * 9 + 2]).applyMatrix4(matrix);
      b.set(chunk.p[t * 9 + 3], chunk.p[t * 9 + 4], chunk.p[t * 9 + 5]).applyMatrix4(matrix);
      c.set(chunk.p[t * 9 + 6], chunk.p[t * 9 + 7], chunk.p[t * 9 + 8]).applyMatrix4(matrix);
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      n.crossVectors(e1, e2);
      if (n.lengthSq() < 1e-10) continue; // degenerate
      n.normalize();
      // Orient outward relative to the chunk centre.
      const outward = n.x * (a.x - cen.x) + n.y * (a.y - cen.y) + n.z * (a.z - cen.z);
      const flip = outward < 0;
      void mirrored;
      const order = flip ? [0, 2, 1] : [0, 1, 2];
      if (flip) n.negate();
      const verts = [a, b, c];
      for (const k of order) {
        const v = verts[k];
        this.pos.push(v.x, v.y, v.z);
        this.nrm.push(n.x, n.y, n.z);
        this.rest.push(v.x + this.restOffset.x, v.y + this.restOffset.y, v.z + this.restOffset.z);
        this.edge.push(chunk.e[t * 12 + k * 4], chunk.e[t * 12 + k * 4 + 1], chunk.e[t * 12 + k * 4 + 2], chunk.e[t * 12 + k * 4 + 3]);
        this.mat.push(lava, crack, tint, rnd);
      }
    }
    this.count++;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aRest', new THREE.Float32BufferAttribute(this.rest, 3));
    g.setAttribute('aEdge', new THREE.Float32BufferAttribute(this.edge, 4));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 4));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ------------------------------------------------------------------ bundles

export interface BundleOptions {
  /** Base centre (bone-local). */
  origin: [number, number, number];
  /** Axis direction (unit-ish). Columns grow along it. */
  dir: [number, number, number];
  /** Hex rings around the centre column (0 = single, 1 = 7 columns, 2 = 19). */
  rings: number;
  /** Column circumradius. */
  colR: number;
  /** Nominal length. */
  len: number;
  /** 0..1 fraction of length the columns vary by. */
  lenVar?: number;
  /** Tip radius as a fraction of the bundle radius at the base (1 = no taper, <1 converges). */
  taper?: number;
  seed: number;
  detailSides?: number;
  lava?: number;
  crack?: number;
  /** Keep the centre column dark molten (shows in the gaps). */
  coreLava?: number;
  tint?: number;
  /** Extra per-column tilt jitter (rad). */
  wobble?: number;
}

const _up = new THREE.Vector3(0, 1, 0);

/** A hexagonal-packed bundle of basalt columns: the monster's signature limb / plate construction. */
export function addBundle(mb: MeshBuilder, o: BundleOptions): void {
  const rng = makeRng(o.seed * 1319 + 3);
  const dir = new THREE.Vector3(...o.dir).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(_up, dir);
  const sp = o.colR * Math.sqrt(3) * 1.02; // centre spacing (tiny gap -> lava shows)
  const d0 = new THREE.Vector2(Math.cos(Math.PI / 6), Math.sin(Math.PI / 6));
  const d1 = new THREE.Vector2(0, 1);
  const lenVar = o.lenVar ?? 0.25;
  const taper = o.taper ?? 1;
  const wob = o.wobble ?? 0.03;
  const R = o.rings;
  const bundleR = R * sp + o.colR;
  for (let a = -R; a <= R; a++) {
    for (let b = -R; b <= R; b++) {
      if (Math.max(Math.abs(a), Math.abs(b), Math.abs(a + b)) > R) continue;
      const lx = (d0.x * a + d1.x * b) * sp;
      const lz = (d0.y * a + d1.y * b) * sp;
      const dist = Math.hypot(lx, lz);
      const outer = bundleR > 0 ? dist / bundleR : 0;
      // Outer columns are shorter (rounded bundle), with random variation.
      const L = o.len * (1 - outer * 0.35 * lenVar * 2) * (1 + (rng() - 0.5) * lenVar);
      // Converge toward the axis along the length when tapering.
      const tilt = dist > 0 ? Math.atan(((1 - taper) * dist) / Math.max(0.1, o.len)) : 0;
      const baseAng = Math.atan2(lz, lx);
      const colQ = new THREE.Quaternion();
      // Tilt inwards about the axis perpendicular to the radial direction.
      const ax = new THREE.Vector3(Math.sin(baseAng), 0, -Math.cos(baseAng));
      colQ.setFromAxisAngle(ax, tilt + (rng() - 0.5) * wob);
      const jitterR = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(rng() - 0.5, 0, rng() - 0.5).normalize(), (rng() - 0.5) * wob);
      colQ.premultiply(jitterR);
      const isCore = a === 0 && b === 0;
      const col = column({
        sides: o.detailSides ?? 6,
        rBot: o.colR * (isCore ? 0.92 : 1),
        rTop: o.colR * (0.96 - 0.05 * rng()) * (1 - (1 - taper) * 0.35),
        h: L,
        seed: o.seed * 100 + a * 11 + b * 7,
        jag: 0.4,
        rot: 0,
      });
      const pos = new THREE.Vector3(lx, 0, lz).applyQuaternion(q).add(new THREE.Vector3(...o.origin));
      const full = new THREE.Quaternion().copy(q).multiply(colQ);
      const mtx = new THREE.Matrix4().compose(pos, full, new THREE.Vector3(1, 1, 1));
      mb.add(col, mtx, {
        lava: isCore ? (o.coreLava ?? 0) : (o.lava ?? 0),
        crack: o.crack ?? 1,
        tint: o.tint ?? undefined,
      });
    }
  }
}
