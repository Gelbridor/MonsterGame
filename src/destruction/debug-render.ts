// TEMPORARY debug renderer: one InstancedMesh of boxes coloured per material, so the destruction
// simulation can be seen and tested before the real renderer (fracture, materials, rubble) lands.
// It implements the same DestructionRenderer contract, so main.ts can swap it out.

import * as THREE from 'three/webgpu';
import { MATERIALS } from './materials';
import type { BuildingGraph, DestructionRenderer, FractureResult, PieceDef, RenderHandle } from './types';

const CAPACITY = 24000;

export interface DebugRendererOptions {
  /** The town group (merged building meshes live here), to hide a woken building's merged visuals. */
  townGroup?: THREE.Object3D;
  buildingRanges?: Array<{ id: number; part: string; triStart: number; triCount: number }>;
}

/** Null renderer for headless runs: same contract, draws nothing. */
export function createNullRenderer(): DestructionRenderer {
  let next = 0;
  let live = 0;
  const cache = new Map<string, FractureResult>();
  return {
    hideBuilding() {},
    addPiece() { live++; return next++; },
    fracture(piece, count) { return boxFracture(piece, count, cache); },
    addShard() { live++; return next++; },
    setTransform() {},
    setDamage() {},
    remove() { live--; },
    bakeToRubble(h) { live -= h.length; },
    update() {},
    stats() { return { liveHandles: live, rubbleTriangles: 0 }; },
  };
}

const shardBoxes = new Map<string, Array<[number, number, number]>>();

/** Split the piece's box into about `count` sub-boxes on a grid along its longest axes. */
function boxFracture(piece: PieceDef, count: number, cache: Map<string, FractureResult>): FractureResult {
  const key = `box:${piece.seed}:${count}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const [hx, hy, hz] = piece.halfExtents;
  const dims = [hx, hy, hz];
  const n = [1, 1, 1];
  for (let c = 1; c < count; ) {
    // split the axis whose cells are currently largest
    let a = 0;
    for (let k = 1; k < 3; k++) if (dims[k] / n[k] > dims[a] / n[a]) a = k;
    n[a]++;
    c = n[0] * n[1] * n[2];
  }
  const shards: FractureResult['shards'] = [];
  const ext: Array<[number, number, number]> = [];
  const cw = (2 * hx) / n[0], ch = (2 * hy) / n[1], cd = (2 * hz) / n[2];
  for (let i = 0; i < n[0]; i++) {
    for (let j = 0; j < n[1]; j++) {
      for (let k = 0; k < n[2]; k++) {
        const cx = -hx + cw * (i + 0.5), cy = -hy + ch * (j + 0.5), cz = -hz + cd * (k + 0.5);
        const a = cw / 2, b = ch / 2, c2 = cd / 2;
        const hull = new Float32Array([
          -a, -b, -c2, a, -b, -c2, -a, b, -c2, a, b, -c2,
          -a, -b, c2, a, -b, c2, -a, b, c2, a, b, c2,
        ]);
        shards.push({ center: [cx, cy, cz], hull, volume: cw * ch * cd });
        ext.push([cw, ch, cd]);
      }
    }
  }
  shardBoxes.set(key, ext);
  const res: FractureResult = { shards, geometryKey: key };
  cache.set(key, res);
  return res;
}

export function createDebugRenderer(scene: THREE.Scene, opts: DebugRendererOptions = {}): DestructionRenderer {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.0 });
  const mesh = new THREE.InstancedMesh(geo, mat, CAPACITY);
  mesh.name = 'destruction-debug';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  scene.add(mesh);

  const sx = new Float32Array(CAPACITY), sy = new Float32Array(CAPACITY), sz = new Float32Array(CAPACITY);
  const baseColor = new Uint32Array(CAPACITY);
  const state = new Uint8Array(CAPACITY); // 0 free, 1 live, 2 baked
  const free: number[] = [];
  let high = 0;
  let live = 0;
  let baked = 0;
  let dirty = false;
  const cache = new Map<string, FractureResult>();

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const col = new THREE.Color();
  const zeroScale = new THREE.Matrix4().makeScale(0, 0, 0);

  const alloc = (): number => {
    const h = free.pop() ?? high++;
    if (h >= CAPACITY) throw new Error('debug renderer capacity exceeded');
    mesh.count = Math.max(mesh.count, high);
    return h;
  };
  const make = (w: number, h: number, d: number, hex: number): RenderHandle => {
    const id = alloc();
    sx[id] = w; sy[id] = h; sz[id] = d;
    baseColor[id] = hex;
    col.setHex(hex);
    mesh.setColorAt(id, col);
    mesh.setMatrixAt(id, zeroScale);
    state[id] = 1;
    live++;
    dirty = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return id;
  };

  // Hide merged geometry by collapsing the building's triangles.
  const hideBuilding = (specId: number): void => {
    if (!opts.townGroup || !opts.buildingRanges) return;
    const touched = new Set<THREE.BufferAttribute>();
    for (const r of opts.buildingRanges) {
      if (r.id !== specId) continue;
      const obj = opts.townGroup.getObjectByName(`town-${r.part}`) as THREE.Mesh | undefined;
      const index = obj?.geometry?.getIndex();
      if (!index) continue;
      const arr = index.array as Uint16Array | Uint32Array;
      arr.fill(0, r.triStart * 3, (r.triStart + r.triCount) * 3);
      touched.add(index as THREE.BufferAttribute);
    }
    for (const a of touched) a.needsUpdate = true;
  };

  return {
    hideBuilding,
    addPiece(_graph: BuildingGraph, piece: PieceDef): RenderHandle {
      const m = MATERIALS[piece.material];
      return make(piece.halfExtents[0] * 2, piece.halfExtents[1] * 2, piece.halfExtents[2] * 2, m.color);
    },
    fracture(piece: PieceDef, count: number): FractureResult {
      return boxFracture(piece, count, cache);
    },
    addShard(piece: PieceDef, fr: FractureResult, k: number): RenderHandle {
      const e = shardBoxes.get(fr.geometryKey)![k];
      return make(e[0], e[1], e[2], MATERIALS[piece.material].color);
    },
    setTransform(h, pos, quat): void {
      if (state[h] !== 1) return;
      p.set(pos.x, pos.y, pos.z);
      q.set(quat.x, quat.y, quat.z, quat.w);
      s.set(sx[h], sy[h], sz[h]);
      m4.compose(p, q, s);
      mesh.setMatrixAt(h, m4);
      dirty = true;
    },
    setDamage(h, dmg): void {
      if (state[h] === 0) return;
      col.setHex(baseColor[h]).multiplyScalar(1 - 0.55 * Math.min(1, Math.max(0, dmg)));
      mesh.setColorAt(h, col);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    remove(h): void {
      if (state[h] === 0) return;
      if (state[h] === 1) live--;
      state[h] = 0;
      mesh.setMatrixAt(h, zeroScale);
      free.push(h);
      dirty = true;
    },
    bakeToRubble(handles): void {
      for (const h of handles) {
        if (state[h] === 1) { state[h] = 2; live--; baked++; }
      }
    },
    update(): void {
      if (dirty) {
        mesh.instanceMatrix.needsUpdate = true;
        dirty = false;
      }
    },
    stats() {
      return { liveHandles: live, rubbleTriangles: baked * 12 };
    },
  };
}
