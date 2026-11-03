// Deterministic Voronoi pre-fracture of a box piece (pure math, no Three.js).
//
// The box is clipped by the bisector planes of seed points, so every cell is an
// exactly convex polyhedron and the cells tile the box with no gaps. Seed
// placement depends on the material so panels break into plausible chunks:
//   brick     blocks on a jittered brick lattice
//   concrete / stone / wood / steel   large chunks (relaxed blue-noise points)
//   glass     thin panels: a radial crack pattern (rings and spokes) around an
//             impact point; thick glass falls back to many small chunks
//
// Each cell yields a `Shard` (centroid, hull relative to the centroid, volume)
// plus a render mesh in the shard-local frame. Render vertices also carry the
// piece-local position (for materials that stay glued to the piece) and a flag
// telling an outer face (0, keeps the piece's surface look) from an inner
// fracture face (1, broken-core look).

import type { DMaterial, PieceKind, Shard } from './types';

export interface FractureGeo {
  /** xyz, relative to the shard centroid. */
  pos: Float32Array;
  /** xyz, face normals (flat shading). */
  nrm: Float32Array;
  /** xyz, piece-local position of each vertex. */
  ploc: Float32Array;
  /** 0 = outer (original surface), 1 = inner (fracture plane). */
  face: Float32Array;
  idx: Uint16Array;
}

