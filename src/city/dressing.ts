// Street dressing: lamp posts (with real lights for the nearest N), phone
// boxes, post boxes, bus shelters, bollards, benches, bins, trees, railings,
// traffic lights, Belisha beacons, and the market-square memorial.
// Everything is instanced (or merged) and has no colliders.

import * as THREE from 'three/webgpu';
import { MeshBuilder } from './mesh-builder';
import { lin, setPaint } from './buildings';
import type { BuilderSet } from './buildings';
import type { QualityPreset } from '../core/types';
import type { TownLayout } from './town-layout';

export interface LampInfo {
  position: THREE.Vector3;
  color: number;
  kind: 'sodium' | 'led';
  hasLight: boolean;
}

export interface Dressing {
  meshes: THREE.Object3D[];
  lampPositions: THREE.Vector3[];
  lamps: LampInfo[];
  lights: THREE.PointLight[];
}

const SODIUM = 0xff9a3c;
const LED = 0xdfe8ff;

interface Inst { x: number; z: number; yaw?: number; s?: number; y?: number }

function instanced(
  name: string, geo: THREE.BufferGeometry, mat: THREE.Material, list: Inst[],
): THREE.InstancedMesh | null {
  if (list.length === 0) return null;
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  list.forEach((it, i) => {
    q.setFromAxisAngle(up, it.yaw ?? 0);
    p.set(it.x, it.y ?? 0, it.z);
    const k = it.s ?? 1;
    s.set(k, k, k);
    im.setMatrixAt(i, m.compose(p, q, s));
  });
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  im.userData = { kind: 'decor', part: name };
  im.frustumCulled = true;
  return im;
}

// ------------------------------------------------------------------ prop geometries

function lampVictorian(): MeshBuilder {
  const b = new MeshBuilder();
  setPaint(b, 0x14181a, 0.5, 0.45);
  b.box(0, 0.35, 0, 0.5, 0.7, 0.5);
  b.box(0, 0.78, 0, 0.62, 0.1, 0.62);
  b.cylinder(0, 0.8, 0, 0.16, 0.08, 4.4, 8, false);
  b.cylinder(0, 2.3, 0, 0.14, 0.14, 0.12, 8, true);
  b.cylinder(0, 5.1, 0, 0.14, 0.2, 0.25, 8, true);
  // lantern: glowing hexagonal glass, black cap and finial
  setPaint(b, 0x2a1a0a, 0, 0.5, SODIUM, 5.0);
  b.cylinder(0, 5.35, 0, 0.3, 0.34, 0.6, 6, false);
  setPaint(b, 0x14181a, 0.5, 0.45);
  b.cylinder(0, 5.95, 0, 0.42, 0.04, 0.38, 6, true);
  b.cylinder(0, 6.3, 0, 0.05, 0.03, 0.2, 5, true);
  b.cylinder(0, 5.3, 0, 0.36, 0.3, 0.06, 6, true);
  return b;
}

function lampLED(): MeshBuilder {
  const b = new MeshBuilder();
  setPaint(b, 0x6a7078, 0.8, 0.4);
  b.cylinder(0, 0, 0, 0.14, 0.09, 8.0, 8, false);
  b.cylinder(0, 0, 0, 0.2, 0.2, 0.4, 8, true);
  // arm reaching towards +x
  b.boxRot(0.9, 8.15, 0, 2.0, 0.1, 0.1, 0, 0.08);
  setPaint(b, 0x3a3f45, 0.6, 0.4);
  b.box(1.9, 8.2, 0, 0.9, 0.12, 0.34);
  setPaint(b, 0x101214, 0, 0.5, LED, 6.0);
  b.box(1.9, 8.13, 0, 0.78, 0.03, 0.26);
  return b;
}

