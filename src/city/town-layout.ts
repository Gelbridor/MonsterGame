// Blockout northern English town centre on a rainy night.
//
// Two stages, so the box meshes can later be swapped for the Phase 2
// floors x bays generator without touching the layout:
//   1. layoutTown(seed)      -> pure data: roads, blocks, BuildingSpec[]
//   2. buildTown(scene, ...) -> meshes + static colliders from that data
//
// Axes: +x east, +z south (towards the camera at start), y up. 1 unit = 1 m.
// Block-space plan (roads every 90 m, canal on the north edge, viaduct on
// the east edge, market square in the middle, spawn at its centre).

import * as THREE from 'three/webgpu';
import type { Physics, Town } from '../core/types';
import { config } from '../config';

// ---------------------------------------------------------------- types

export type BuildingType =
  | 'terrace'
  | 'cornerShop'
  | 'tower'
  | 'townHall'
  | 'office'
  | 'carPark'
  | 'church'
  | 'gasholder'
  | 'substation';

export type MatKey =
  | 'brick0' | 'brick1' | 'brick2' | 'brick3' | 'shopBrick'
  | 'slate' | 'concrete0' | 'concrete1' | 'concreteDark' | 'sandstone' | 'sootStone'
  | 'glass0' | 'glass1' | 'steel' | 'substation' | 'viaduct';

/** One building, as data. Axis-aligned footprint rotated by `yaw` about its centre; base at y = 0. */
export interface BuildingSpec {
  id: number;
  type: BuildingType;
  /** Footprint centre (m). */
  x: number;
  z: number;
  /** Footprint size along local x / z (m). */
  width: number;
  depth: number;
  /** Height of the main body (m), excluding roofs / towers / spires. */
  height: number;
  yaw: number;
  floors: number;
  floorHeight: number;
  material: MatKey;
}

export interface Rect { x0: number; x1: number; z0: number; z1: number }

export interface TownLayout {
  specs: BuildingSpec[];
  /** City blocks, indexed [column][row]. */
  blocks: Rect[][];
  /** Road centre lines (x for 'z'-running roads, z for 'x'-running roads). */
  roadX: number[];
  roadZ: number[];
  roadWidth: number;
  canal: Rect;
  viaduct: Rect;
  spawn: { x: number; z: number };
  /** Open area around the spawn that must stay clear of buildings (m). */
  spawnClearRadius: number;
}

// ---------------------------------------------------------------- tiny PRNG

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- layout

const ROAD_WIDTH = 10; // carriageway
const PAVEMENT = 3; // each side
const BLOCK_MARGIN = 1.5; // gap between block edge and buildings

const ROAD_X = [-140, -50, 40, 130];
const ROAD_Z = [-140, -50, 40, 130];
const HALF_ROAD = ROAD_WIDTH / 2 + PAVEMENT; // 8

