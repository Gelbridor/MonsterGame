// Basalt's body: a bone hierarchy of THREE.Groups, each carrying ONE merged mesh
// of rock chunks (noise-displaced boulders, hexagonal basalt columns, slabs and
// spikes) sharing one lava-crack material. About 24 draw calls in total.
//
// Rest pose: feet at y = 0, facing -Z, +X is Basalt's right. All bones have
// identity rest rotation; the animator poses them. Dimensions:
//
//   pelvis y 10.6 | chest y 16.6 | shoulders y 21.2, x +-6.9 | head y 21.8, z -5.6
//   tallest back column ~ y 30 | legs 9.9 m (hip y 9.7, ankle 1.5 above ground)
//   arms hang ~17 m from the shoulder, fists ~3 m above the ground.

import * as THREE from 'three/webgpu';
import type { QualityPreset } from '../core/types';
import { addBundle, blob, column, makeRng, MeshBuilder, slab, spike, type Chunk, type MatOptions, type PlaceOptions } from './basalt-geom';
import { createBasaltMaterial, type BasaltMaterialHandle } from './rock-material';

export type BoneName =
  | 'pelvis'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'jaw'
  | 'shoulderL'
  | 'shoulderR'
  | 'upperArmL'
  | 'upperArmR'
  | 'foreArmL'
  | 'foreArmR'
  | 'handL'
  | 'handR'
  | 'thighL'
  | 'thighR'
  | 'shinL'
  | 'shinR'
  | 'footL'
  | 'footR'
  | 'tail1'
  | 'tail2'
  | 'tail3'
  | 'tail4';

/** Local offset of each bone from its parent in the rest pose (m). */
export const BONE_REST: Record<BoneName, { parent: BoneName | null; offset: [number, number, number] }> = {
  pelvis: { parent: null, offset: [0, 10.6, 1.4] },
  spine: { parent: 'pelvis', offset: [0, 2.8, -0.8] },
  chest: { parent: 'spine', offset: [0, 3.2, -1.2] },
  neck: { parent: 'chest', offset: [0, 4.0, -2.8] },
  head: { parent: 'neck', offset: [0, 1.2, -2.2] },
  jaw: { parent: 'head', offset: [0, -1.3, -0.9] },
  shoulderR: { parent: 'chest', offset: [6.9, 4.6, -1.0] },
  shoulderL: { parent: 'chest', offset: [-6.9, 4.6, -1.0] },
  upperArmR: { parent: 'shoulderR', offset: [0, 0, 0] },
  upperArmL: { parent: 'shoulderL', offset: [0, 0, 0] },
  foreArmR: { parent: 'upperArmR', offset: [0, -7.8, 0] },
  foreArmL: { parent: 'upperArmL', offset: [0, -7.8, 0] },
  handR: { parent: 'foreArmR', offset: [0, -8.4, 0] },
  handL: { parent: 'foreArmL', offset: [0, -8.4, 0] },
  thighR: { parent: 'pelvis', offset: [3.5, -0.9, 0.2] },
  thighL: { parent: 'pelvis', offset: [-3.5, -0.9, 0.2] },
  shinR: { parent: 'thighR', offset: [0, -4.9, 0] },
  shinL: { parent: 'thighL', offset: [0, -4.9, 0] },
  footR: { parent: 'shinR', offset: [0, -5.0, 0] },
  footL: { parent: 'shinL', offset: [0, -5.0, 0] },
  tail1: { parent: 'pelvis', offset: [0, -0.6, 3.4] },
  tail2: { parent: 'tail1', offset: [0, 0, 3.8] },
  tail3: { parent: 'tail2', offset: [0, 0, 3.5] },
  tail4: { parent: 'tail3', offset: [0, 0, 3.1] },
};

export const THIGH_LEN = 4.9;
export const SHIN_LEN = 5.0;
/** Ankle height above the sole (m). */
export const ANKLE_HEIGHT = 1.45;

export interface BasaltRig {
  /** Model-space root (feet at origin, faces -Z). */
  root: THREE.Group;
  bones: Record<BoneName, THREE.Group>;
  material: BasaltMaterialHandle;
  /** Rest-pose world (model-space) position of each bone. */
  restWorld: Record<BoneName, THREE.Vector3>;
  stats: { triangles: number; meshes: number; chunks: number };
}