function phoneBox(): MeshBuilder {
  const b = new MeshBuilder();
  setPaint(b, 0xb81414, 0.1, 0.32);
  b.box(0, 1.2, 0, 0.95, 2.4, 0.95);
  b.box(0, 2.45, 0, 1.08, 0.12, 1.08);
  b.pyramid(0, 2.5, 0, 1.02, 1.02, 0.28, 0.5, 0.5);
  setPaint(b, 0x111111, 0.2, 0.5);
  b.box(0, 0.05, 0, 1.05, 0.1, 1.05);
  // lit panes on all four sides
  const sides: Array<[number, number, number, number]> = [[0, 0.482, 1, 0], [0, -0.482, -1, 0], [0.482, 0, 0, 1], [-0.482, 0, 0, -1]];
  setPaint(b, 0x201808, 0, 0.5, 0xffd28a, 2.2);
  for (const [sx, sz, rx, rz] of sides) {
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 5; r++) {
        const u = (c - 1) * 0.27;
        const y = 0.55 + r * 0.32;
        const right: [number, number, number] = [rx === 0 ? (sz > 0 ? 1 : -1) : 0, 0, rz === 0 ? 0 : (sx > 0 ? -1 : 1)];
        b.plane([sx + right[0] * u, y, sz + right[2] * u], right, [0, 1, 0], 0.22, 0.26);
      }
    }
  }
  return b;
}

function postBox(): MeshBuilder {
  const b = new MeshBuilder();
  setPaint(b, 0xb01212, 0.1, 0.35);
  b.cylinder(0, 0, 0, 0.27, 0.27, 1.25, 12, false);
  b.cylinder(0, 1.25, 0, 0.3, 0.1, 0.18, 12, true);
  setPaint(b, 0x111111, 0, 0.6);
  b.box(0, 0.98, 0.265, 0.34, 0.07, 0.04);
  b.cylinder(0, 0, 0, 0.3, 0.3, 0.1, 12, true);
  return b;
}

function busShelter(): MeshBuilder {
  const b = new MeshBuilder();
  setPaint(b, 0x30363c, 0.7, 0.4);
  const w = 3.0, d = 1.3, h = 2.4;
  for (const x of [-w / 2, w / 2]) for (const z of [-d / 2, d / 2]) b.box(x, h / 2, z, 0.08, h, 0.08);
  b.box(0, h + 0.06, 0, w + 0.3, 0.1, d + 0.3);
  setPaint(b, 0x2a3036, 0.5, 0.35);
  b.box(0, h / 2 + 0.2, -d / 2, w - 0.1, h - 0.5, 0.05);
  b.box(-w / 2, h / 2 + 0.2, 0, 0.05, h - 0.5, d - 0.1);
  setPaint(b, 0x40464a, 0.4, 0.6);
  b.box(0, 0.5, -d / 2 + 0.3, w - 0.3, 0.06, 0.5);
  // backlit advert panel
  setPaint(b, 0x080808, 0, 0.5, 0xe8f0ff, 2.6);
  b.plane([w / 2 + 0.03, 1.2, 0], [0, 0, -1], [0, 1, 0], 1.0, 1.7);
  b.plane([w / 2 - 0.03, 1.2, 0], [0, 0, 1], [0, 1, 0], 1.0, 1.7);
  // route sign
  setPaint(b, 0xd8c020, 0, 0.5, 0xffe040, 1.6);
  b.box(-w / 2 - 0.15, 2.7, d / 2 - 0.1, 0.5, 0.4, 0.04);
  return b;
}

function bollard(): MeshBuilder {
  const b = new MeshBuilder();
  setPaint(b, 0x1c1f22, 0.5, 0.45);
  b.cylinder(0, 0, 0, 0.11, 0.1, 0.95, 8, true);
  setPaint(b, 0xd0d0d0, 0.2, 0.4, 0xe0e8ff, 0.25);
  b.cylinder(0, 0.72, 0, 0.115, 0.115, 0.09, 8, false);
  return b;
}

function bench(): MeshBuilder {
  const b = new MeshBuilder();
  setPaint(b, 0x1d2022, 0.7, 0.45);
  for (const x of [-0.8, 0.8]) {
    b.box(x, 0.2, 0, 0.06, 0.4, 0.5);
    b.box(x, 0.65, -0.22, 0.06, 0.55, 0.06);
  }
  setPaint(b, 0x4a3320, 0, 0.7);
  for (let i = 0; i < 4; i++) b.box(0, 0.44, -0.18 + i * 0.12, 1.9, 0.04, 0.09);
  for (let i = 0; i < 3; i++) b.box(0, 0.62 + i * 0.12, -0.24, 1.9, 0.09, 0.03);
  return b;
}

