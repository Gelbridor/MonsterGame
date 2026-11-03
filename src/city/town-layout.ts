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
import type { Physics, QualityPreset, Town } from '../core/types';
import { config } from '../config';
import { detectQuality, getQualityPreset } from '../core/quality';
import { createCityMaterials, paintLampPools, type CityMaterials, type RoadInfo } from './materials';
import { FACE, MeshBuilder } from './mesh-builder';
import { addBuildingColliders, buildBuildingVisual, type BuilderSet, type BuildCtx } from './buildings';
import { buildCanal, buildViaduct, viaductParams } from './landmarks';
import { addMemorial, buildDressing } from './dressing';

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


// ---------------------------------------------------------------- build

export interface TownExtras {
  specs: BuildingSpec[];
  layout: TownLayout;
  /** World positions of every lamp head (emissive), for later light-cone effects. */
  lampPositions: THREE.Vector3[];
  /** Light colour of each lamp in `lampPositions` (sodium orange or LED white). */
  lampColors: THREE.Color[];
  /** The real point lights (nearest `quality.maxDynamicLights` lamps). */
  lights: THREE.PointLight[];
  /** Live material library (wetness / rain uniforms read config.weather every render). */
  materials: CityMaterials;
  /** Triangle ranges per building and merged mesh part, so Phase 2 can swap one building's visuals out. */
  buildingRanges: Array<{ id: number; part: string; triStart: number; triCount: number }>;
  /** Names of the merged static meshes. */
  mergedParts: string[];
}

const ZEBRAS: RoadInfo['zebras'] = [
  { axis: 'x', roadIndex: 1, at: -5 },
  { axis: 'x', roadIndex: 2, at: -5 },
  { axis: 'z', roadIndex: 2, at: -5 },
];