export function layoutTown(seed: number): TownLayout {
  const rng = mulberry32(seed);
  const rand = (a: number, b: number) => a + (b - a) * rng();
  const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1));
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length];

  const half = config.world.groundSize / 2;
  const canal: Rect = { x0: -half, x1: half, z0: -half, z1: -half + 15.2 };
  const viaduct: Rect = { x0: 178, x1: 190, z0: canal.z1, z1: half };

  // Blocks between the roads.
  const xEdges = [-196, ...ROAD_X.flatMap((r) => [r - HALF_ROAD, r + HALF_ROAD]), 170];
  const zEdges = [-180, ...ROAD_Z.flatMap((r) => [r - HALF_ROAD, r + HALF_ROAD]), 196];
  const blocks: Rect[][] = [];
  for (let c = 0; c < 5; c++) {
    const col: Rect[] = [];
    for (let r = 0; r < 5; r++) {
      col.push({ x0: xEdges[c * 2], x1: xEdges[c * 2 + 1], z0: zEdges[r * 2], z1: zEdges[r * 2 + 1] });
    }
    blocks.push(col);
  }

  const specs: BuildingSpec[] = [];
  const add = (s: Omit<BuildingSpec, 'id' | 'yaw'> & { yaw?: number }): void => {
    specs.push({ yaw: 0, ...s, id: specs.length });
  };
  const centre = (b: Rect) => ({ x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 });

  const bricks: MatKey[] = ['brick0', 'brick1', 'brick2', 'brick3'];

  /** A row of terraces along one side of a block, split into `pieces` buildings. */
  const terraceRun = (b: Rect, side: 'N' | 'S' | 'E' | 'W', pieces: number, startInset = 0, endInset = 0): number => {
    const depth = rand(8, 10);
    const alongX = side === 'N' || side === 'S';
    const a0 = (alongX ? b.x0 : b.z0) + BLOCK_MARGIN + startInset;
    const a1 = (alongX ? b.x1 : b.z1) - BLOCK_MARGIN - endInset;
    // Cross-axis extent of the row.
    let c0: number;
    if (side === 'N') c0 = b.z0 + BLOCK_MARGIN;
    else if (side === 'S') c0 = b.z1 - BLOCK_MARGIN - depth;
    else if (side === 'W') c0 = b.x0 + BLOCK_MARGIN;
    else c0 = b.x1 - BLOCK_MARGIN - depth;

    const gap = 2.5;
    const usable = a1 - a0 - gap * (pieces - 1);
    // Optional corner shop at one end: short, always 3 floors.
    const shopAt = pieces > 1 && rng() < 0.6 ? (rng() < 0.5 ? 0 : pieces - 1) : -1;
    const weights: number[] = [];
    let shopLen = 0;
    if (shopAt >= 0) shopLen = 20;
    let wSum = 0;
    for (let i = 0; i < pieces; i++) {
      const w = i === shopAt ? 0 : rand(0.75, 1.25);
      weights.push(w);
      wSum += w;
    }
    const rest = usable - shopLen;
    let cursor = a0;
    const rowMat = pick(bricks);
    for (let i = 0; i < pieces; i++) {
      const len = i === shopAt ? shopLen : (rest * weights[i]) / wSum;
      const isShop = i === shopAt;
      const floors = isShop ? 3 : randInt(2, 4);
      const mid = cursor + len / 2;
      const cMid = c0 + depth / 2;
      add({
        type: isShop ? 'cornerShop' : 'terrace',
        x: alongX ? mid : cMid,
        z: alongX ? cMid : mid,
        width: alongX ? len : depth,
        depth: alongX ? depth : len,
        floors,
        floorHeight: 3.2,
        height: floors * 3.2,
        material: isShop ? 'shopBrick' : rng() < 0.7 ? rowMat : pick(bricks),
      });
      cursor += len + gap;
    }
    return depth;
  };

  const tower = (cx: number, cz: number, floors: number): void =>
    add({
      type: 'tower', x: cx, z: cz, width: 20, depth: 20, floors, floorHeight: 2.8,
      height: floors * 2.8, material: rng() < 0.5 ? 'concrete0' : 'concrete1',
    });

  const office = (cx: number, cz: number, w: number, d: number, floors: number): void =>
    add({
      type: 'office', x: cx, z: cz, width: w, depth: d, floors, floorHeight: 3.6,
      height: floors * 3.6, material: rng() < 0.5 ? 'glass0' : 'glass1',
    });

  const B = blocks;

  // --- r0: canal-side rows (north edge of the town)
  terraceRun(B[0][0], 'N', 1);
  terraceRun(B[1][0], 'N', 2);
  terraceRun(B[2][0], 'N', 2);
  terraceRun(B[3][0], 'N', 2);
  {
    const c = centre(B[4][0]);
    add({ type: 'substation', x: c.x, z: c.z + 6, width: 12, depth: 9, floors: 1, floorHeight: 6, height: 6, material: 'substation' });
  }

  // --- r1
  tower(centre(B[0][1]).x, centre(B[0][1]).z, 16);
  office(-110, -108, 28, 28, 12);
  office(-78, -78, 26, 30, 9);
  {
    // Town hall fronting the market square (front = +z).
    const b = B[2][1];
    const cx = centre(b).x;
    add({ type: 'townHall', x: cx, z: b.z1 - BLOCK_MARGIN - 12, width: 60, depth: 24, floors: 3, floorHeight: 5.2, height: 15.6, material: 'sandstone' });
    terraceRun(b, 'N', 2);
  }
  terraceRun(B[3][1], 'W', 2);

  // --- r2: market square (c2) stays empty
  terraceRun(B[0][2], 'E', 2);
  add({ type: 'church', x: -95, z: centre(B[1][2]).z, width: 14, depth: 34, floors: 1, floorHeight: 10, height: 10, material: 'sootStone' });
  terraceRun(B[3][2], 'W', 2);
  tower(100, centre(B[3][2]).z, 18);
  {
    const c = centre(B[4][2]);
    add({ type: 'gasholder', x: c.x, z: c.z - 8, width: 30, depth: 30, floors: 1, floorHeight: 25, height: 25, material: 'steel' });
    add({ type: 'substation', x: c.x, z: c.z + 22, width: 10, depth: 8, floors: 1, floorHeight: 5, height: 5, material: 'substation' });
  }

  // --- r3
  tower(centre(B[0][3]).x, centre(B[0][3]).z, 20);
  terraceRun(B[1][3], 'N', 2);
  add({ type: 'carPark', x: centre(B[2][3]).x, z: centre(B[2][3]).z, width: 60, depth: 36, floors: 5, floorHeight: 3, height: 15, material: 'concreteDark' });
  office(72, 72, 28, 28, 10);
  office(104, 106, 24, 26, 8);

  // --- r4 (south edge)
  tower(centre(B[0][4]).x, centre(B[0][4]).z, 14);
  office(centre(B[3][4]).x, centre(B[3][4]).z, 30, 30, 11);


  const c = centre(B[2][2]);
  return {
    specs, blocks, roadX: ROAD_X, roadZ: ROAD_Z, roadWidth: ROAD_WIDTH, canal, viaduct,
    spawn: { x: c.x, z: c.z }, spawnClearRadius: 40,
  };
}

