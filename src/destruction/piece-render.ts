// Destruction renderer: draws woken building pieces, fracture shards and baked
// rubble with a small, fixed number of draw calls.
//
// - Live pieces and shards: one BatchedMesh per look (brick, concrete, ...),
//   chained when one fills up. Each handle is one geometry + one instance, its
//   matrix set every frame. Draw calls = number of batches, not handles.
// - hideBuilding: the town's merged meshes stay untouched; the triangles of one
//   building (from `town.buildingRanges`) are overwritten with degenerate
//   indices and only that index sub-range is re-uploaded.
// - bakeToRubble: handles at rest are transformed to world space and appended
//   to a per-look static rubble mesh (a ring of fixed-size chunks), then their
//   batch instance is freed. Rubble cost is bounded by the chunk count per
//   look; when every chunk is full the oldest one is recycled.
// - No per-frame allocation: setTransform reuses scratch objects; buffers are
//   preallocated and only grow when a batch or chunk is added.
//
// Handle convention: the transform of a piece handle is the piece CENTRE frame;
// the transform of a shard handle is the shard CENTROID frame (the shard
// geometry is relative to its centroid, like `Shard.hull`).
//
// A handle of -1 means "not drawn" (live shard budget exceeded); every method
// ignores it.

import * as THREE from 'three/webgpu';
import { color as tslColor, float as tslFloat, frontFacing, select as tslSelect } from 'three/tsl';
import type { QualityPreset } from '../core/types';
import { boxGeo, fractureBox, type FractureGeo } from './fracture';
import { createPieceMaterials, lookFor, type Look } from './piece-materials';
import type { BuildingGraph, DestructionRenderer, FractureResult, PieceDef, RenderHandle } from './types';

/** The slice of `buildTown`'s result the renderer needs. */
export interface TownLike {
  group: THREE.Group;
  buildingRanges: Array<{ id: number; part: string; triStart: number; triCount: number }>;
}

// ---------------------------------------------------------------- geometry cache

/** Immutable render data of one cell (a shard or an intact box). */
interface GeoData {
  pos: Float32Array;
  nrm: Float32Array;
  ploc: Float32Array;
  pn: Float32Array;
  idx: Uint16Array;
  vCount: number;
  bg: THREE.BufferGeometry | null;
}

function buildGeoData(g: FractureGeo, piece: PieceDef): GeoData {
  const vCount = g.pos.length / 3;
  const seed01 = (piece.seed >>> 0) % 990 / 1000;
  // Piece-local texture position gets a per-piece x/z offset so neighbours differ.
  const hs = (piece.seed * 2654435761) >>> 0;
  const ox = ((hs & 0xffff) / 0xffff) * 40;
  const oz = (((hs >>> 16) & 0xffff) / 0xffff) * 40;
  const ploc = new Float32Array(vCount * 3);
  const pn = new Float32Array(vCount * 4);
  for (let i = 0; i < vCount; i++) {
    ploc[i * 3] = g.ploc[i * 3] + ox;
    ploc[i * 3 + 1] = g.ploc[i * 3 + 1];
    ploc[i * 3 + 2] = g.ploc[i * 3 + 2] + oz;
    pn[i * 4] = g.nrm[i * 3];
    pn[i * 4 + 1] = g.nrm[i * 3 + 1];
    pn[i * 4 + 2] = g.nrm[i * 3 + 2];
    pn[i * 4 + 3] = g.face[i] + seed01;
  }
  return { pos: g.pos, nrm: g.nrm, ploc, pn, idx: g.idx, vCount, bg: null };
}

function geoBuffer(d: GeoData): THREE.BufferGeometry {
  if (d.bg) return d.bg;
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
  bg.setAttribute('normal', new THREE.BufferAttribute(d.nrm, 3));
  bg.setAttribute('plocal', new THREE.BufferAttribute(d.ploc, 3));
  bg.setAttribute('pn', new THREE.BufferAttribute(d.pn, 4));
  bg.setIndex(new THREE.BufferAttribute(d.idx, 1));
  d.bg = bg;
  return bg;
}

interface FractureEntry {
  result: FractureResult;
  look: Look;
  cells: GeoData[];
  piece: PieceDef;
}

// ---------------------------------------------------------------- batches

const BATCH_INSTANCES = 1024;
const BATCH_VERTS = 60000; // stays inside Uint16 indices
const BATCH_INDICES = 180000;

interface Batch {
  mesh: THREE.BatchedMesh;
  instances: number;
  /** Append pointers (only shrink on optimize) and live totals. */
  vTop: number;
  iTop: number;
  vLive: number;
  iLive: number;
}

interface Handle {
  id: number;
  alive: boolean;
  /** Progressive pieces are drawn lazily: the piece and its inset until the first time they are shown. */
  piece: PieceDef | null;
  inset: number;
  look: Look;
  batch: Batch | null;
  geoId: number;
  inst: number;
  data: GeoData | null;
  tintR: number;
  tintG: number;
  tintB: number;
  damage: number;
  isShard: boolean;
  /** Progressive-wake state: no geometry exists (the town's own mesh shows) until the piece moves, is removed or is baked. */
  pc: PieceState | null;
}