function litterBin(): MeshBuilder {
  const b = new MeshBuilder();
  setPaint(b, 0x1f3326, 0.4, 0.5);
  b.cylinder(0, 0, 0, 0.26, 0.27, 0.85, 10, false);
  setPaint(b, 0x15171a, 0.5, 0.5);
  b.cylinder(0, 0.85, 0, 0.29, 0.05, 0.16, 10, true);
  return b;
}

function tree(): MeshBuilder {
  const b = new MeshBuilder();
  setPaint(b, 0x2a1d14, 0, 0.9);
  b.cylinder(0, 0, 0, 0.25, 0.14, 3.2, 6, true);
  setPaint(b, 0x2a1d14, 0, 0.9);
  b.boxRot(0.5, 3.4, 0, 1.4, 0.1, 0.1, 0, 0.7);
  b.boxRot(-0.45, 3.2, 0.2, 1.2, 0.1, 0.1, 0, -0.7);
  // low-poly flat-shaded canopy blobs, dark green with a bluish moon tint
  const blobs: Array<[number, number, number, number, number]> = [
    [0, 5.0, 0, 2.2, 0x1b3a1f], [1.3, 4.3, 0.4, 1.6, 0x16331a], [-1.2, 4.4, -0.5, 1.7, 0x1e3f22],
    [0.2, 6.0, 0.3, 1.5, 0x234726], [-0.4, 4.2, 1.3, 1.4, 0x173419],
  ];
  for (const [x, y, z, r, c] of blobs) {
    setPaint(b, c, 0, 0.85);
    const g = new THREE.IcosahedronGeometry(r, 1).toNonIndexed();
    g.computeVertexNormals();
    // jitter vertices for a hand-made silhouette
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i += 3) {
      const k = 1 + Math.sin(i * 12.9898 + x * 4.1 + y) * 0.12;
      for (let j = 0; j < 3; j++) pos.setXYZ(i + j, pos.getX(i + j) * k, pos.getY(i + j) * (k * 0.9), pos.getZ(i + j) * k);
    }
    g.computeVertexNormals();
    b.addGeometry(g, new THREE.Matrix4().makeTranslation(x, y, z));
    g.dispose();
  }
  return b;
}

function railing(): MeshBuilder {
  const b = new MeshBuilder();
  setPaint(b, 0x101214, 0.6, 0.45);
  const L = 2.0;
  b.box(0, 0.95, 0, L, 0.06, 0.06);
  b.box(0, 0.2, 0, L, 0.06, 0.06);
  for (let i = 0; i <= 8; i++) {
    const x = -L / 2 + (i / 8) * L;
    b.box(x, 0.5, 0, 0.03, 0.95, 0.03);
    b.pyramid(x, 0.98, 0, 0.06, 0.06, 0.1);
  }
  for (const x of [-L / 2, L / 2]) {
    b.box(x, 0.55, 0, 0.1, 1.1, 0.1);
    b.cylinder(x, 1.1, 0, 0.07, 0.04, 0.12, 6, true);
  }
  return b;
}

function trafficLight(red: boolean): MeshBuilder {
  const b = new MeshBuilder();
  setPaint(b, 0x25292d, 0.6, 0.45);
  b.cylinder(0, 0, 0, 0.07, 0.06, 3.5, 8, true);
  b.box(0, 3.2, 0.0, 0.3, 0.95, 0.25);
  const cols: Array<[number, number]> = [[0xff1a10, 3.45], [0xffa000, 3.2], [0x20ff50, 2.95]];
  cols.forEach(([hex, y], i) => {
    const on = red ? i === 0 : i === 2;
    if (on) setPaint(b, 0x100808, 0, 0.5, hex, 7);
    else setPaint(b, 0x0a0a0a, 0, 0.6);
    b.plane([0, y, 0.13], [1, 0, 0], [0, 1, 0], 0.18, 0.18);
  });
  setPaint(b, 0x25292d, 0.6, 0.45);
  b.box(0.12, 1.3, 0.0, 0.1, 0.16, 0.1);
  return b;
}