export interface BoxFracture {
  shards: Shard[];
  geos: FractureGeo[];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- polyhedron clipping

/** A face is a CCW (seen from outside) polygon: flat xyz array + tag (0 outer, 1 fracture). */
interface Face {
  v: number[];
  tag: number;
}

const EPS = 1e-9;

function boxFaces(hx: number, hy: number, hz: number): Face[] {
  const f = (pts: number[][]): Face => ({ v: pts.flat(), tag: 0 });
  return [
    f([[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]]), // +x
    f([[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]]), // -x
    f([[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]]), // +y
    f([[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]]), // -y
    f([[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]), // +z
    f([[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]), // -z
  ];
}

/** Keep the half-space n.p <= d. Appends a cap face (tag 1) on the plane. */
function clip(faces: Face[], nx: number, ny: number, nz: number, d: number): Face[] {
  const out: Face[] = [];
  const cut: number[] = []; // intersection points on the plane
  for (const face of faces) {
    const v = face.v;
    const n = v.length / 3;
    const poly: number[] = [];
    let anyOut = false;
    let prevIdx = n - 1;
    let ps = nx * v[prevIdx * 3] + ny * v[prevIdx * 3 + 1] + nz * v[prevIdx * 3 + 2] - d;
    for (let i = 0; i < n; i++) {
      const cs = nx * v[i * 3] + ny * v[i * 3 + 1] + nz * v[i * 3 + 2] - d;
      const pin = ps <= EPS;
      const cin = cs <= EPS;
      if (cin !== pin) {
        const t = ps / (ps - cs);
        const px = v[prevIdx * 3] + (v[i * 3] - v[prevIdx * 3]) * t;
        const py = v[prevIdx * 3 + 1] + (v[i * 3 + 1] - v[prevIdx * 3 + 1]) * t;
        const pz = v[prevIdx * 3 + 2] + (v[i * 3 + 2] - v[prevIdx * 3 + 2]) * t;
        poly.push(px, py, pz);
        cut.push(px, py, pz);
      }
      if (cin) poly.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
      else anyOut = true;
      if (cs > EPS) anyOut = true;
      prevIdx = i;
      ps = cs;
    }
    if (!anyOut) {
      out.push(face);
    } else if (poly.length >= 9) {
      out.push({ v: poly, tag: face.tag });
    }
    // Vertices exactly on the plane also belong to the cap.
    for (let i = 0; i < n; i++) {
      const s = nx * v[i * 3] + ny * v[i * 3 + 1] + nz * v[i * 3 + 2] - d;
      if (Math.abs(s) <= EPS && anyOut) cut.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
    }
  }
  if (cut.length >= 9) {
    const cap = capPolygon(cut, nx, ny, nz);
    if (cap) out.push(cap);
  }
  return out;
}

/** Dedupe the cut points, order them CCW seen from +n. */
function capPolygon(cut: number[], nx: number, ny: number, nz: number): Face | null {
  const pts: number[] = [];
  const tol = 1e-6;
  for (let i = 0; i < cut.length; i += 3) {
    let dup = false;
    for (let j = 0; j < pts.length; j += 3) {
      if (Math.abs(pts[j] - cut[i]) < tol && Math.abs(pts[j + 1] - cut[i + 1]) < tol && Math.abs(pts[j + 2] - cut[i + 2]) < tol) {
        dup = true;
        break;
      }
    }
    if (!dup) pts.push(cut[i], cut[i + 1], cut[i + 2]);
  }
  const n = pts.length / 3;
  if (n < 3) return null;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += pts[i * 3]; cy += pts[i * 3 + 1]; cz += pts[i * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;
  // plane basis
  let ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = Math.abs(nx) < 0.9 ? 0 : 1, az = 0;
  let ux = ay * nz - az * ny, uy = az * nx - ax * nz, uz = ax * ny - ay * nx;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const order: Array<{ a: number; i: number }> = [];
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 3] - cx, dy = pts[i * 3 + 1] - cy, dz = pts[i * 3 + 2] - cz;
    order.push({ a: Math.atan2(dx * vx + dy * vy + dz * vz, dx * ux + dy * uy + dz * uz), i });
  }
  order.sort((p, q) => p.a - q.a);
  const v: number[] = [];
  for (const o of order) v.push(pts[o.i * 3], pts[o.i * 3 + 1], pts[o.i * 3 + 2]);
  return { v, tag: 1 };
}

// ---------------------------------------------------------------- seed points

type Pt = [number, number, number];

function latticeCounts(count: number, ex: number, ey: number, ez: number, bx: number, by: number, bz: number): [number, number, number] {
  // Start from how many brick-size blocks fit, then scale to land near `count`.
  let nx = Math.max(1, Math.round(ex / bx));
  let ny = Math.max(1, Math.round(ey / by));
  let nz = Math.max(1, Math.round(ez / bz));
  for (let guard = 0; guard < 40 && nx * ny * nz > count; guard++) {
    // shrink the axis with the most cells
    if (nx >= ny && nx >= nz && nx > 1) nx--;
    else if (ny >= nz && ny > 1) ny--;
    else if (nz > 1) nz--;
    else break;
  }
  for (let guard = 0; guard < 40 && nx * ny * nz * 1.5 < count; guard++) {
    const rx = ex / nx / bx, ry = ey / ny / by, rz = ez / nz / bz;
    if (rx >= ry && rx >= rz) nx++;
    else if (ry >= rz) ny++;
    else nz++;
  }
  return [nx, ny, nz];
}

function seedPoints(material: DMaterial, kind: PieceKind, hx: number, hy: number, hz: number, count: number, rnd: () => number): Pt[] {
  const pts: Pt[] = [];
  const ex = hx * 2, ey = hy * 2, ez = hz * 2;
  const dims = [ex, ey, ez];
  const thin = dims.indexOf(Math.min(ex, ey, ez));
  const thick = dims[thin];
  const others = dims.filter((_, i) => i !== thin);
  const isThin = thick < 0.35 * Math.min(others[0], others[1]);

  if (material === 'glass' && isThin) {
    // Radial cracks around an impact point on the pane: rings of spokes.
    const a1 = (thin + 1) % 3, a2 = (thin + 2) % 3;
    const h1 = dims[a1] / 2, h2 = dims[a2] / 2;
    const c1 = (rnd() - 0.5) * h1 * 0.8, c2 = (rnd() - 0.5) * h2 * 0.8;
    const rings = count > 8 ? 2 : 1;
    const perRing = Math.max(3, Math.floor((count - 1) / rings));
    const rMax = Math.hypot(h1, h2);
    const mk = (u: number, v: number): Pt => {
      const p: Pt = [0, 0, 0];
      p[a1] = Math.max(-h1 * 0.98, Math.min(h1 * 0.98, u));
      p[a2] = Math.max(-h2 * 0.98, Math.min(h2 * 0.98, v));
      p[thin] = (rnd() - 0.5) * thick * 0.1;
      return p;
    };
    pts.push(mk(c1, c2));
    for (let r = 0; r < rings; r++) {
      const rad = rMax * (0.22 + 0.4 * r + rnd() * 0.12);
      const off = rnd() * Math.PI * 2;
      for (let i = 0; i < perRing && pts.length < count; i++) {
        const ang = off + ((i + (rnd() - 0.5) * 0.45) / perRing) * Math.PI * 2;
        pts.push(mk(c1 + Math.cos(ang) * rad, c2 + Math.sin(ang) * rad));
      }
    }
    return pts;
  }

  if (material === 'brick') {
    const [nx, ny, nz] = latticeCounts(count, ex, ey, ez, 0.45, 0.3, 0.3);
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++)
        for (let k = 0; k < nz; k++) {
          const jx = (rnd() - 0.5) * 0.3, jy = (rnd() - 0.5) * 0.3, jz = (rnd() - 0.5) * 0.3;
          // running bond: odd rows shift half a block along the longest horizontal axis
          const shift = (j & 1) * 0.5;
          pts.push([
            -hx + ((i + 0.5 + jx + (ex >= ez ? shift * 0.5 : 0)) / nx) * ex,
            -hy + ((j + 0.5 + jy) / ny) * ey,
            -hz + ((k + 0.5 + jz + (ex < ez ? shift * 0.5 : 0)) / nz) * ez,
          ]);
        }
    for (const p of pts) {
      p[0] = Math.max(-hx * 0.98, Math.min(hx * 0.98, p[0]));
      p[2] = Math.max(-hz * 0.98, Math.min(hz * 0.98, p[2]));
    }
    return pts;
  }

  // Chunky materials and thick glass: best-candidate sampling spreads the points
  // evenly so no sliver cells appear. Distances are in a normalised box so a long
  // panel splits along its length.
  const cands = 14;
  const norm = Math.cbrt(ex * ey * ez) || 1;
  const small = material === 'glass' || kind === 'window';
  for (let n = 0; n < count; n++) {
    let best: Pt = [0, 0, 0];
    let bestD = -1;
    for (let c = 0; c < cands; c++) {
      const p: Pt = [(rnd() - 0.5) * ex * 0.96, (rnd() - 0.5) * ey * 0.96, (rnd() - 0.5) * ez * 0.96];
      let md = Infinity;
      for (const q of pts) {
        const dx = (p[0] - q[0]) / norm, dy = (p[1] - q[1]) / norm, dz = (p[2] - q[2]) / norm;
        md = Math.min(md, dx * dx + dy * dy + dz * dz);
      }
      if (n === 0) md = 1;
      if (md > bestD) { bestD = md; best = p; }
    }
    if (small && thin >= 0) best[thin] *= 0.3;
    pts.push(best);
  }
  return pts;
}

// ---------------------------------------------------------------- cell -> shard + mesh

function cellMesh(faces: Face[], cx: number, cy: number, cz: number): FractureGeo {
  let nv = 0, ni = 0;
  for (const f of faces) {
    const n = f.v.length / 3;
    nv += n;
    ni += (n - 2) * 3;
  }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), ploc = new Float32Array(nv * 3), fl = new Float32Array(nv);
  const idx = new Uint16Array(ni);
  let vi = 0, ii = 0;
  for (const f of faces) {
    const v = f.v;
    const n = v.length / 3;
    // Newell normal
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = v[i * 3], y0 = v[i * 3 + 1], z0 = v[i * 3 + 2], x1 = v[j * 3], y1 = v[j * 3 + 1], z1 = v[j * 3 + 2];
      nx += (y0 - y1) * (z0 + z1);
      ny += (z0 - z1) * (x0 + x1);
      nz += (x0 - x1) * (y0 + y1);
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const base = vi;
    for (let i = 0; i < n; i++) {
      pos[vi * 3] = v[i * 3] - cx;
      pos[vi * 3 + 1] = v[i * 3 + 1] - cy;
      pos[vi * 3 + 2] = v[i * 3 + 2] - cz;
      ploc[vi * 3] = v[i * 3];
      ploc[vi * 3 + 1] = v[i * 3 + 1];
      ploc[vi * 3 + 2] = v[i * 3 + 2];
      nrm[vi * 3] = nx; nrm[vi * 3 + 1] = ny; nrm[vi * 3 + 2] = nz;
      fl[vi] = f.tag;
      vi++;
    }
    for (let i = 1; i < n - 1; i++) {
      idx[ii++] = base;
      idx[ii++] = base + i;
      idx[ii++] = base + i + 1;
    }
  }
  return { pos, nrm, ploc, face: fl, idx };
}