// ---------------------------------------------------------------- materials

const MAT_DEFS: Record<MatKey, { color: number; roughness: number; metalness: number }> = {
  brick0: { color: 0x7a3b2a, roughness: 0.9, metalness: 0 },
  brick1: { color: 0x8a4a35, roughness: 0.9, metalness: 0 },
  brick2: { color: 0x6b3328, roughness: 0.92, metalness: 0 },
  brick3: { color: 0x5e3b32, roughness: 0.9, metalness: 0 },
  shopBrick: { color: 0x9a6340, roughness: 0.85, metalness: 0 },
  slate: { color: 0x2a2e36, roughness: 0.75, metalness: 0.05 },
  concrete0: { color: 0x8a8d90, roughness: 0.92, metalness: 0 },
  concrete1: { color: 0x9b9b95, roughness: 0.92, metalness: 0 },
  concreteDark: { color: 0x6c6f73, roughness: 0.95, metalness: 0 },
  sandstone: { color: 0xb59d78, roughness: 0.88, metalness: 0 },
  sootStone: { color: 0x6f6a60, roughness: 0.9, metalness: 0 },
  glass0: { color: 0x1a3450, roughness: 0.15, metalness: 0.6 },
  glass1: { color: 0x213f5e, roughness: 0.18, metalness: 0.6 },
  steel: { color: 0x4d5a52, roughness: 0.55, metalness: 0.5 },
  substation: { color: 0x585d62, roughness: 0.85, metalness: 0.1 },
  viaduct: { color: 0x5b3a2e, roughness: 0.92, metalness: 0 },
};

// ---------------------------------------------------------------- build

type Vec3L = { x: number; y: number; z: number };