function belisha(): MeshBuilder {
  const b = new MeshBuilder();
  for (let i = 0; i < 6; i++) {
    setPaint(b, i % 2 === 0 ? 0x0e0e0e : 0xe8e8e0, 0, 0.5);
    b.cylinder(0, i * 0.4, 0, 0.065, 0.065, 0.4, 8, false);
  }
  setPaint(b, 0x3a2a08, 0, 0.4, 0xffa020, 5.5);
  const g = new THREE.IcosahedronGeometry(0.24, 1);
  b.addGeometry(g, new THREE.Matrix4().makeTranslation(0, 2.6, 0));
  g.dispose();
  setPaint(b, 0x0e0e0e, 0, 0.5);
  b.cylinder(0, 2.4, 0, 0.1, 0.1, 0.06, 8, true);
  return b;
}

// ------------------------------------------------------------------ memorial (merged into the stone batch)

export function addMemorial(b: BuilderSet, x: number, z: number): void {
  const st = b.sandstone;
  st.setFrame(x, z, 0);
  st.setAttrs([0.95, 0.95, 0.95, 0.6], [99, 0, 0, 0], [3, 12, 0.7, 0]);
  // stepped plinth
  st.boxBase(0, 0.0, 0, 7.0, 0.3, 7.0);
  st.boxBase(0, 0.3, 0, 5.8, 0.3, 5.8);
  st.boxBase(0, 0.6, 0, 4.6, 0.3, 4.6);
  st.boxBase(0, 0.9, 0, 3.0, 1.8, 3.0);
  st.boxBase(0, 2.7, 0, 3.4, 0.3, 3.4);
  // cenotaph shaft, tapering, with a cross-topped cap
  st.cylinder(0, 3.0, 0, 1.0, 0.75, 4.6, 4, true);
  st.boxBase(0, 7.6, 0, 1.6, 0.3, 1.6);
  st.boxBase(0, 7.9, 0, 0.35, 2.2, 0.35);
  st.boxBase(0, 9.2, 0, 1.3, 0.3, 0.35);
  // bronze plaques + wreaths (poppy red glows faintly)
  const p = b.paint;
  p.setFrame(x, z, 0);
  setPaint(p, 0x3a3224, 0.8, 0.4);
  for (const [px, pz, rx, rz] of [[0, 1.51, 1, 0], [0, -1.51, -1, 0], [1.51, 0, 0, 1], [-1.51, 0, 0, -1]] as Array<[number, number, number, number]>) {
    const right: [number, number, number] = [rx === 0 ? 0 : rx, 0, rz === 0 ? 0 : -rz];
    p.plane([px, 1.8, pz], right[0] === 0 && right[2] === 0 ? [1, 0, 0] : right, [0, 1, 0], 1.6, 1.0);
  }
  setPaint(p, 0x701010, 0, 0.6, 0xff2010, 0.6);
  p.box(0, 0.95, 1.6, 0.8, 0.5, 0.15);
  p.box(1.6, 0.95, 0, 0.15, 0.5, 0.8);
  p.clearFrame();
  st.clearFrame();
}

// ------------------------------------------------------------------ placement

export interface DressingOptions {
  layout: TownLayout;
  quality: QualityPreset;
  material: THREE.Material;
  halfRoad: number;
  spawn: { x: number; z: number };
  zebras: Array<{ axis: 'x' | 'z'; roadIndex: number; at: number }>;
  rng: () => number;
}