/** One piece of a woken building whose merged town triangles are handed over piece by piece. */
interface PieceState {
  bld: WokenBuilding;
  handle: number;
  activated: boolean;
  /** Rest pose (world): px py pz, qx qy qz qw. */
  rest: Float64Array;
  /** Rest box in building-local space: centre then half extents. */
  box: Float64Array;
  /** Slab / column / beam: shown (inset) as interior structure once the building has a hole. */
  structural: boolean;
  /** Visible as interior structure without having taken over town triangles. */
  shown: boolean;
  /** Town triangles that belong to this piece (meshIdx * TRI_MESH + index offset), filled lazily. */
  tris: number[];
  /** Which town material parts the piece's triangles came from (VOTE_LOOKS order) and their summed tint. */
  votes: number[];
  ts: number[];
  tn: number;
}

interface WokenBuilding {
  specId: number;
  x: number;
  z: number;
  cs: number;
  sn: number;
  pieces: PieceState[];
  assigned: boolean;
  interior: boolean;
}

/** Index offsets stay below this inside one merged mesh. */
const TRI_MESH = 67108864;
/** Pose deviation that counts as 'moved' (metres, quaternion component), and damage that shows cracks. */
const MOVE_EPS = 0.03;
const ROT_EPS = 0.004;
/** Town merged-mesh parts that tell a piece which masonry variant it is (index = vote slot). */
const VOTE_PARTS = ['brick', 'sandstone', 'sootStone', 'concrete', 'slate'];
const VOTE_LOOKS: Look[] = ['brick', 'stone', 'soot', 'concrete', 'slate'];
/** A town triangle farther than this from every piece box is detail the piece grid does not cover: it stays. */
const ASSIGN_MAX = 2.5;

// ---------------------------------------------------------------- rubble

interface RubbleChunk {
  mesh: THREE.Mesh;
  pos: Float32Array;
  nrm: Float32Array;
  ploc: Float32Array;
  pn: Float32Array;
  tint: Float32Array;
  index: Uint32Array;
  vUsed: number;
  iUsed: number;
}

interface RubbleSet {
  chunks: RubbleChunk[];
  current: number;
}

const RUBBLE_CHUNK_VERTS = 32768;
const RUBBLE_CHUNK_INDICES = 90000;