type V3 = [number, number, number];

/** Icosahedron detail per size class [small, mid, big] by geometryDetail. */
const BLOB_DETAIL: Record<0 | 1 | 2, [number, number, number]> = {
  0: [0, 0, 1],
  1: [0, 1, 2],
  2: [1, 2, 3],
};

export function createBasaltRig(quality: QualityPreset): BasaltRig {
  const gd = quality.geometryDetail;
  const detail = BLOB_DETAIL[gd];
  const richness = [0.45, 0.75, 1][gd]; // scales decorative counts
  const material = createBasaltMaterial(quality);

  // ------------------------------------------------------------- bones
  const names = Object.keys(BONE_REST) as BoneName[];
  const bones = {} as Record<BoneName, THREE.Group>;
  const restWorld = {} as Record<BoneName, THREE.Vector3>;
  const root = new THREE.Group();
  root.name = 'BasaltModel';
  for (const n of names) {
    const g = new THREE.Group();
    g.name = n;
    bones[n] = g;
  }
  for (const n of names) {
    const { parent, offset } = BONE_REST[n];
    bones[n].position.set(...offset);
    (parent ? bones[parent] : root).add(bones[n]);
  }
  for (const n of names) {
    const w = new THREE.Vector3(...BONE_REST[n].offset);
    let p = BONE_REST[n].parent;
    while (p) {
      w.add(new THREE.Vector3(...BONE_REST[p].offset));
      p = BONE_REST[p].parent;
    }
    restWorld[n] = w;
  }

  let seedCounter = 1;
  const builders = {} as Record<BoneName, MeshBuilder>;
  for (const n of names) builders[n] = new MeshBuilder(restWorld[n], n.length * 13 + 5);

  // ------------------------------------------------------------- helpers
  const nextSeed = () => seedCounter++;
  /** Lumpy boulder. size class 0 small / 1 mid / 2 big picks the subdivision. */
  const rock = (
    bone: BoneName,
    cls: 0 | 1 | 2,
    p: V3,
    s: V3 | number,
    m: MatOptions = {},
    o: { amp?: number; r?: V3; squarish?: number; freq?: number } = {},
  ): void => {
    const chunk = blob({ detail: detail[cls], seed: nextSeed(), amp: o.amp ?? 0.24, squarish: o.squarish, freq: o.freq });
    builders[bone].add(chunk, { p, s, r: o.r }, m);
  };
  const plate = (bone: BoneName, p: V3, s: V3, r: V3 = [0, 0, 0], m: MatOptions = {}, jitter = 0.14): void => {
    builders[bone].add(slab({ seed: nextSeed(), jitter }), { p, s, r }, m);
  };
  /** Single column; tilt as euler (x rotates toward +Z, z towards -X). */
  const col = (
    bone: BoneName,
    p: V3,
    r: V3,
    rBot: number,
    h: number,
    m: MatOptions = {},
    o: { rTop?: number; tip?: number; sides?: number; cap?: boolean } = {},
  ): void => {
    const chunk = column({ rBot, rTop: o.rTop, h, seed: nextSeed(), tip: o.tip, sides: o.sides ?? 6, capBottom: o.cap, rot: nextSeed() * 0.7 });
    builders[bone].add(chunk, { p, r }, m);
  };
  const claw = (bone: BoneName, p: V3, r: V3, rad: number, h: number, m: MatOptions = {}): void => {
    builders[bone].add(spike(rad, h, nextSeed(), 5), { p, r }, { tint: 1.25, ...m });
  };
  /** Glowing joint collar: a flattened molten ellipsoid peeking out of a seam. */
  const collar = (bone: BoneName, p: V3, s: V3, molten = 0.8, r: V3 = [0, 0, 0]): void => {
    builders[bone].add(blob({ detail: detail[0], seed: nextSeed(), amp: 0.12 }), { p, s, r }, { lava: molten, crack: 0, tint: 0.6 });
  };
  /** Hex-packed basalt column bundle forming a limb. `radius` is the whole bundle's radius. */
  const bundle = (
    bone: BoneName,
    origin: V3,
    dir: V3,
    radius: number,
    len: number,
    rings: number,
    o: { taper?: number; lava?: number; crack?: number; coreLava?: number; lenVar?: number; tint?: number } = {},
  ): void => {
    const rr = Math.min(rings, [0, 1, 2][gd]);
    const colR = radius / (1 + rr * Math.sqrt(3) * 1.02);
    addBundle(builders[bone], {
      origin,
      dir,
      rings: rr,
      colR,
      len,
      seed: nextSeed(),
      detailSides: rr === 0 ? 7 : 6,
      taper: o.taper,
      lava: o.lava,
      crack: o.crack ?? 1.2,
      coreLava: o.coreLava ?? 0.22,
      lenVar: o.lenVar ?? 0.2,
      tint: o.tint,
    });
  };
  const rng = makeRng(4242);

  // ================================================================ PELVIS
  rock('pelvis', 2, [0, 0.5, 0], [4.9, 3.4, 4.1], {}, { amp: 0.2 });
  rock('pelvis', 1, [2.6, -0.5, 1.2], [2.9, 2.6, 2.9]);
  rock('pelvis', 1, [-2.6, -0.5, 1.2], [2.9, 2.6, 2.9]);
  rock('pelvis', 1, [0, -0.9, 2.4], [2.8, 2.3, 2.5]);
  plate('pelvis', [0, -1.0, -3.4], [3.6, 3.0, 1.1], [0.25, 0, 0], { crack: 1.6 }); // groin plate
  plate('pelvis', [4.3, 0.9, -1.0], [1.4, 2.8, 3.8], [0, 0, -0.35], { crack: 1.4 });
  plate('pelvis', [-4.3, 0.9, -1.0], [1.4, 2.8, 3.8], [0, 0, 0.35], { crack: 1.4 });
  collar('pelvis', [0, 2.0, -0.5], [3.7, 0.55, 3.3], 0.75);
  collar('pelvis', [3.5, -0.9, 0.2], [2.3, 1.7, 2.3], 0.8);
  collar('pelvis', [-3.5, -0.9, 0.2], [2.3, 1.7, 2.3], 0.8);
  for (let i = 0; i < Math.round(4 * richness) + 1; i++) {
    const a = (i / 4 - 0.5) * 2.4;
    col('pelvis', [a * 1.6, 1.8, 2.6 + Math.abs(a) * 0.3], [0.6 + rng() * 0.3, 0, -a * 0.3], 0.85, 3.2 + rng() * 2.4, { crack: 1 });
  }

  // ================================================================ SPINE (belly)
  rock('spine', 2, [0, 0.1, -0.5], [4.4, 3.4, 4.0], { crack: 2.0 }, { amp: 0.18 });
  // Segmented belly plates with lava between them.
  for (let i = 0; i < 3; i++) {
    const y = -1.4 + i * 1.45;
    plate('spine', [0, y, -3.55 - (i === 1 ? 0.12 : 0)], [3.9 - i * 0.2, 1.05, 0.95], [0.04 * (i - 1), 0, 0.03 * (i - 1)], { crack: 0.8 });
  }
  plate('spine', [0, -0.68, -3.4], [3.5, 0.3, 0.7], [0, 0, 0], { lava: 0.9, crack: 0 });
  plate('spine', [0, 0.78, -3.4], [3.3, 0.3, 0.7], [0, 0, 0], { lava: 0.9, crack: 0 });
  plate('spine', [3.5, 0.1, -1.0], [1.3, 3.2, 3.2], [0, 0, -0.18], { crack: 1.5 });
  plate('spine', [-3.5, 0.1, -1.0], [1.3, 3.2, 3.2], [0, 0, 0.18], { crack: 1.5 });
  collar('spine', [0, 2.35, -1.2], [3.8, 0.6, 3.6], 0.8);
  // Back ridge.
  for (let i = 0; i < Math.round(5 * richness) + 1; i++) {
    const a = (i % 2 ? 1 : -1) * (0.4 + (i >> 1) * 0.55);
    col('spine', [a * 1.5, 1.2, 2.7], [0.5 + rng() * 0.35, 0, -a * 0.18], 0.95, 4 + rng() * 3.5, { crack: 1 });
  }

  // ================================================================ CHEST
  rock('chest', 2, [0, 1.4, -0.2], [6.7, 5.2, 5.0], { crack: 1.3 }, { amp: 0.17 });
  rock('chest', 2, [0, 4.2, 1.2], [5.6, 3.0, 3.7], { crack: 2.4 }, { amp: 0.2 });
  // Molten seam running down the spine between the column bundles.
  plate('chest', [0, 2.8, 3.1], [1.1, 6.5, 0.9], [0.35, 0, 0], { lava: 0.85, crack: 0 }, 0.05);
  rock('chest', 1, [4.7, 0.9, 0.0], [2.8, 3.4, 3.4]);
  rock('chest', 1, [-4.7, 0.9, 0.0], [2.8, 3.4, 3.4]);
  // Pecs: broad plates, riddled with cracks, framing the core.
  rock('chest', 2, [3.0, 1.7, -3.5], [3.5, 3.0, 2.4], { crack: 1.5 }, { amp: 0.2, squarish: 0.3 });
  rock('chest', 2, [-3.0, 1.7, -3.5], [3.5, 3.0, 2.4], { crack: 1.5 }, { amp: 0.2, squarish: 0.3 });
  // The lava core, seen between the pecs, with a glowing heart-pit above and below.
  rock('chest', 1, [0, 1.1, -4.15], [1.8, 2.5, 1.1], { lava: 1.05, crack: 0, tint: 0.5 }, { amp: 0.14 });
  rock('chest', 0, [0, -1.4, -4.1], [1.2, 0.7, 0.8], { lava: 0.8, crack: 0 }, { amp: 0.1 });
  // Ribs: slanted plates down the flanks.
  for (let i = 0; i < 3; i++) {
    const y = -0.7 + i * 1.65;
    plate('chest', [5.7 - i * 0.1, y, -1.4], [1.1, 1.1, 4.4], [0, 0.32, -0.2], { crack: 1.5 });
    plate('chest', [-5.7 + i * 0.1, y, -1.4], [1.1, 1.1, 4.4], [0, -0.32, 0.2], { crack: 1.5 });
  }
  collar('chest', [0, 5.7, -2.2], [3.2, 0.75, 2.6], 0.75);
  // Great back-spine: the tallest basalt columns.
  bundle('chest', [0, 4.3, 1.6], [0, 0.88, 0.48], 3.0, 10.5, 2, { taper: 0.72, crack: 1.8, lenVar: 0.45, coreLava: 0.4, lava: 0.1 });
  bundle('chest', [3.4, 4.1, 1.2], [0.32, 0.9, 0.3], 2.2, 7.8, 1, { taper: 0.7, crack: 1.4, lenVar: 0.4 });
  bundle('chest', [-3.4, 4.1, 1.2], [-0.32, 0.9, 0.3], 2.2, 8.4, 1, { taper: 0.7, crack: 1.4, lenVar: 0.4 });
  const nBack = Math.round(7 * richness);
  for (let i = 0; i < nBack; i++) {
    const a = (i / Math.max(1, nBack - 1) - 0.5) * 2;
    col(
      'chest',
      [a * 4.6, 3.6 - Math.abs(a) * 0.9, 2.2 - Math.abs(a) * 1.4],
      [0.38 + rng() * 0.45, rng() * 0.6 - 0.3, -a * 0.55],
      0.8 + rng() * 0.45,
      3.5 + rng() * 4.2 - Math.abs(a) * 1.2,
      { crack: 1.1 },
      { tip: rng() < 0.4 ? 1.0 : 0 },
    );
  }
  // Rubble on the back.
  for (let i = 0; i < Math.round(8 * richness); i++) {
    rock('chest', 0, [(rng() - 0.5) * 9, 1 + rng() * 5, 2.5 + rng() * 1.6], 0.7 + rng() * 1.1, {}, { r: [rng() * 3, rng() * 3, 0] });
  }

  // ================================================================ NECK + HEAD
  rock('neck', 1, [0, 0, -0.3], [2.7, 2.3, 2.7], {}, { amp: 0.15 });
  col('neck', [-1.1, 0.8, 1.2], [0.7, 0, 0.15], 0.6, 3.3);
  col('neck', [1.1, 0.8, 1.2], [0.7, 0, -0.15], 0.6, 3.0);
  col('neck', [0, 1.1, 1.5], [0.8, 0, 0], 0.7, 3.8);

  // Skull, brow, muzzle.
  rock('head', 2, [0, 0.3, -0.4], [2.55, 2.15, 2.65], {}, { amp: 0.14 });
  plate('head', [0, 1.15, -2.3], [5.3, 0.95, 1.7], [-0.18, 0, 0], { crack: 1.3 }, 0.18); // heavy brow
  col('head', [2.5, 1.3, -1.8], [0.5, 0, -1.1], 0.6, 2.5, {}, { tip: 0.8 }); // brow horns sweep out and back
  col('head', [-2.5, 1.3, -1.8], [0.5, 0, 1.1], 0.6, 2.5, {}, { tip: 0.8 });
  rock('head', 1, [0, -0.75, -3.1], [1.75, 1.0, 1.9], { crack: 1.4 }, { amp: 0.14 }); // snout
  rock('head', 1, [2.0, -0.3, -1.5], [1.1, 1.3, 1.5]); // cheeks
  rock('head', 1, [-2.0, -0.3, -1.5], [1.1, 1.3, 1.5]);
  // Eyes: white-hot slits sunk under the brow, inner ends low (angry).
  for (const s of [-1, 1]) {
    plate('head', [s * 1.05, 0.28, -3.0], [1.15, 0.4, 0.5], [0, s * 0.35, s * 0.34], { lava: 1.8, crack: 0 }, 0.05);
  }
  // Mouth glow between the jaws.
  plate('head', [0, -1.35, -2.65], [2.6, 0.55, 1.9], [0, 0, 0], { lava: 1.0, crack: 0 }, 0.1);
  // Upper teeth.
  for (let i = 0; i < 6; i++) {
    const x = (i - 2.5) * 0.52;
    claw('head', [x, -1.45, -3.85 + Math.abs(x) * 0.5], [Math.PI, 0, 0], 0.17, 0.75 + (i % 2) * 0.25, { tint: 2.2 });
  }
  // Crest: three tall columns sweeping back from the crown.
  bundle('head', [0, 1.9, 0.9], [0, 0.55, 0.85], 1.5, 4.2, 1, { taper: 0.65, crack: 0.3, coreLava: 0.0 });
  col('head', [1.2, 1.5, 0.2], [0.8, 0, -0.4], 0.5, 2.8, {}, { tip: 0.6 });
  col('head', [-1.2, 1.5, 0.2], [0.8, 0, 0.4], 0.5, 2.8, {}, { tip: 0.6 });

  // Lower jaw (jutting).
  rock('jaw', 2, [0, -0.1, -1.9], [1.95, 0.95, 2.5], {}, { amp: 0.14 });
  plate('jaw', [0, 0.0, -4.0], [2.5, 1.15, 1.2], [0.0, 0, 0], { crack: 1.2 }, 0.16); // chin block
  claw('jaw', [1.35, 0.5, -3.5], [-0.15, 0, -0.12], 0.4, 2.0); // tusks
  claw('jaw', [-1.35, 0.5, -3.5], [-0.15, 0, 0.12], 0.4, 2.0);
  for (let i = 0; i < 4; i++) {
    const x = (i - 1.5) * 0.55;
    claw('jaw', [x, 0.5, -4.5], [-0.1, 0, 0], 0.13, 0.6, { tint: 2.2 });
  }

  // ================================================================ ARMS
  for (const s of [1, -1] as const) {
    const side = s === 1 ? 'R' : 'L';
    const sh = `shoulder${side}` as BoneName;
    const ua = `upperArm${side}` as BoneName;
    const fa = `foreArm${side}` as BoneName;
    const hd = `hand${side}` as BoneName;

    // Shoulder: huge pauldron cluster.
    rock(sh, 2, [0.8 * s, 0.9, 0.2], [4.1, 3.3, 3.9], { crack: 1.5 }, { amp: 0.22, squarish: 0.2 });
    rock(sh, 1, [-1.8 * s, 0.4, 0.1], [3.2, 2.8, 3.2]); // trapezius merging into the chest
    plate(sh, [1.2 * s, 2.6, 0.1], [4.6, 1.0, 3.8], [0.05, 0, -0.32 * s], { crack: 1.6 });
    col(sh, [1.0 * s, 2.3, 0.4], [0.2, 0, -0.55 * s], 1.05, 5.6, { crack: 1 }, { tip: 1.2 });
    col(sh, [2.6 * s, 2.0, -0.5], [-0.1, 0, -1.0 * s], 0.95, 4.2, { crack: 1 }, { tip: 0.9 });
    col(sh, [-0.4 * s, 2.8, 1.0], [0.55, 0, -0.2 * s], 0.9, 5.0, { crack: 1 }, { tip: 1.0 });
    col(sh, [1.4 * s, 2.4, 1.6], [0.7, 0, -0.55 * s], 0.8, 4.0, { crack: 1 });
    collar(sh, [0, -1.9, 0], [2.9, 0.6, 2.9], 0.85);

    // Upper arm: a bundle of columns + deltoid.
    bundle(ua, [0, 0.2, 0], [0, -1, 0], 2.9, 7.6, 2, { taper: 0.92, crack: 1.3 });
    rock(ua, 1, [0.3 * s, -1.7, 0.2], [3.1, 2.7, 3.1], { crack: 1.3 });
    rock(ua, 1, [0.0, -7.5, 0.4], [2.7, 1.8, 2.8], { crack: 1.3 });

    // Forearm: massive.
    collar(fa, [0, 0.1, 0], [2.4, 0.5, 2.4], 0.9);
    bundle(fa, [0, -0.3, 0], [0, -1, 0], 3.6, 8.4, 2, { taper: 0.88, crack: 1.5 });
    rock(fa, 2, [0, -0.9, 0.4], [3.1, 2.2, 3.2], { crack: 1.5 }, { amp: 0.2 });
    rock(fa, 1, [0.5 * s, -4.5, -0.6], [2.9, 3.6, 2.7], { crack: 1.5 }, { amp: 0.2, squarish: 0.25 }); // outer bracer
    col(fa, [0, -0.4, 2.7], [1.3, 0, 0], 0.9, 3.4, {}, { tip: 1.0 }); // elbow spike
    col(fa, [0.2 * s, -0.6, 2.4], [1.0, 0, -0.5 * s], 0.65, 2.4, {}, { tip: 0.6 });

    // Fist: knuckles that nearly scrape the ground.
    collar(hd, [0, 0.05, 0], [2.3, 0.45, 2.3], 0.9);
    rock(hd, 2, [0, -2.1, -0.2], [3.1, 2.6, 3.2], { crack: 1.6 }, { amp: 0.2 });
    for (let i = 0; i < 4; i++) {
      const x = (i - 1.5) * 1.5;
      rock(hd, 1, [x, -3.1, -2.2], [0.95, 1.0, 1.1], {}, { amp: 0.2 });
      claw(hd, [x, -3.45, -2.9], [-1.85, 0, 0], 0.4, 1.7);
    }
    rock(hd, 1, [-2.7 * s, -1.9, -1.7], [1.3, 1.5, 1.4]); // thumb
    claw(hd, [-3.1 * s, -2.5, -2.4], [-1.9, 0, 0.3 * s], 0.38, 1.7);
  }

  // ================================================================ LEGS
  for (const s of [1, -1] as const) {
    const side = s === 1 ? 'R' : 'L';
    const th = `thigh${side}` as BoneName;
    const sn = `shin${side}` as BoneName;
    const ft = `foot${side}` as BoneName;

    rock(th, 2, [0.3 * s, 0.2, 0], [3.5, 2.4, 3.5], { crack: 1.4 }, { amp: 0.18 });
    bundle(th, [0, 0, 0], [0, -1, 0], 3.3, 5.1, 2, { taper: 0.88, crack: 1.4 });
    rock(th, 1, [0.9 * s, -1.9, -0.2], [2.8, 3.0, 3.1], { crack: 1.5 }, { amp: 0.2, squarish: 0.2 });
    rock(th, 2, [0, -4.9, -1.2], [2.6, 2.2, 2.0], { crack: 1.3 }, { amp: 0.2 }); // knee cap

    collar(sn, [0, 0.2, 0], [2.4, 0.55, 2.4], 0.9);
    bundle(sn, [0, -0.1, 0], [0, -1, 0], 2.85, 5.1, 2, { taper: 0.78, crack: 1.4 });
    rock(sn, 1, [0, -1.5, 1.4], [2.4, 2.4, 2.0], { crack: 1.5 }, { amp: 0.2 }); // calf
    plate(sn, [0, -2.3, -2.25], [2.3, 3.8, 0.65], [-0.06, 0, 0], { crack: 1.5 }); // shin guard
    rock(sn, 1, [0, 0.0, 0], [2.7, 1.9, 2.7], { crack: 1.2 });
    rock(sn, 1, [0, -4.8, 0.6], [2.5, 1.0, 2.4]); // ankle

    // Foot: heavy, three thick toes with claws.
    collar(ft, [0, 0.1, 0], [2.1, 0.45, 2.1], 0.9);
    rock(ft, 1, [0, -0.05, 1.0], [2.5, 1.4, 2.3], { crack: 1.3 });
    plate(ft, [0, -0.85, -1.2], [4.7, 1.2, 5.0], [0.03, 0, 0], { crack: 1.2 }, 0.2);
    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * 1.6;
      rock(ft, 1, [x, -0.78, -3.7], [1.0, 0.8, 1.5], {}, { amp: 0.2 });
      claw(ft, [x, -0.9, -4.7], [-1.62, 0, 0], 0.5, 1.5);
    }
    rock(ft, 0, [2.2 * s, -0.8, -1.4], [0.9, 0.8, 1.4]);
    col(ft, [0, 0.0, 2.1], [1.0, 0, 0], 0.7, 1.7, {}, { tip: 0.5 }); // heel spur
  }

  // ================================================================ TAIL
  const tailR = [2.7, 2.2, 1.7, 1.2];
  const tailLen = [3.8, 3.5, 3.1, 3.0];
  const tailBones: BoneName[] = ['tail1', 'tail2', 'tail3', 'tail4'];
  tailBones.forEach((b, i) => {
    const r = tailR[i];
    const L = tailLen[i];
    rock(b, 1, [0, 0, L * 0.45], [r, r * 0.92, L * 0.68], { crack: 1.2 }, { amp: 0.16 });
    collar(b, [0, 0, 0.1], [r * 0.85, r * 0.8, 0.5], 0.85);
    col(b, [0, r * 0.7, L * 0.4], [0.5 + i * 0.05, 0, 0], r * 0.42, 1.9 + (3 - i) * 0.5, { crack: 1 });
    if (i < 3) {
      col(b, [r * 0.55, r * 0.35, L * 0.5], [0.4, 0, -0.9], r * 0.3, 1.5, {}, { tip: 0.4 });
      col(b, [-r * 0.55, r * 0.35, L * 0.5], [0.4, 0, 0.9], r * 0.3, 1.5, {}, { tip: 0.4 });
    }
  });
  // Tail club: a cluster of columns at the tip.
  bundle('tail4', [0, 0, 2.6], [0, 0.2, 1], 1.6, 2.6, 1, { taper: 0.5, crack: 1.5 });
  claw('tail4', [0, 0, 3.5], [Math.PI / 2 + 0.1, 0, 0], 0.6, 2.2, { lava: 0.0 });

  // ------------------------------------------------------------- meshes
  let triangles = 0;
  let meshes = 0;
  let chunks = 0;
  for (const n of names) {
    const mb = builders[n];
    if (mb.triangles === 0) continue;
    const geo = mb.build();
    const mesh = new THREE.Mesh(geo, material.material);
    mesh.name = `${n}-rock`;
    bones[n].add(mesh);
    triangles += mb.triangles;
    chunks += mb.count;
    meshes++;
  }

  return { root, bones, material, restWorld, stats: { triangles, meshes, chunks } };
}

export type { Chunk, PlaceOptions };