/** Volume, volume-weighted centroid and unique vertices of a closed polyhedron. */
function measure(faces: Face[]): { vol: number; c: Pt; verts: number[] } {
  // Reference point = average of all face vertices for numerical stability.
  let rx = 0, ry = 0, rz = 0, cnt = 0;
  for (const f of faces) for (let i = 0; i < f.v.length; i += 3) { rx += f.v[i]; ry += f.v[i + 1]; rz += f.v[i + 2]; cnt++; }
  rx /= cnt; ry /= cnt; rz /= cnt;
  let vol = 0, cx = 0, cy = 0, cz = 0;
  const verts: number[] = [];
  const tol = 1e-6;
  for (const f of faces) {
    const v = f.v;
    const n = v.length / 3;
    for (let i = 0; i < n; i++) {
      let dup = false;
      for (let j = 0; j < verts.length; j += 3) {
        if (Math.abs(verts[j] - v[i * 3]) < tol && Math.abs(verts[j + 1] - v[i * 3 + 1]) < tol && Math.abs(verts[j + 2] - v[i * 3 + 2]) < tol) { dup = true; break; }
      }
      if (!dup) verts.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
    }
    for (let i = 1; i < n - 1; i++) {
      const ax = v[0] - rx, ay = v[1] - ry, az = v[2] - rz;
      const bx = v[i * 3] - rx, by = v[i * 3 + 1] - ry, bz = v[i * 3 + 2] - rz;
      const qx = v[(i + 1) * 3] - rx, qy = v[(i + 1) * 3 + 1] - ry, qz = v[(i + 1) * 3 + 2] - rz;
      const tv = (ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)) / 6;
      vol += tv;
      cx += tv * (ax + bx + qx) / 4;
      cy += tv * (ay + by + qy) / 4;
      cz += tv * (az + bz + qz) / 4;
    }
  }
  if (vol <= 1e-12) return { vol: 0, c: [rx, ry, rz], verts };
  return { vol, c: [rx + cx / vol, ry + cy / vol, rz + cz / vol], verts };
}