export function createDestructionRenderer(scene: THREE.Scene, town: TownLike, quality: QualityPreset): DestructionRenderer {
  const batchMats = createPieceMaterials(quality, 'batch');
  const staticMats = createPieceMaterials(quality, 'static');
  const castShadow = quality.shadowsOnCity && quality.shadowMapSize > 0;

  const root = new THREE.Group();
  root.name = 'destruction';
  scene.add(root);

  // live-shard budget: renderer side guard on top of the simulation's own cap
  const maxShardHandles = quality.maxActiveChunks * 2;
  const tierIdx = { low: 0, medium: 1, high: 2, ultra: 3 }[quality.level];
  const maxChunksPerLook = [2, 3, 6, 10][tierIdx];

  const handles: Handle[] = [];
  const pieceStates = new WeakMap<PieceDef, PieceState>();
  const freeIds: number[] = [];
  /** Current transform per handle (px py pz qx qy qz qw), needed to bake. */
  let tr = new Float32Array(256 * 7);
  let liveHandles = 0;
  let liveShards = 0;

  const batches = new Map<Look, Batch[]>();
  const rubble = new Map<Look, RubbleSet>();
  let rubbleTriangles = 0;

  const scratchM = new THREE.Matrix4();
  const scratchP = new THREE.Vector3();
  const scratchQ = new THREE.Quaternion();
  const scratchS = new THREE.Vector3(1, 1, 1);
  const scratchC = new THREE.Vector4();

  // ------------------------------------------------ hideBuilding

  const rangesByBuilding = new Map<number, Array<{ mesh: THREE.Mesh; start: number; count: number }>>();
  {
    const meshByPart = new Map<string, THREE.Mesh>();
    town.group.traverse((o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      const part = m.userData?.part as string | undefined;
      if (m.isMesh && part && m.name === `town-${part}`) meshByPart.set(part, m);
    });
    for (const r of town.buildingRanges) {
      const mesh = meshByPart.get(r.part);
      if (!mesh) continue;
      let list = rangesByBuilding.get(r.id);
      if (!list) rangesByBuilding.set(r.id, (list = []));
      list.push({ mesh, start: r.triStart * 3, count: r.triCount * 3 });
    }
  }
  const hidden = new Set<number>();
  /** Buildings the sim woke (hideBuilding) that have not had pieces added: fully hidden at the next update. */
  const pendingWake = new Set<number>();
  const woken = new Map<number, WokenBuilding>();
  const meshList: THREE.Mesh[] = [];
  const meshDirty = new Map<THREE.Mesh, [number, number]>();

  function markIndexDirty(mesh: THREE.Mesh, lo: number, hi: number): void {
    const d = meshDirty.get(mesh);
    if (!d) meshDirty.set(mesh, [lo, hi]);
    else {
      if (lo < d[0]) d[0] = lo;
      if (hi > d[1]) d[1] = hi;
    }
  }

  function hideAll(specId: number): void {
    if (hidden.has(specId)) return;
    hidden.add(specId);
    const list = rangesByBuilding.get(specId);
    if (!list) return;
    for (const r of list) {
      const index = r.mesh.geometry.index;
      if (!index) continue;
      (index.array as Uint16Array | Uint32Array).fill(0, r.start, r.start + r.count);
      index.clearUpdateRanges();
      index.addUpdateRange(r.start, r.count);
      index.needsUpdate = true;
    }
  }

  /**
   * The sim woke a building. Its merged town visuals stay (so a woken building looks exactly like the
   * intact one) and are handed over triangle by triangle as pieces move, take damage or break; the
   * pieces themselves are invisible until then. If no pieces are added the building is hidden whole.
   */
  function hideBuilding(specId: number): void {
    if (hidden.has(specId) || woken.has(specId)) return;
    pendingWake.add(specId);
  }

  /** Back faces seen through a hole are the room's inside: dark, with dim window light. One clone per town material. */
  const interiorMats = new Map<THREE.Material, THREE.Material>();
  function interiorMaterial(m: THREE.Material): THREE.Material {
    let c = interiorMats.get(m);
    if (c) return c;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nm = m.clone() as any;
    nm.side = THREE.DoubleSide;
    const dark = tslSelect(frontFacing, tslFloat(1), tslFloat(0.2));
    nm.colorNode = (nm.colorNode ?? tslColor(nm.color ?? 0x808080)).mul(dark);
    if (nm.emissiveNode) nm.emissiveNode = nm.emissiveNode.mul(tslSelect(frontFacing, tslFloat(1), tslFloat(0.2)));
    nm.needsUpdate = true;
    c = nm as THREE.Material;
    interiorMats.set(m, c);
    return c;
  }

  /** Distinct, sorted box-face coordinates per local axis: the planes the town triangles are cut on. */
  function boxPlanes(b: WokenBuilding): number[][] {
    const planes: number[][] = [[], [], []];
    for (const ps of b.pieces) {
      if (!ps) continue;
      for (let ax = 0; ax < 3; ax++) planes[ax].push(ps.box[ax] - ps.box[3 + ax], ps.box[ax] + ps.box[3 + ax]);
    }
    return planes.map((p) => {
      p.sort((a, c) => a - c);
      const out: number[] = [];
      for (const v of p) if (out.length === 0 || v - out[out.length - 1] > 1e-3) out.push(v);
      return out;
    });
  }

  /** Split a convex polygon (verts: b0 b1 b2 lx ly lz) by the plane local[ax] = c. */
  function splitPoly(poly: number[][], ax: number, c: number): [number[][], number[][]] {
    const lo: number[][] = [], hi: number[][] = [];
    const k = 3 + ax;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], d = poly[(i + 1) % poly.length];
      const sa = a[k] - c, sd = d[k] - c;
      if (sa <= 0) lo.push(a);
      if (sa >= 0) hi.push(a);
      if ((sa < 0 && sd > 0) || (sa > 0 && sd < 0)) {
        const t = sa / (sa - sd);
        const m = new Array<number>(6);
        for (let j = 0; j < 6; j++) m[j] = a[j] + (d[j] - a[j]) * t;
        m[k] = c;
        lo.push(m);
        hi.push(m);
      }
    }
    return [lo, hi];
  }

  /**
   * First activation of a building: the town's triangles can be huge (a facade may be two), so they
   * are cut on every piece-box plane into a private copy of the merged meshes, and each cut triangle
   * is assigned to the piece whose box holds it. A break then removes only that piece's patch.
   */
  function prepareBuilding(b: WokenBuilding): void {
    b.assigned = true;
    const list = rangesByBuilding.get(b.specId);
    if (!list) return;
    const np = b.pieces.length;
    const bx = new Float64Array(np * 6);
    for (let i = 0; i < np; i++) if (b.pieces[i]) bx.set(b.pieces[i].box, i * 6);
    const planes = boxPlanes(b);
    const EPS = 1e-4;
    const byMesh = new Map<THREE.Mesh, Array<{ start: number; count: number }>>();
    for (const r of list) {
      let l = byMesh.get(r.mesh);
      if (!l) byMesh.set(r.mesh, (l = []));
      l.push(r);
    }
    for (const [src, ranges] of byMesh) {
      const geo = src.geometry;
      const index = geo.index;
      if (!index) continue;
      const ia = index.array;
      const names = Object.keys(geo.attributes).filter((n) => !(geo.attributes[n] as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute);
      const srcA = names.map((n) => geo.getAttribute(n) as THREE.BufferAttribute);
      const outA: number[][] = names.map(() => []);
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const pa = pos.array as Float32Array;
      const mi = meshList.length;
      const vote = VOTE_PARTS.indexOf((src.userData?.part as string | undefined) ?? '');
      const aIdx = names.indexOf('aA');
      let nv = 0;
      const stack: number[][][] = [];

      const emit = (poly: number[][], i0: number, i1: number, i2: number): void => {
        for (let f = 1; f < poly.length - 1; f++) {
          const tri = [poly[0], poly[f], poly[f + 1]];
          const e1x = tri[1][3] - tri[0][3], e1y = tri[1][4] - tri[0][4], e1z = tri[1][5] - tri[0][5];
          const e2x = tri[2][3] - tri[0][3], e2y = tri[2][4] - tri[0][4], e2z = tri[2][5] - tri[0][5];
          const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
          if (cx * cx + cy * cy + cz * cz < 1e-12) continue;
          const lx = (tri[0][3] + tri[1][3] + tri[2][3]) / 3, ly = (tri[0][4] + tri[1][4] + tri[2][4]) / 3, lz = (tri[0][5] + tri[1][5] + tri[2][5]) / 3;
          for (const v of tri) {
            for (let a = 0; a < srcA.length; a++) {
              const s = srcA[a].itemSize, arr = srcA[a].array;
              for (let k = 0; k < s; k++) outA[a].push(v[0] * arr[i0 * s + k] + v[1] * arr[i1 * s + k] + v[2] * arr[i2 * s + k]);
            }
          }
          let best = -1, bd = ASSIGN_MAX, bv = Infinity;
          for (let i = 0; i < np; i++) {
            const o = i * 6;
            if (bx[o + 3] === 0 && bx[o + 4] === 0) continue;
            const dx = Math.max(0, Math.abs(lx - bx[o]) - bx[o + 3]);
            const dy = Math.max(0, Math.abs(ly - bx[o + 1]) - bx[o + 4]);
            const dz = Math.max(0, Math.abs(lz - bx[o + 2]) - bx[o + 5]);
            const d = Math.hypot(dx, dy, dz);
            if (d > bd + 1e-6) continue;
            const vol = bx[o + 3] * bx[o + 4] * bx[o + 5];
            if (d < bd - 1e-6 || vol < bv) {
              bd = d;
              bv = vol;
              best = i;
            }
          }
          if (best >= 0) {
            const ps = b.pieces[best];
            ps.tris.push(mi * TRI_MESH + nv);
            if (vote >= 0) {
              ps.votes[vote]++;
              if (aIdx >= 0) {
                const av = outA[aIdx];
                const n = av.length;
                for (let k = 0; k < 4; k++) ps.ts[k] += (av[n - 12 + k] + av[n - 8 + k] + av[n - 4 + k]) / 3;
                ps.tn++;
              }
            }
          }
          nv += 3;
        }
      };

      for (const r of ranges) {
        for (let t = r.start; t < r.start + r.count; t += 3) {
          const i0 = ia[t], i1 = ia[t + 1], i2 = ia[t + 2];
          if (i0 === i1 && i1 === i2) continue;
          const ids = [i0, i1, i2];
          const poly: number[][] = ids.map((id, c) => {
            const wx = pa[id * 3] - b.x, wy = pa[id * 3 + 1], wz = pa[id * 3 + 2] - b.z;
            return [c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0, b.cs * wx - b.sn * wz, wy, b.sn * wx + b.cs * wz];
          });
          stack.push(poly);
          while (stack.length > 0) {
            const p = stack.pop()!;
            let cut = false;
            for (let ax = 0; ax < 3 && !cut; ax++) {
              const k = 3 + ax;
              let mn = Infinity, mx = -Infinity;
              for (const v of p) {
                if (v[k] < mn) mn = v[k];
                if (v[k] > mx) mx = v[k];
              }
              const pl = planes[ax];
              let lo = 0, hi = pl.length;
              while (lo < hi) {
                const m = (lo + hi) >> 1;
                if (pl[m] <= mn + EPS) lo = m + 1;
                else hi = m;
              }
              if (lo < pl.length && pl[lo] < mx - EPS) {
                const [a, c] = splitPoly(p, ax, pl[lo]);
                if (a.length >= 3) stack.push(a);
                if (c.length >= 3) stack.push(c);
                cut = true;
              }
            }
            if (!cut) emit(p, i0, i1, i2);
          }
        }
      }

      // private copy of this part's triangles; the shared merged mesh loses them
      const g = new THREE.BufferGeometry();
      names.forEach((n, a) => g.setAttribute(n, new THREE.BufferAttribute(new Float32Array(outA[a]), srcA[a].itemSize)));
      const idx = new Uint32Array(nv);
      for (let i = 0; i < nv; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const m = new THREE.Mesh(g, interiorMaterial(src.material as THREE.Material));
      m.name = `${src.name}-woken${b.specId}`;
      m.userData = src.userData;
      m.castShadow = src.castShadow;
      m.receiveShadow = src.receiveShadow;
      m.renderOrder = src.renderOrder;
      m.frustumCulled = src.frustumCulled;
      (src.parent ?? root).add(m);
      meshList.push(m);
      const sa = index.array as Uint16Array | Uint32Array;
      for (const r of ranges) {
        sa.fill(0, r.start, r.start + r.count);
        markIndexDirty(src, r.start, r.start + r.count);
      }
    }
  }

  /** Look and tint a piece takes from the town triangles it replaces (masonry variant, per-building tint, soot). */
  function applyVariant(h: Handle, ps: PieceState): void {
    let bi = -1, bv = 0;
    for (let i = 0; i < ps.votes.length; i++) if (ps.votes[i] > bv) { bv = ps.votes[i]; bi = i; }
    if (bi >= 0 && h.piece && h.piece.kind !== 'window' && h.piece.kind !== 'roof') h.look = VOTE_LOOKS[bi];
    if (ps.tn > 0) {
      const k = 0.96 + (((h.piece ? h.piece.seed : 0) * 40503) >>> 0) % 1000 / 1000 * 0.08;
      const soot = 1 - 0.7 * Math.min(1, Math.max(0, ps.ts[3] / ps.tn));
      h.tintR = Math.min(1.4, ps.ts[0] / ps.tn * soot * k);
      h.tintG = Math.min(1.4, ps.ts[1] / ps.tn * soot * k);
      h.tintB = Math.min(1.4, ps.ts[2] / ps.tn * soot * k);
    }
  }

  /** Build the geometry of a lazily drawn piece (first time it is shown). */
  function materialize(h: Handle): void {
    if (h.batch || !h.piece || !h.pc) return;
    const ps = h.pc;
    if (!ps.bld.assigned) prepareBuilding(ps.bld);
    applyVariant(h, ps);
    const e = h.piece.halfExtents, i2 = h.inset;
    instantiate(h, buildGeoData(boxGeo(Math.max(0.01, e[0] - i2), Math.max(0.01, e[1] - i2), Math.max(0.01, e[2] - i2)), h.piece));
  }

  /**
   * The piece now takes over from the town's merged triangles (it moved, was removed or is being baked).
   * `show` false: only the triangles go (its shards replace it), nothing is drawn for the piece itself.
   */
  function activate(h: Handle, ps: PieceState, show: boolean): void {
    if (ps.activated) return;
    ps.activated = true;
    if (!ps.bld.assigned) prepareBuilding(ps.bld);
    for (const code of ps.tris) {
      const mi = Math.floor(code / TRI_MESH);
      const t = code - mi * TRI_MESH;
      const mesh = meshList[mi];
      (mesh.geometry.index!.array as Uint16Array | Uint32Array).fill(0, t, t + 3);
      markIndexDirty(mesh, t, t + 3);
    }
    ps.tris.length = 0;
    if (show) {
      materialize(h);
      if (h.batch) {
        h.batch.mesh.setVisibleAt(h.inst, true);
        writeMatrix(h);
      }
    }
    if (!ps.bld.interior) showInterior(ps.bld);
  }

  function writeMatrix(h: Handle): void {
    const o = h.id * 7;
    scratchP.set(tr[o], tr[o + 1], tr[o + 2]);
    scratchQ.set(tr[o + 3], tr[o + 4], tr[o + 5], tr[o + 6]);
    scratchM.compose(scratchP, scratchQ, scratchS);
    h.batch!.mesh.setMatrixAt(h.inst, scratchM);
  }

  /** The building has a hole now: reveal its slabs / columns / beams so you do not see straight through it. */
  function showInterior(b: WokenBuilding): void {
    b.interior = true;
    for (const p of b.pieces) {
      if (!p || !p.structural || p.activated || p.shown || p.handle < 0) continue;
      const hd = handles[p.handle];
      if (!hd || !hd.alive) continue;
      p.shown = true;
      materialize(hd);
      if (!hd.batch) continue;
      writeMatrix(hd);
      hd.batch.mesh.setVisibleAt(hd.inst, true);
    }
  }

  // ------------------------------------------------ batches

  function newBatch(look: Look): Batch {
    const mesh = new THREE.BatchedMesh(BATCH_INSTANCES, BATCH_VERTS, BATCH_INDICES, batchMats[look]);
    mesh.name = `destruction-${look}`;
    mesh.sortObjects = false;
    mesh.frustumCulled = false;
    mesh.perObjectFrustumCulled = true;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    root.add(mesh);
    const b: Batch = { mesh, instances: 0, vTop: 0, iTop: 0, vLive: 0, iLive: 0 };
    let list = batches.get(look);
    if (!list) batches.set(look, (list = []));
    list.push(b);
    return b;
  }

  function batchFor(look: Look, v: number, i: number): Batch {
    const list = batches.get(look);
    if (list) {
      for (const b of list) {
        if (b.instances >= BATCH_INSTANCES) continue;
        if (b.vTop + v <= BATCH_VERTS && b.iTop + i <= BATCH_INDICES) return b;
        if (b.vLive + v <= BATCH_VERTS * 0.85 && b.iLive + i <= BATCH_INDICES * 0.85) {
          b.mesh.optimize();
          b.vTop = b.vLive;
          b.iTop = b.iLive;
          return b;
        }
      }
    }
    return newBatch(look);
  }

  function ensureTr(id: number): void {
    if ((id + 1) * 7 <= tr.length) return;
    const n = new Float32Array(Math.max(tr.length * 2, (id + 1) * 7));
    n.set(tr);
    tr = n;
  }

  function reserve(look: Look, tint: number, isShard: boolean, pc: PieceState | null, piece: PieceDef | null, inset: number): Handle {
    let id = freeIds.pop();
    const h: Handle = {
      id: 0, alive: true, piece, inset, look, batch: null, geoId: 0, inst: 0, data: null,
      tintR: tint, tintG: tint, tintB: tint, damage: 0, isShard, pc,
    };
    if (id === undefined) {
      id = handles.length;
      handles.push(h);
    } else handles[id] = h;
    h.id = id;
    ensureTr(id);
    const o = id * 7;
    tr[o] = 0; tr[o + 1] = -1000; tr[o + 2] = 0; tr[o + 3] = 0; tr[o + 4] = 0; tr[o + 5] = 0; tr[o + 6] = 1;
    if (pc) {
      pc.handle = id;
      tr.set(pc.rest, o);
    }
    liveHandles++;
    if (isShard) liveShards++;
    return h;
  }

  /** Put a reserved handle's geometry into a batch (pose and colour from its stored state). */
  function instantiate(h: Handle, data: GeoData): void {
    const bg = geoBuffer(data);
    const iCount = data.idx.length;
    const b = batchFor(h.look, data.vCount, iCount);
    h.geoId = b.mesh.addGeometry(bg);
    h.inst = b.mesh.addInstance(h.geoId);
    h.batch = b;
    h.data = data;
    b.instances++;
    b.vTop += data.vCount;
    b.iTop += iCount;
    b.vLive += data.vCount;
    b.iLive += iCount;
    writeMatrix(h);
    scratchC.set(h.tintR, h.tintG, h.tintB, h.damage);
    b.mesh.setColorAt(h.inst, scratchC);
  }

  function create(look: Look, data: GeoData, tint: number, isShard: boolean, rgb: Handle | null = null): RenderHandle {
    const h = reserve(look, tint, isShard, null, null, 0);
    if (rgb) { h.tintR = rgb.tintR; h.tintG = rgb.tintG; h.tintB = rgb.tintB; }
    instantiate(h, data);
    return h.id;
  }

  function release(id: number, h: Handle): void {
    const b = h.batch;
    if (b && h.data) {
      b.mesh.deleteGeometry(h.geoId); // also deletes its instance
      b.instances--;
      b.vLive -= h.data.vCount;
      b.iLive -= h.data.idx.length;
    }
    h.alive = false;
    h.batch = null;
    h.data = null;
    freeIds.push(id);
    liveHandles--;
    if (h.isShard) liveShards--;
  }

  // ------------------------------------------------ fracture cache

  const cache = new Map<string, FractureEntry>();
  const CACHE_MAX = 320;

  function fractureKey(piece: PieceDef, count: number): string {
    const e = piece.halfExtents;
    return `${piece.material}|${piece.kind}|${Math.round(e[0] * 1000)},${Math.round(e[1] * 1000)},${Math.round(e[2] * 1000)}|${piece.seed}|${count}`;
  }

  function clampCount(piece: PieceDef, count: number): number {
    const lim = piece.material === 'glass' ? [5, 7, 9, 12] : [7, 9, 12, 12];
    return Math.max(2, Math.min(count, lim[tierIdx]));
  }

  function fracture(piece: PieceDef, count: number): FractureResult {
    const n = clampCount(piece, count);
    const key = fractureKey(piece, n);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit); // LRU touch
      return hit.result;
    }
    const e = piece.halfExtents;
    const bf = fractureBox(e[0], e[1], e[2], piece.material, piece.kind, piece.seed, n);
    const entry: FractureEntry = {
      result: { shards: bf.shards, geometryKey: key },
      look: lookFor(piece.material, piece.kind),
      cells: bf.geos.map((g) => buildGeoData(g, piece)),
      piece,
    };
    cache.set(key, entry);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return entry.result;
  }

  // ------------------------------------------------ public handles

  const tintOf = (piece: PieceDef): number => 0.88 + (((piece.seed * 40503) >>> 0) % 1000) / 1000 * 0.2;

  function addPiece(graph: BuildingGraph, piece: PieceDef): RenderHandle {
    const e = piece.halfExtents;
    const structural = piece.kind === 'slab' || piece.kind === 'column' || piece.kind === 'beam';
    const look = lookFor(piece.material, piece.kind);
    if (!(pendingWake.has(graph.specId) || woken.has(graph.specId))) {
      return create(look, buildGeoData(boxGeo(e[0], e[1], e[2]), piece), tintOf(piece), false);
    }
    let b = woken.get(graph.specId);
    if (!b) {
      pendingWake.delete(graph.specId);
      b = { specId: graph.specId, x: graph.x, z: graph.z, cs: Math.cos(graph.yaw), sn: Math.sin(graph.yaw), pieces: [], assigned: false, interior: false };
      woken.set(graph.specId, b);
    }
    const c = piece.center;
    const half = graph.yaw * 0.5;
    const pc: PieceState = {
      bld: b, handle: -1, activated: false,
      rest: Float64Array.of(
        graph.x + b.cs * c[0] + b.sn * c[2], c[1], graph.z - b.sn * c[0] + b.cs * c[2],
        0, Math.sin(half), 0, Math.cos(half),
      ),
      box: Float64Array.of(c[0], c[1], c[2], e[0], e[1], e[2]),
      tris: [], structural, shown: false, votes: [0, 0, 0, 0, 0], ts: [0, 0, 0, 0], tn: 0,
    };
    b.pieces[piece.index] = pc;
    pieceStates.set(piece, pc);
    // Interior structure is drawn 2 cm smaller so faces flush with the facade do not z-fight it.
    const h = reserve(look, tintOf(piece), false, pc, piece, structural ? 0.02 : 0);
    return h.id;
  }

  function addShard(piece: PieceDef, fr: FractureResult, shardIndex: number): RenderHandle {
    if (liveShards >= maxShardHandles) return -1;
    let entry = cache.get(fr.geometryKey);
    if (!entry) {
      // Evicted: regenerate (deterministic) from the same piece and count.
      const count = fr.shards.length;
      fracture(piece, count);
      entry = cache.get(fr.geometryKey) ?? cache.get(fractureKey(piece, clampCount(piece, count)));
      if (!entry) return -1;
    }
    const cell = entry.cells[shardIndex];
    if (!cell) return -1;
    const ps = pieceStates.get(piece);
    if (!ps) return create(entry.look, cell, tintOf(piece), true);
    // a shard of a woken building's piece takes the same masonry variant and tint as the town it came from
    const tmp = { piece, look: entry.look, tintR: 0, tintG: 0, tintB: 0 } as unknown as Handle;
    tmp.tintR = tmp.tintG = tmp.tintB = tintOf(piece);
    if (!ps.bld.assigned) prepareBuilding(ps.bld);
    applyVariant(tmp, ps);
    return create(tmp.look, cell, tintOf(piece), true, tmp);
  }

  function setTransform(h: RenderHandle, pos: THREE.Vector3Like, quat: { x: number; y: number; z: number; w: number }): void {
    if (h < 0) return;
    const hd = handles[h];
    if (!hd || !hd.alive) return;
    const o = h * 7;
    tr[o] = pos.x; tr[o + 1] = pos.y; tr[o + 2] = pos.z;
    tr[o + 3] = quat.x; tr[o + 4] = quat.y; tr[o + 5] = quat.z; tr[o + 6] = quat.w;
    const ps = hd.pc;
    if (ps && !ps.activated) {
      const r = ps.rest;
      const dq = Math.abs(quat.x - r[3]) + Math.abs(quat.y - r[4]) + Math.abs(quat.z - r[5]) + Math.abs(quat.w - r[6]);
      const dqn = Math.abs(quat.x + r[3]) + Math.abs(quat.y + r[4]) + Math.abs(quat.z + r[5]) + Math.abs(quat.w + r[6]);
      if (Math.abs(pos.x - r[0]) + Math.abs(pos.y - r[1]) + Math.abs(pos.z - r[2]) < MOVE_EPS && Math.min(dq, dqn) < ROT_EPS) return;
      activate(hd, ps, true); // moved: it draws itself now and takes the current pose
    }
    if (!hd.batch) return;
    scratchP.set(pos.x, pos.y, pos.z);
    scratchQ.set(quat.x, quat.y, quat.z, quat.w);
    scratchM.compose(scratchP, scratchQ, scratchS);
    hd.batch.mesh.setMatrixAt(hd.inst, scratchM);
  }

  function setDamage(h: RenderHandle, damage01: number): void {
    if (h < 0) return;
    const hd = handles[h];
    if (!hd || !hd.alive) return;
    const d = Math.min(1, Math.max(0, damage01));
    if (Math.abs(d - hd.damage) < 0.01) return;
    hd.damage = d; // intact pieces keep the town's look; the value is applied when the piece is drawn
    if (!hd.batch) return;
    scratchC.set(hd.tintR, hd.tintG, hd.tintB, d);
    hd.batch.mesh.setColorAt(hd.inst, scratchC);
  }

  function remove(h: RenderHandle): void {
    if (h < 0) return;
    const hd = handles[h];
    if (!hd || !hd.alive) return;
    if (hd.pc && !hd.pc.activated) activate(hd, hd.pc, false); // its shards replace it: the town's triangles go
    release(h, hd);
  }

  // ------------------------------------------------ rubble

  function newChunk(look: Look): RubbleChunk {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(RUBBLE_CHUNK_VERTS * 3);
    const nrm = new Float32Array(RUBBLE_CHUNK_VERTS * 3);
    const ploc = new Float32Array(RUBBLE_CHUNK_VERTS * 3);
    const pn = new Float32Array(RUBBLE_CHUNK_VERTS * 4);
    const tint = new Float32Array(RUBBLE_CHUNK_VERTS * 4);
    const index = new Uint32Array(RUBBLE_CHUNK_INDICES);
    const dyn = (a: Float32Array, n: number): THREE.BufferAttribute => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', dyn(pos, 3));
    geo.setAttribute('normal', dyn(nrm, 3));
    geo.setAttribute('plocal', dyn(ploc, 3));
    geo.setAttribute('pn', dyn(pn, 4));
    geo.setAttribute('rtint', dyn(tint, 4));
    geo.setIndex(new THREE.BufferAttribute(index, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geo, staticMats[look]);
    mesh.name = `rubble-${look}`;
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    root.add(mesh);
    return { mesh, pos, nrm, ploc, pn, tint, index, vUsed: 0, iUsed: 0 };
  }

  function chunkFor(look: Look, v: number, i: number): RubbleChunk {
    let set = rubble.get(look);
    if (!set) rubble.set(look, (set = { chunks: [newChunk(look)], current: 0 }));
    let c = set.chunks[set.current];
    if (c.vUsed + v <= RUBBLE_CHUNK_VERTS && c.iUsed + i <= RUBBLE_CHUNK_INDICES) return c;
    // current chunk is full: next one, creating or recycling the oldest
    if (set.chunks.length < maxChunksPerLook) {
      set.chunks.push(newChunk(look));
      set.current = set.chunks.length - 1;
    } else {
      set.current = (set.current + 1) % set.chunks.length;
      c = set.chunks[set.current];
      rubbleTriangles -= c.iUsed / 3;
      c.vUsed = 0;
      c.iUsed = 0;
      c.mesh.geometry.setDrawRange(0, 0);
    }
    return set.chunks[set.current];
  }

  const dirty = new Set<RubbleChunk>();

  function bakeToRubble(list: RenderHandle[]): void {
    for (const id of list) {
      if (id < 0) continue;
      const hd = handles[id];
      if (!hd || !hd.alive) continue;
      if (hd.pc && !hd.pc.activated) activate(hd, hd.pc, true);
      if (!hd.data) continue;
      const d = hd.data;
      const c = chunkFor(hd.look, d.vCount, d.idx.length);
      const o = id * 7;
      scratchQ.set(tr[o + 3], tr[o + 4], tr[o + 5], tr[o + 6]);
      scratchM.compose(scratchP.set(tr[o], tr[o + 1], tr[o + 2]), scratchQ, scratchS);
      const m = scratchM.elements;
      const v0 = c.vUsed;
      const dust = 0.9;
      for (let i = 0; i < d.vCount; i++) {
        const x = d.pos[i * 3], y = d.pos[i * 3 + 1], z = d.pos[i * 3 + 2];
        const k = (v0 + i) * 3;
        c.pos[k] = m[0] * x + m[4] * y + m[8] * z + m[12];
        c.pos[k + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        c.pos[k + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        const nx = d.nrm[i * 3], ny = d.nrm[i * 3 + 1], nz = d.nrm[i * 3 + 2];
        c.nrm[k] = m[0] * nx + m[4] * ny + m[8] * nz;
        c.nrm[k + 1] = m[1] * nx + m[5] * ny + m[9] * nz;
        c.nrm[k + 2] = m[2] * nx + m[6] * ny + m[10] * nz;
        c.ploc[k] = d.ploc[i * 3]; c.ploc[k + 1] = d.ploc[i * 3 + 1]; c.ploc[k + 2] = d.ploc[i * 3 + 2];
        const k4 = (v0 + i) * 4;
        c.pn[k4] = d.pn[i * 4]; c.pn[k4 + 1] = d.pn[i * 4 + 1]; c.pn[k4 + 2] = d.pn[i * 4 + 2]; c.pn[k4 + 3] = d.pn[i * 4 + 3];
        c.tint[k4] = hd.tintR * dust; c.tint[k4 + 1] = hd.tintG * dust; c.tint[k4 + 2] = hd.tintB * dust; c.tint[k4 + 3] = hd.damage;
      }
      for (let i = 0; i < d.idx.length; i++) c.index[c.iUsed + i] = d.idx[i] + v0;
      c.vUsed += d.vCount;
      c.iUsed += d.idx.length;
      rubbleTriangles += d.idx.length / 3;
      dirty.add(c);
      release(id, hd);
    }
  }

  // ------------------------------------------------ per-frame

  function update(): void {
    if (pendingWake.size > 0) {
      for (const id of pendingWake) hideAll(id);
      pendingWake.clear();
    }
    for (const [mesh, d] of meshDirty) {
      const index = mesh.geometry.index!;
      index.clearUpdateRanges();
      index.addUpdateRange(d[0], d[1] - d[0]);
      index.needsUpdate = true;
    }
    meshDirty.clear();
    for (const c of dirty) {
      const g = c.mesh.geometry;
      for (const name of ['position', 'normal', 'plocal', 'pn', 'rtint']) {
        const a = g.getAttribute(name) as THREE.BufferAttribute;
        a.clearUpdateRanges();
        a.needsUpdate = true;
      }
      g.index!.clearUpdateRanges();
      g.index!.needsUpdate = true;
      g.setDrawRange(0, c.iUsed);
    }
    dirty.clear();
  }

  return {
    hideBuilding,
    addPiece,
    fracture,
    addShard,
    setTransform,
    setDamage,
    remove,
    bakeToRubble,
    update,
    stats: () => ({ liveHandles, rubbleTriangles: Math.round(rubbleTriangles) }),
  };
}
