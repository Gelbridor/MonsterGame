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
  alive: boolean;
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
}

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

  function hideBuilding(specId: number): void {
    if (hidden.has(specId)) return;
    hidden.add(specId);
    const list = rangesByBuilding.get(specId);
    if (!list) return;
    for (const r of list) {
      const index = r.mesh.geometry.index;
      if (!index) continue;
      (index.array as Uint16Array | Uint32Array).fill(0, r.start, r.start + r.count);
      index.addUpdateRange(r.start, r.count);
      index.needsUpdate = true;
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

  function create(look: Look, data: GeoData, tint: number, isShard: boolean): RenderHandle {
    const bg = geoBuffer(data);
    const iCount = data.idx.length;
    const b = batchFor(look, data.vCount, iCount);
    const geoId = b.mesh.addGeometry(bg);
    const inst = b.mesh.addInstance(geoId);
    b.instances++;
    b.vTop += data.vCount;
    b.iTop += iCount;
    b.vLive += data.vCount;
    b.iLive += iCount;
    let id = freeIds.pop();
    const h: Handle = {
      alive: true, look, batch: b, geoId, inst, data, tintR: tint, tintG: tint, tintB: tint, damage: 0, isShard,
    };
    if (id === undefined) {
      id = handles.length;
      handles.push(h);
    } else handles[id] = h;
    ensureTr(id);
    const o = id * 7;
    tr[o] = 0; tr[o + 1] = -1000; tr[o + 2] = 0; tr[o + 3] = 0; tr[o + 4] = 0; tr[o + 5] = 0; tr[o + 6] = 1;
    scratchP.set(0, -1000, 0);
    scratchM.compose(scratchP, scratchQ.identity(), scratchS);
    b.mesh.setMatrixAt(inst, scratchM);
    scratchC.set(tint, tint, tint, 0);
    b.mesh.setColorAt(inst, scratchC);
    liveHandles++;
    if (isShard) liveShards++;
    return id;
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

  function addPiece(_graph: BuildingGraph, piece: PieceDef): RenderHandle {
    const e = piece.halfExtents;
    const data = buildGeoData(boxGeo(e[0], e[1], e[2]), piece);
    return create(lookFor(piece.material, piece.kind), data, tintOf(piece), false);
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
    return create(entry.look, cell, tintOf(piece), true);
  }

  function setTransform(h: RenderHandle, pos: THREE.Vector3Like, quat: { x: number; y: number; z: number; w: number }): void {
    if (h < 0) return;
    const hd = handles[h];
    if (!hd || !hd.alive || !hd.batch) return;
    const o = h * 7;
    tr[o] = pos.x; tr[o + 1] = pos.y; tr[o + 2] = pos.z;
    tr[o + 3] = quat.x; tr[o + 4] = quat.y; tr[o + 5] = quat.z; tr[o + 6] = quat.w;
    scratchP.set(pos.x, pos.y, pos.z);
    scratchQ.set(quat.x, quat.y, quat.z, quat.w);
    scratchM.compose(scratchP, scratchQ, scratchS);
    hd.batch.mesh.setMatrixAt(hd.inst, scratchM);
  }

  function setDamage(h: RenderHandle, damage01: number): void {
    if (h < 0) return;
    const hd = handles[h];
    if (!hd || !hd.alive || !hd.batch) return;
    const d = Math.min(1, Math.max(0, damage01));
    if (Math.abs(d - hd.damage) < 0.01) return;
    hd.damage = d;
    scratchC.set(hd.tintR, hd.tintG, hd.tintB, d);
    hd.batch.mesh.setColorAt(hd.inst, scratchC);
  }

  function remove(h: RenderHandle): void {
    if (h < 0) return;
    const hd = handles[h];
    if (!hd || !hd.alive) return;
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
      if (!hd || !hd.alive || !hd.data) continue;
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