export function buildDressing(o: DressingOptions): Dressing {
  const { layout, quality, material, rng } = o;
  const meshes: THREE.Object3D[] = [];
  const rx = layout.roadX;
  const rz = layout.roadZ;
  const HR = o.halfRoad;
  const lampOff = 6.5;
  const isCentral = (i: number): boolean => i === 1 || i === 2;

  // ----- lamps
  interface LampSpot { x: number; z: number; yaw: number; kind: 'sodium' | 'led' }
  const lampSpots: LampSpot[] = [];
  const nearCross = (v: number, cs: number[]): boolean => cs.some((c) => Math.abs(v - c) < HR + 6);
  rz.forEach((z0, zi) => {
    let i = 0;
    for (let x = -186; x < 168; x += 30, i++) {
      if (nearCross(x, rx)) continue;
      const s = i % 2 === 0 ? 1 : -1;
      lampSpots.push({ x, z: z0 + s * lampOff, yaw: s > 0 ? Math.PI : 0, kind: isCentral(zi) ? 'led' : 'sodium' });
    }
  });
  rx.forEach((x0, xi) => {
    let i = 0;
    for (let z = -170; z < 192; z += 30, i++) {
      if (nearCross(z, rz)) continue;
      const s = i % 2 === 0 ? 1 : -1;
      lampSpots.push({ x: x0 + s * lampOff, z, yaw: s > 0 ? Math.PI : Math.PI / 2 * 0, kind: isCentral(xi) ? 'led' : 'sodium' });
    }
  });
  // junction corner lamps
  rx.forEach((x0, xi) => rz.forEach((z0, zi) => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const central = isCentral(xi) && isCentral(zi);
      // alternate corners to avoid overcrowding the central junctions (traffic lights live there)
      if (central && (sx * sz > 0)) continue;
      lampSpots.push({ x: x0 + sx * 6.8, z: z0 + sz * 6.8, yaw: Math.atan2(-sz, -sx), kind: central || isCentral(xi) || isCentral(zi) ? 'led' : 'sodium' });
    }
  }));

  {
    const sb = layout.blocks[2][2];
    const qx0 = sb.x0 + 2, qx1 = sb.x1 - 2, qz0 = sb.z0 + 2, qz1 = sb.z1 - 2;
    const mx = (sb.x0 + sb.x1) / 2, mz = (sb.z0 + sb.z1) / 2;
    for (const [x, z] of [[qx0, qz0], [qx1, qz0], [qx0, qz1], [qx1, qz1], [mx - 22, qz0], [mx + 22, qz0], [mx - 22, qz1], [mx + 22, qz1], [qx0, mz - 22], [qx0, mz + 22], [qx1, mz - 22], [qx1, mz + 22]]) {
      lampSpots.push({ x, z, yaw: 0, kind: 'sodium' });
    }
  }
  const victorian: Inst[] = [];
  const led: Inst[] = [];
  const lamps: LampInfo[] = [];
  for (const l of lampSpots) {
    if (l.kind === 'led') {
      // arm points towards the road: yaw so local +x faces the road centre
      const dx = (Math.abs(l.x - nearest(rx, l.x)) < Math.abs(l.z - nearest(rz, l.z)))
        ? nearest(rx, l.x) - l.x : 0;
      const dz = dx === 0 ? nearest(rz, l.z) - l.z : 0;
      const yaw = Math.atan2(-dz, dx);
      led.push({ x: l.x, z: l.z, yaw });
      lamps.push({ position: new THREE.Vector3(l.x + Math.cos(yaw) * 1.9, 8.1, l.z - Math.sin(yaw) * 1.9), color: LED, kind: 'led', hasLight: false });
    } else {
      victorian.push({ x: l.x, z: l.z, yaw: l.yaw });
      lamps.push({ position: new THREE.Vector3(l.x, 5.45, l.z), color: SODIUM, kind: 'sodium', hasLight: false });
    }
  }
  const mkInst = (name: string, mb: MeshBuilder, list: Inst[]): void => {
    const g = mb.build();
    if (!g) return;
    const im = instanced(name, g, material, list);
    if (im) meshes.push(im);
  };
  mkInst('lampVictorian', lampVictorian(), victorian);
  mkInst('lampLED', lampLED(), led);

  // real lights on the nearest lamps
  const lights: THREE.PointLight[] = [];
  const order = lamps
    .map((l, i) => ({ i, d: Math.hypot(l.position.x - o.spawn.x, l.position.z - o.spawn.z) }))
    .sort((a, b) => a.d - b.d);
  for (let k = 0; k < Math.min(quality.maxDynamicLights, order.length); k++) {
    const l = lamps[order[k].i];
    const pl = l.kind === 'led'
      ? new THREE.PointLight(LED, 360, 34, 2)
      : new THREE.PointLight(SODIUM, 300, 30, 2);
    pl.position.copy(l.position).add(new THREE.Vector3(0, -0.4, 0));
    pl.castShadow = false;
    lights.push(pl);
    l.hasLight = true;
  }

  // ----- street furniture on the pavements
  const phone: Inst[] = [];
  const post: Inst[] = [];
  const shelters: Inst[] = [];
  const bollards: Inst[] = [];
  const benches: Inst[] = [];
  const bins: Inst[] = [];
  const trees: Inst[] = [];
  const rails: Inst[] = [];
  const tlRed: Inst[] = [];
  const tlGreen: Inst[] = [];
  const beacons: Inst[] = [];

  // junction furniture: phone boxes, post boxes and traffic lights on the central junctions
  let n = 0;
  rx.forEach((x0, xi) => rz.forEach((z0, zi) => {
    const central = isCentral(xi) && isCentral(zi);
    n++;
    if (central) {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        // traffic light at each corner kerb, facing in along its road
        const x = x0 + sx * 5.6;
        const z = z0 + sz * 5.6;
        const faceX = (sx + sz) > 0;
        const list = (faceX ? tlRed : tlGreen);
        list.push({ x, z, yaw: Math.atan2(-sx, -sz) });
        // second head on the other approach
        (faceX ? tlGreen : tlRed).push({ x: x0 + sx * 5.6, z: z0 - sz * 5.6, yaw: Math.atan2(-sx, sz), s: 0 });
      }
    }
    if (n % 3 === 0) phone.push({ x: x0 + 6.6, z: z0 - 8.8, yaw: Math.PI / 2 });
    if (n % 4 === 1) post.push({ x: x0 - 7.2, z: z0 + 8.6, yaw: 0 });
    if (n % 5 === 2) bins.push({ x: x0 + 7.4, z: z0 + 8.8 });
  }));
  // drop the degenerate (scale 0) duplicates used above for symmetry
  for (const l of [tlRed, tlGreen]) for (let i = l.length - 1; i >= 0; i--) if (l[i].s === 0) l.splice(i, 1);

  // bus shelters along central roads
  shelters.push(
    { x: -20, z: rz[2] + 7.2, yaw: 0 }, { x: 20, z: rz[1] - 7.2, yaw: Math.PI },
    { x: rx[1] - 7.2, z: -120, yaw: Math.PI / 2 }, { x: rx[2] + 7.2, z: 90, yaw: -Math.PI / 2 },
  );

  // zebra crossing beacons + bollards
  for (const z of o.zebras) {
    if (z.axis === 'x') {
      const cz = rz[z.roadIndex];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        beacons.push({ x: z.at + sx * 2.6, z: cz + sz * 5.5 });
      }
      for (const sz of [-1, 1]) for (let k = -2; k <= 2; k++) {
        if (k === 0) continue;
        bollards.push({ x: z.at + k * 2.0 + (k > 0 ? 3 : -3), z: cz + sz * 5.6 });
      }
    } else {
      const cx = rx[z.roadIndex];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        beacons.push({ x: cx + sx * 5.5, z: z.at + sz * 2.6 });
      }
    }
  }

  // the market square: railings round the edge with gaps at the entrances, trees, benches, bollards
  {
    const b = layout.blocks[2][2];
    const x0 = b.x0 - 1.4, x1 = b.x1 + 1.4, z0 = b.z0 - 1.4, z1 = b.z1 + 1.4;
    const seg = 2.0;
    const cxm = (x0 + x1) / 2, czm = (z0 + z1) / 2;
    const gapHalf = 6;
    for (let x = x0 + seg / 2; x < x1; x += seg) {
      if (Math.abs(x - cxm) < gapHalf) continue;
      rails.push({ x, z: z0, yaw: 0 });
      rails.push({ x, z: z1, yaw: 0 });
    }
    for (let z = z0 + seg / 2; z < z1; z += seg) {
      if (Math.abs(z - czm) < gapHalf) continue;
      rails.push({ x: x0, z, yaw: Math.PI / 2 });
      rails.push({ x: x1, z, yaw: Math.PI / 2 });
    }
    // bollards flanking the gaps
    for (const s of [-1, 1]) {
      for (const [bx, bz] of [[cxm + s * gapHalf, z0], [cxm + s * gapHalf, z1], [x0, czm + s * gapHalf], [x1, czm + s * gapHalf]]) bollards.push({ x: bx, z: bz });
    }
    // trees at intervals just inside the rail
    for (let t = 0; t < 8; t++) {
      const a = x0 + 6 + t * ((x1 - x0 - 12) / 7);
      if (Math.abs(a - cxm) < 9) continue;
      trees.push({ x: a, z: z0 + 3.4, s: 0.9 + rng() * 0.3, yaw: rng() * 6 });
      trees.push({ x: a, z: z1 - 3.4, s: 0.9 + rng() * 0.3, yaw: rng() * 6 });
    }
    for (let t = 0; t < 6; t++) {
      const a = z0 + 9 + t * ((z1 - z0 - 18) / 5);
      if (Math.abs(a - czm) < 9) continue;
      trees.push({ x: x0 + 3.4, z: a, s: 0.9 + rng() * 0.3, yaw: rng() * 6 });
      trees.push({ x: x1 - 3.4, z: a, s: 0.9 + rng() * 0.3, yaw: rng() * 6 });
    }
    // benches facing the middle
    for (const [bx, bz, yaw] of [[cxm - 16, z0 + 5.4, 0], [cxm + 16, z0 + 5.4, 0], [cxm - 16, z1 - 5.4, Math.PI], [cxm + 16, z1 - 5.4, Math.PI],
      [x0 + 5.4, czm - 16, Math.PI / 2], [x1 - 5.4, czm + 16, -Math.PI / 2]] as Array<[number, number, number]>) benches.push({ x: bx, z: bz, yaw });
    for (const [bx, bz] of [[cxm - 10, z0 + 5.6], [cxm + 10, z1 - 5.6], [x0 + 5.6, czm + 10], [x1 - 5.6, czm - 10]]) bins.push({ x: bx, z: bz });
  }

  // street trees along the pavements of the main streets
  const lampXZ = lampSpots.map((l) => [l.x, l.z] as const);
  const free = (x: number, z: number): boolean => lampXZ.every(([lx, lz]) => Math.hypot(lx - x, lz - z) > 4);
  rz.forEach((z0, zi) => {
    if (!isCentral(zi) && zi !== 0) return;
    for (let x = -176; x < 160; x += 22 + rng() * 6) {
      if (nearCross(x, rx)) continue;
      const z = z0 + (rng() < 0.5 ? -1 : 1) * 7.4;
      if (!free(x, z)) continue;
      trees.push({ x, z, s: 0.8 + rng() * 0.35, yaw: rng() * 6 });
    }
  });
  rx.forEach((x0, xi) => {
    if (!isCentral(xi)) return;
    for (let z = -160; z < 190; z += 24 + rng() * 6) {
      if (nearCross(z, rz)) continue;
      const x = x0 + (rng() < 0.5 ? -1 : 1) * 7.4;
      if (!free(x, z)) continue;
      trees.push({ x, z, s: 0.8 + rng() * 0.35, yaw: rng() * 6 });
    }
  });
  // a few benches + bins on the main streets
  benches.push({ x: 4, z: rz[2] - 7.4, yaw: 0 }, { x: -70, z: rz[1] + 7.4, yaw: Math.PI });

  mkInst('phoneBox', phoneBox(), phone);
  mkInst('postBox', postBox(), post);
  mkInst('busShelter', busShelter(), shelters);
  mkInst('bollard', bollard(), bollards);
  mkInst('bench', bench(), benches);
  mkInst('litterBin', litterBin(), bins);
  mkInst('tree', tree(), trees);
  mkInst('railing', railing(), rails);
  mkInst('trafficRed', trafficLight(true), tlRed);
  mkInst('trafficGreen', trafficLight(false), tlGreen);
  mkInst('belisha', belisha(), beacons);

  return { meshes, lampPositions: lamps.map((l) => l.position.clone()), lamps, lights };
}

function nearest(list: number[], v: number): number {
  let best = list[0];
  for (const r of list) if (Math.abs(r - v) < Math.abs(best - v)) best = r;
  return best;
}

export { lin };