export function buildTown(scene: THREE.Scene, physics: Physics): Town & { specs: BuildingSpec[]; layout: TownLayout } {
  const layout = layoutTown(config.world.seed);
  const rng = mulberry32(config.world.seed ^ 0x9e3779b9); // detail stream, independent of layout
  const rand = (a: number, b: number) => a + (b - a) * rng();

  const group = new THREE.Group();
  group.name = 'town';

  const size = config.world.groundSize;
  const half = size / 2;

  // Shared materials.
  const mats = {} as Record<MatKey, THREE.MeshStandardMaterial>;
  (Object.keys(MAT_DEFS) as MatKey[]).forEach((k) => {
    mats[k] = new THREE.MeshStandardMaterial({ ...MAT_DEFS[k] });
  });
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.55, metalness: 0 });
  const roadMat = new THREE.MeshStandardMaterial({
    color: 0x26282d, roughness: 0.5, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const pavementMat = new THREE.MeshStandardMaterial({ color: 0x3b3c3f, roughness: 0.6, metalness: 0 });
  const plazaMat = new THREE.MeshStandardMaterial({ color: 0x4a463f, roughness: 0.5, metalness: 0 });
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x0e2a2c, roughness: 0.08, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const windowMat = new THREE.MeshStandardMaterial({ color: 0x1a1208, emissive: 0xffb866, emissiveIntensity: 2.2, roughness: 0.4 });
  const lampPostMat = new THREE.MeshStandardMaterial({ color: 0x202226, roughness: 0.6, metalness: 0.4 });
  const lampHeadMat = new THREE.MeshStandardMaterial({ color: 0x221508, emissive: 0xff8a2a, emissiveIntensity: 3.5, roughness: 0.5 });

  const unitBox = new THREE.BoxGeometry(1, 1, 1);

  const GROUND = { kind: 'ground' } as const;

  // ----- ground + boundary
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.userData = { ...GROUND, part: 'ground' };
  group.add(ground);
  physics.addStaticBox({ x: 0, y: -1, z: 0 }, { x: half, y: 1, z: half });

  const wallH = 30; // half height -> 60 m tall
  const wallT = 5;
  physics.addStaticBox({ x: 0, y: wallH, z: -half - wallT }, { x: half + 2 * wallT, y: wallH, z: wallT });
  physics.addStaticBox({ x: 0, y: wallH, z: half + wallT }, { x: half + 2 * wallT, y: wallH, z: wallT });
  physics.addStaticBox({ x: -half - wallT, y: wallH, z: 0 }, { x: wallT, y: wallH, z: half + 2 * wallT });
  physics.addStaticBox({ x: half + wallT, y: wallH, z: 0 }, { x: wallT, y: wallH, z: half + 2 * wallT });

  // ----- roads
  const roadLen = size;
  const roadGeoX = new THREE.PlaneGeometry(roadLen, layout.roadWidth); // runs along x
  const roadGeoZ = new THREE.PlaneGeometry(layout.roadWidth, roadLen); // runs along z
  for (const rz of layout.roadZ) {
    const m = new THREE.Mesh(roadGeoX, roadMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, 0.02, rz);
    m.userData = { ...GROUND, part: 'road' };
    group.add(m);
  }
  for (const rx of layout.roadX) {
    const m = new THREE.Mesh(roadGeoZ, roadMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(rx, 0.02, 0);
    m.userData = { ...GROUND, part: 'road' };
    group.add(m);
  }

  // ----- pavement slabs: one per block, instanced (the market square gets its own paving)
  const slabH = 0.15;
  const plazaBlock = layout.blocks[2][2];
  const slabBlocks: Rect[] = [];
  for (let c = 0; c < 5; c++) {
    for (let r = 0; r < 5; r++) {
      if (c === 2 && r === 2) continue;
      slabBlocks.push(layout.blocks[c][r]);
    }
  }
  const slabs = new THREE.InstancedMesh(unitBox, pavementMat, slabBlocks.length);
  const mtx = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  slabBlocks.forEach((b, i) => {
    pos.set((b.x0 + b.x1) / 2, slabH / 2, (b.z0 + b.z1) / 2);
    scl.set(b.x1 - b.x0 + 2 * PAVEMENT, slabH, b.z1 - b.z0 + 2 * PAVEMENT);
    slabs.setMatrixAt(i, mtx.compose(pos, quat, scl));
  });
  slabs.instanceMatrix.needsUpdate = true;
  slabs.computeBoundingSphere();
  slabs.userData = { ...GROUND, part: 'pavement' };
  group.add(slabs);

  const plaza = new THREE.Mesh(new THREE.BoxGeometry(
    plazaBlock.x1 - plazaBlock.x0 + 2 * PAVEMENT, slabH, plazaBlock.z1 - plazaBlock.z0 + 2 * PAVEMENT,
  ), plazaMat);
  plaza.position.set((plazaBlock.x0 + plazaBlock.x1) / 2, slabH / 2, (plazaBlock.z0 + plazaBlock.z1) / 2);
  plaza.userData = { ...GROUND, part: 'plaza' };
  group.add(plaza);

  // ----- canal (north edge): water strip + stone bank wall
  const canal = layout.canal;
  const water = new THREE.Mesh(new THREE.PlaneGeometry(canal.x1 - canal.x0, canal.z1 - canal.z0 - 0.8), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, 0.04, (canal.z0 + canal.z1) / 2 - 0.4);
  water.userData = { ...GROUND, part: 'water' };
  group.add(water);
  {
    const wallLen = canal.x1 - canal.x0;
    const bank = new THREE.Mesh(new THREE.BoxGeometry(wallLen, 2, 0.8), mats.sootStone);
    bank.position.set(0, 1, canal.z1 - 0.4);
    bank.userData = { ...GROUND, part: 'canalBank' };
    group.add(bank);
    physics.addStaticBox({ x: 0, y: 1, z: canal.z1 - 0.4 }, { x: wallLen / 2, y: 1, z: 0.4 });
  }

  // ----- railway viaduct (east edge): deck + row of piers; gaps between piers imply arches
  {
    const v = layout.viaduct;
    const len = v.z1 - v.z0;
    const w = v.x1 - v.x0;
    const cx = (v.x0 + v.x1) / 2;
    const cz = (v.z0 + v.z1) / 2;
    const deckBase = 10;
    const deckH = 2.5;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(w, deckH, len), mats.viaduct);
    deck.position.set(cx, deckBase + deckH / 2, cz);
    deck.userData = { kind: 'building', buildingType: 'viaduct', part: 'deck' };
    group.add(deck);
    physics.addStaticBox({ x: cx, y: deckBase + deckH / 2, z: cz }, { x: w / 2, y: deckH / 2, z: len / 2 });
    for (const side of [-1, 1]) {
      const para = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.1, len), mats.viaduct);
      para.position.set(cx + side * (w / 2 - 0.3), deckBase + deckH + 0.55, cz);
      para.userData = { kind: 'building', buildingType: 'viaduct', part: 'parapet' };
      group.add(para);
    }
    const pitch = 16;
    const pierLen = 5;
    const pierW = w - 2;
    const count = Math.floor(len / pitch);
    const piers = new THREE.InstancedMesh(unitBox, mats.viaduct, count);
    for (let i = 0; i < count; i++) {
      const pz = v.z0 + pitch * (i + 0.5);
      pos.set(cx, deckBase / 2, pz);
      scl.set(pierW, deckBase, pierLen);
      piers.setMatrixAt(i, mtx.compose(pos, quat, scl));
      physics.addStaticBox({ x: cx, y: deckBase / 2, z: pz }, { x: pierW / 2, y: deckBase / 2, z: pierLen / 2 });
    }
    piers.instanceMatrix.needsUpdate = true;
    piers.computeBoundingSphere();
    piers.userData = { kind: 'building', buildingType: 'viaduct', part: 'piers' };
    group.add(piers);
  }

  // ----- buildings
  const windowInstances: number[] = []; // flat: px,py,pz, sx,sy,sz, qy (yaw)
  const addWindow = (spec: BuildingSpec, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number): void => {
    const cs = Math.cos(spec.yaw);
    const sn = Math.sin(spec.yaw);
    windowInstances.push(spec.x + lx * cs + lz * sn, ly, spec.z - lx * sn + lz * cs, sx, sy, sz, spec.yaw);
  };

  /** Add a box part in a spec's local frame (local x/z offset from its centre, baseY world height). */
  const part = (
    spec: BuildingSpec, name: string, lx: number, baseY: number, lz: number,
    w: number, h: number, d: number, mat: THREE.Material,
  ): THREE.Mesh => {
    const cs = Math.cos(spec.yaw);
    const sn = Math.sin(spec.yaw);
    const wx = spec.x + lx * cs + lz * sn;
    const wz = spec.z - lx * sn + lz * cs;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(wx, baseY + h / 2, wz);
    mesh.rotation.y = spec.yaw;
    mesh.userData = { kind: 'building', buildingType: spec.type, buildingId: spec.id, part: name };
    group.add(mesh);
    physics.addStaticBox({ x: wx, y: baseY + h / 2, z: wz }, { x: w / 2, y: h / 2, z: d / 2 }, spec.yaw);
    return mesh;
  };

  /** Lit window strips on the faces of a box-shaped spec. */
  const windows = (spec: BuildingSpec, p: number, minLen: number, maxLen: number, minFace: number): void => {
    const faces: Array<{ nx: number; nz: number; len: number }> = [
      { nx: 0, nz: 1, len: spec.width }, { nx: 0, nz: -1, len: spec.width },
      { nx: 1, nz: 0, len: spec.depth }, { nx: -1, nz: 0, len: spec.depth },
    ];
    const t = 0.2;
    for (let f = 0; f < spec.floors; f++) {
      for (const face of faces) {
        if (face.len < minFace || rng() > p) continue;
        const sl = Math.min(face.len - 3, rand(minLen, maxLen));
        const off = (rng() - 0.5) * Math.max(0, face.len - sl - 2);
        const y = f * spec.floorHeight + spec.floorHeight * 0.55;
        const h = Math.min(1.4, spec.floorHeight * 0.4);
        if (face.nz !== 0) {
          addWindow(spec, off, y, face.nz * (spec.depth / 2 + t * 0.25), sl, h, t);
        } else {
          addWindow(spec, face.nx * (spec.width / 2 + t * 0.25), y, off, t, h, sl);
        }
      }
    }
  };

  for (const spec of layout.specs) {
    const m = mats[spec.material];
    const { width: w, depth: d, height: h } = spec;
    switch (spec.type) {
      case 'terrace':
      case 'cornerShop': {
        part(spec, 'body', 0, 0, 0, w, h, d, m);
        // Pitched-roof hint: a slate ridge block, narrower than the body.
        const alongX = w >= d;
        part(spec, 'roof', 0, h, 0, alongX ? w + 0.4 : w * 0.7, 2.4, alongX ? d * 0.7 : d + 0.4, mats.slate);
        windows(spec, 0.32, 3, 8, 8);
        break;
      }
      case 'tower': {
        part(spec, 'body', 0, 0, 0, w, h, d, m);
        part(spec, 'plant', 0, h, 0, 7, 3.5, 7, mats.concreteDark);
        windows(spec, 0.26, 4, 10, 8);
        break;
      }
      case 'office': {
        part(spec, 'body', 0, 0, 0, w, h, d, m);
        part(spec, 'plant', 0, h, 0, w * 0.45, 3, d * 0.45, mats.steel);
        windows(spec, 0.2, 5, 12, 8);
        break;
      }
      case 'townHall': {
        part(spec, 'body', 0, 0, 0, w, h, d, m);
        part(spec, 'roof', 0, h, 0, w + 1, 1.2, d + 1, mats.slate);
        // Clock tower flush with the front, rising to ~50 m with a pyramid cap.
        const tz = d / 2 - 6;
        const towerH = 42;
        part(spec, 'clockTower', 0, 0, tz, 10, towerH, 10, m);
        const capH = 8;
        const cap = new THREE.Mesh(new THREE.ConeGeometry(10 / Math.SQRT2, capH, 4), mats.slate);
        cap.rotation.y = Math.PI / 4 + spec.yaw;
        const cs = Math.cos(spec.yaw);
        const sn = Math.sin(spec.yaw);
        cap.position.set(spec.x + tz * sn, towerH + capH / 2, spec.z + tz * cs);
        cap.userData = { kind: 'building', buildingType: spec.type, buildingId: spec.id, part: 'clockCap' };
        group.add(cap);
        physics.addStaticBox({ x: cap.position.x, y: towerH + capH / 2 - 1, z: cap.position.z }, { x: 2.5, y: capH / 2 - 1, z: 2.5 }, spec.yaw);
        // Clock faces on the three open sides of the tower.
        const cy = towerH - 7;
        addWindow(spec, 0, cy, tz + 5.1, 4.5, 4.5, 0.25);
        addWindow(spec, -5.1, cy, tz, 0.25, 4.5, 4.5);
        addWindow(spec, 5.1, cy, tz, 0.25, 4.5, 4.5);
        windows(spec, 0.42, 4, 10, 8);
        break;
      }
      case 'carPark': {
        part(spec, 'body', 0, 0, 0, w, h, d, m);
        part(spec, 'stairCore', -w / 2 + 5, h, -d / 2 + 5, 7, 3.5, 7, m);
        break;
      }
      case 'church': {
        part(spec, 'nave', 0, 0, 0, w, h, d, m);
        part(spec, 'roof', 0, h, 0, w * 0.75, 4.5, d, mats.slate);
        const tz = -d / 2 + 4.5;
        const towerH = 26;
        part(spec, 'tower', 0, 0, tz, 9, towerH, 9, m);
        // Spire: a thin four-sided pyramid with a stepped collider.
        const spireH = 18;
        const spire = new THREE.Mesh(new THREE.ConeGeometry(9 / Math.SQRT2, spireH, 4), mats.slate);
        spire.rotation.y = Math.PI / 4 + spec.yaw;
        const cs = Math.cos(spec.yaw);
        const sn = Math.sin(spec.yaw);
        const sx = spec.x + tz * sn;
        const sz = spec.z + tz * cs;
        spire.position.set(sx, towerH + spireH / 2, sz);
        spire.userData = { kind: 'building', buildingType: spec.type, buildingId: spec.id, part: 'spire' };
        group.add(spire);
        const steps: Array<[number, number, number]> = [[3.2, 26, 6], [2.2, 32, 6], [1.2, 38, 6]];
        for (const [hw, y0, hh] of steps) {
          physics.addStaticBox({ x: sx, y: y0 + hh / 2, z: sz }, { x: hw, y: hh / 2, z: hw }, spec.yaw);
        }
        // A few lit tall windows down the nave.
        windows(spec, 0.5, 2, 3, 20);
        break;
      }
      case 'gasholder': {
        const r = w / 2;
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 28), m);
        mesh.position.set(spec.x, h / 2, spec.z);
        mesh.userData = { kind: 'building', buildingType: spec.type, buildingId: spec.id, part: 'drum' };
        group.add(mesh);
        const body = physics.world.createRigidBody(physics.RAPIER.RigidBodyDesc.fixed().setTranslation(spec.x, h / 2, spec.z));
        physics.world.createCollider(physics.RAPIER.ColliderDesc.cylinder(h / 2, r), body);
        break;
      }
      case 'substation': {
        part(spec, 'body', 0, 0, 0, w, h, d, m);
        part(spec, 'roof', 0, h, 0, w + 0.6, 0.4, d + 0.6, mats.concreteDark);
        break;
      }
    }
  }

  // Instanced lit windows (one draw call).
  const wn = windowInstances.length / 7;
  if (wn > 0) {
    const wm = new THREE.InstancedMesh(unitBox, windowMat, wn);
    const eul = new THREE.Euler();
    for (let i = 0; i < wn; i++) {
      const o = i * 7;
      pos.set(windowInstances[o], windowInstances[o + 1], windowInstances[o + 2]);
      scl.set(windowInstances[o + 3], windowInstances[o + 4], windowInstances[o + 5]);
      quat.setFromEuler(eul.set(0, windowInstances[o + 6], 0));
      wm.setMatrixAt(i, mtx.compose(pos, quat, scl));
    }
    quat.identity();
    wm.instanceMatrix.needsUpdate = true;
    wm.computeBoundingSphere();
    wm.userData = { kind: 'decor', part: 'windows' };
    group.add(wm);
  }

  // ----- sodium street lights: thin posts with an emissive head, no real lights
  {
    const lamps: Vec3L[] = [];
    const spacing = 36;
    const nearCross = (v: number, centres: number[]) => centres.some((c) => Math.abs(v - c) < HALF_ROAD + 6);
    for (const rz of layout.roadZ) {
      let i = 0;
      for (let x = -186; x < 168; x += spacing, i++) {
        if (nearCross(x, layout.roadX)) continue;
        lamps.push({ x, y: 0, z: rz + (i % 2 === 0 ? 6.5 : -6.5) });
      }
    }
    for (const rx of layout.roadX) {
      let i = 0;
      for (let z = -170; z < 192; z += spacing, i++) {
        if (nearCross(z, layout.roadZ)) continue;
        lamps.push({ x: rx + (i % 2 === 0 ? 6.5 : -6.5), y: 0, z });
      }
    }
    const postH = 7;
    const posts = new THREE.InstancedMesh(unitBox, lampPostMat, lamps.length);
    const heads = new THREE.InstancedMesh(unitBox, lampHeadMat, lamps.length);
    lamps.forEach((l, i) => {
      pos.set(l.x, postH / 2, l.z);
      scl.set(0.25, postH, 0.25);
      posts.setMatrixAt(i, mtx.compose(pos, quat, scl));
      pos.set(l.x, postH + 0.1, l.z);
      scl.set(0.9, 0.25, 0.9);
      heads.setMatrixAt(i, mtx.compose(pos, quat, scl));
    });
    for (const im of [posts, heads]) {
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.userData = { kind: 'decor', part: 'streetLight' };
      group.add(im);
    }
  }

  scene.add(group);

  const spawn = new THREE.Vector3(layout.spawn.x, 0, layout.spawn.z);
  return { group, spawn, buildingCount: layout.specs.length, specs: layout.specs, layout };
}