/**
 * Fracture a box of half extents (hx, hy, hz) centred on the origin into about
 * `count` convex cells. Deterministic in (seed, material, kind, extents, count).
 */
export function fractureBox(
  hx: number, hy: number, hz: number, material: DMaterial, kind: PieceKind, seed: number, count: number,
): BoxFracture {
  const n = Math.max(2, Math.min(12, Math.round(count)));
  const rnd = mulberry32(seed ^ 0x51ed270b);
  const sites = seedPoints(material, kind, hx, hy, hz, n, rnd);
  const shards: Shard[] = [];
  const geos: FractureGeo[] = [];
  const full = boxFaces(hx, hy, hz);
  const maxR = Math.hypot(hx, hy, hz) * 2;
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    // Nearest neighbours first so the early-out below prunes most planes.
    const order = sites.map((_, j) => j).filter((j) => j !== i);
    const dist = (j: number): number => Math.hypot(sites[j][0] - s[0], sites[j][1] - s[1], sites[j][2] - s[2]);
    order.sort((a, b) => dist(a) - dist(b));
    let faces = full;
    let radius = maxR;
    for (const j of order) {
      const q = sites[j];
      const dx = q[0] - s[0], dy = q[1] - s[1], dz = q[2] - s[2];
      const dl = Math.hypot(dx, dy, dz);
      if (dl < 1e-7) continue;
      if (dl * 0.5 > radius) break; // plane is beyond every remaining vertex
      const nx = dx / dl, ny = dy / dl, nz = dz / dl;
      const d = nx * (s[0] + q[0]) * 0.5 + ny * (s[1] + q[1]) * 0.5 + nz * (s[2] + q[2]) * 0.5;
      faces = clip(faces, nx, ny, nz, d);
      if (faces.length < 4) break;
      radius = 0;
      for (const f of faces) for (let k = 0; k < f.v.length; k += 3) radius = Math.max(radius, Math.hypot(f.v[k] - s[0], f.v[k + 1] - s[1], f.v[k + 2] - s[2]));
    }
    if (faces.length < 4) continue;
    // drop degenerate faces
    faces = faces.filter((f) => f.v.length >= 9);
    const m = measure(faces);
    if (m.vol < 1e-9) continue;
    const hull = new Float32Array(m.verts.length);
    for (let k = 0; k < m.verts.length; k += 3) {
      hull[k] = m.verts[k] - m.c[0];
      hull[k + 1] = m.verts[k + 1] - m.c[1];
      hull[k + 2] = m.verts[k + 2] - m.c[2];
    }
    shards.push({ center: [m.c[0], m.c[1], m.c[2]], hull, volume: m.vol });
    geos.push(cellMesh(faces, m.c[0], m.c[1], m.c[2]));
  }
  return { shards, geos };
}

/** The intact piece as a single "cell" in the same vertex format (centred on the origin). */
export function boxGeo(hx: number, hy: number, hz: number): FractureGeo {
  return cellMesh(boxFaces(hx, hy, hz), 0, 0, 0);
}