export function buildTown(scene: THREE.Scene, physics: Physics, quality?: QualityPreset): Town & TownExtras {
  const q = quality ?? getQualityPreset(detectQuality());
  const layout = layoutTown(config.world.seed);
  const rng = mulberry32(config.world.seed ^ 0x9e3779b9); // detail stream, independent of layout

  const group = new THREE.Group();
  group.name = 'town';
  const size = config.world.groundSize;
  const half = size / 2;

  const roadInfo: RoadInfo = {
    roadX: layout.roadX, roadZ: layout.roadZ, roadWidth: layout.roadWidth, zebras: ZEBRAS, groundSize: size,
  };
  const mats = createCityMaterials(q, roadInfo);

  const builders: BuilderSet = {
    viaduct: new MeshBuilder(), brick: new MeshBuilder(), sandstone: new MeshBuilder(), sootStone: new MeshBuilder(),
    concrete: new MeshBuilder(), slate: new MeshBuilder(), curtain: new MeshBuilder(), windows: new MeshBuilder(),
    paint: new MeshBuilder(), rust: new MeshBuilder(), signs: new MeshBuilder(),
  };
  const pavementB = new MeshBuilder();
  const plazaB = new MeshBuilder();

  // special buildings
  const spawnV = new THREE.Vector3(layout.spawn.x, 0, layout.spawn.z);
  let pubId = -1;
  let pubD = Infinity;
  for (const s of layout.specs) {
    if (s.type !== 'cornerShop') continue;
    const d = Math.hypot(s.x - spawnV.x, s.z - spawnV.z);
    if (d < pubD) { pubD = d; pubId = s.id; }
  }
  const offices = layout.specs.filter((s) => s.type === 'office').sort((a, b) => b.height - a.height);
  const towers = layout.specs.filter((s) => s.type === 'tower').sort((a, b) => b.height - a.height);

  const ctx: BuildCtx = {
    b: builders, rng, geo: q.geometryDetail, atlas: mats.atlas, layout, spills: [],
    pubId, tallestOfficeId: offices[0]?.id ?? -1, tallestTowerIds: towers.slice(0, 2).map((t) => t.id),
  };

  // ----- ground (tarmac + markings + puddles are all in the ground shader)
  const canal = layout.canal;
  const groundZ0 = canal.z1;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, half - groundZ0), mats.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, (half + groundZ0) / 2);
  ground.userData = { kind: 'ground', part: 'ground' };
  group.add(ground);
  physics.addStaticBox({ x: 0, y: -1, z: 0 }, { x: half, y: 1, z: half });

  const wallH = 30; // half height -> 60 m tall
  const wallT = 5;
  physics.addStaticBox({ x: 0, y: wallH, z: -half - wallT }, { x: half + 2 * wallT, y: wallH, z: wallT });
  physics.addStaticBox({ x: 0, y: wallH, z: half + wallT }, { x: half + 2 * wallT, y: wallH, z: wallT });
  physics.addStaticBox({ x: -half - wallT, y: wallH, z: 0 }, { x: wallT, y: wallH, z: half + 2 * wallT });
  physics.addStaticBox({ x: half + wallT, y: wallH, z: 0 }, { x: wallT, y: wallH, z: half + 2 * wallT });

  // ----- pavement slabs (flagstones + granite kerb), the market square gets setts
  const slabH = 0.15;
  for (let c = 0; c < 5; c++) {
    for (let r = 0; r < 5; r++) {
      const b = layout.blocks[c][r];
      const tgt = c === 2 && r === 2 ? plazaB : pavementB;
      tgt.box((b.x0 + b.x1) / 2, slabH / 2, (b.z0 + b.z1) / 2, b.x1 - b.x0 + 2 * PAVEMENT, slabH, b.z1 - b.z0 + 2 * PAVEMENT, FACE.NY);
    }
  }

  // ----- canal water + bank collider
  {
    const wallFront = canal.z1 - 0.8;
    const water = new THREE.Mesh(new THREE.PlaneGeometry(canal.x1 - canal.x0, wallFront - canal.z0), mats.water);
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, -0.2, (canal.z0 + wallFront) / 2);
    water.userData = { kind: 'ground', part: 'water' };
    group.add(water);
    const wallLen = canal.x1 - canal.x0;
    physics.addStaticBox({ x: 0, y: 1, z: canal.z1 - 0.4 }, { x: wallLen / 2, y: 1, z: 0.4 });
  }

  // ----- viaduct colliders (deck + piers, as in the blockout)
  {
    const v = layout.viaduct;
    const vp = viaductParams(layout);
    const cx = (v.x0 + v.x1) / 2;
    const cz = (v.z0 + v.z1) / 2;
    const len = v.z1 - v.z0;
    const w = v.x1 - v.x0;
    physics.addStaticBox({ x: cx, y: vp.deckBase + vp.deckH / 2, z: cz }, { x: w / 2, y: vp.deckH / 2, z: len / 2 });
    for (let i = 0; i < vp.count; i++) {
      const pz = v.z0 + vp.pitch * (i + 0.5);
      physics.addStaticBox({ x: cx, y: vp.deckBase / 2, z: pz }, { x: vp.pierW / 2, y: vp.deckBase / 2, z: vp.pierLen / 2 });
    }
  }

  // ----- buildings: visuals (merged) + colliders (identical boxes to the blockout)
  const ranges: TownExtras['buildingRanges'] = [];
  const builderEntries = Object.entries(builders) as Array<[string, MeshBuilder]>;
  for (const spec of layout.specs) {
    const before = builderEntries.map(([, b]) => b.triangleCount);
    buildBuildingVisual(spec, ctx);
    builderEntries.forEach(([name, b], i) => {
      const n = b.triangleCount - before[i];
      if (n > 0) ranges.push({ id: spec.id, part: name, triStart: before[i], triCount: n });
    });
    addBuildingColliders(spec, physics);
    if (spec.type === 'gasholder') {
      const r = spec.width / 2;
      const body = physics.world.createRigidBody(physics.RAPIER.RigidBodyDesc.fixed().setTranslation(spec.x, spec.height / 2, spec.z));
      physics.world.createCollider(physics.RAPIER.ColliderDesc.cylinder(spec.height / 2, r), body);
    }
  }
  buildViaduct(layout, builders, ctx);
  buildCanal(layout, builders, ctx);
  const sq = layout.blocks[2][2];
  addMemorial(builders, (sq.x0 + sq.x1) / 2 + 22, (sq.z0 + sq.z1) / 2 - 17);

  // ----- street dressing
  const dress = buildDressing({
    layout, quality: q, material: mats.paint, halfRoad: HALF_ROAD, spawn: layout.spawn, zebras: ZEBRAS, rng,
  });
  for (const m of dress.meshes) group.add(m);
  for (const l of dress.lights) group.add(l);

  // ----- bake lamp pools (+ shop spill) into the ground-light texture
  {
    const pools = dress.lamps.map((l) => ({
      x: l.position.x, z: l.position.z,
      color: (l.kind === 'led' ? [0.62, 0.72, 0.95] : [1.0, 0.5, 0.16]) as [number, number, number],
      weight: l.hasLight ? 0.55 : 1.0,
      radius: l.kind === 'led' ? 20 : 16,
    }));
    paintLampPools(mats.poolTexture, size, [...pools, ...ctx.spills]);
  }

  // ----- merged static meshes
  const mergedParts: string[] = [];
  const emit = (name: string, b: MeshBuilder, material: THREE.Material, kind: 'building' | 'ground' | 'decor'): void => {
    const g = b.build();
    if (!g) return;
    const mesh = new THREE.Mesh(g, material);
    mesh.name = `town-${name}`;
    mesh.userData = { kind, buildingType: kind === 'building' ? 'merged' : undefined, part: name };
    group.add(mesh);
    mergedParts.push(name);
  };
  emit('brick', builders.brick, mats.brick, 'building');
  emit('sandstone', builders.sandstone, mats.sandstone, 'building');
  emit('sootStone', builders.sootStone, mats.sootStone, 'building');
  emit('viaduct', builders.viaduct, mats.viaductBrick, 'building');
  emit('concrete', builders.concrete, mats.concrete, 'building');
  emit('slate', builders.slate, mats.slate, 'building');
  emit('curtain', builders.curtain, mats.curtain, 'building');
  emit('rust', builders.rust, mats.rust, 'building');
  emit('paint', builders.paint, mats.paint, 'building');
  emit('windows', builders.windows, mats.windows, 'decor');
  emit('signs', builders.signs, mats.signs, 'decor');
  emit('pavement', pavementB, mats.pavement, 'ground');
  emit('plaza', plazaB, mats.plaza, 'ground');

  scene.add(group);

  return {
    group, spawn: spawnV, buildingCount: layout.specs.length, specs: layout.specs, layout,
    lampPositions: dress.lampPositions, lampColors: dress.lamps.map((l) => new THREE.Color(l.color)), lights: dress.lights, materials: mats, buildingRanges: ranges, mergedParts,
  };
}
