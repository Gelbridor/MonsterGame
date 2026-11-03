// Materials for moving destruction pieces and shards.
//
// The town's own materials (src/city/materials.ts) texture from world-space
// metre uvs, which would swim on a moving piece. These are the same looks
// (brick, concrete, sandstone, glass with lit / unlit panes, slate, steel,
// wood) re-expressed in PIECE-LOCAL space: every vertex carries
//   plocal  vec3  piece-local position in metres (plus a per-piece offset)
//   pn      vec4  xyz = piece-local face normal (picks the projection axis),
//                 w   = face kind + piece seed: floor(w) is 0 for an outer face
//                 (the piece's surface look) and 1 for a fracture face (raw
//                 broken core); fract(w) is a 0..0.99 piece seed
// so the pattern sticks to the piece however it tumbles, and a piece and its
// shards share one continuous surface.
//
// Per-handle tint and damage come from the BatchedMesh colour (rgb tint is
// applied by the engine, alpha = damage 0..1) in 'batch' mode, or from the
// per-vertex `rtint` attribute in 'static' mode (baked rubble).
//
// Duplication note: the palettes and the vnoise / hash helpers are copied from
// src/city/materials.ts (which is not exported and not ours to edit).

import * as THREE from 'three/webgpu';
import {
  Fn, abs, attribute, color, float, floor, fract, max as _max, min as _min, mix as _mix, mod as _mod, mx_fractal_noise_float,
  oneMinus, select as _select, sin, smoothstep as _smoothstep, vec2, vec3,
} from 'three/tsl';
import { batchColor } from 'three/tsl';
import type { QualityPreset } from '../core/types';
import type { DMaterial, PieceKind } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export type Look = 'brick' | 'concrete' | 'stone' | 'glass' | 'steel' | 'wood' | 'slate';
export const LOOKS: readonly Look[] = ['brick', 'concrete', 'stone', 'glass', 'steel', 'wood', 'slate'];

/** Which look a piece draws with. Roofs use the slate look whatever their stored material. */
export function lookFor(material: DMaterial, kind: PieceKind): Look {
  if (kind === 'roof' && material !== 'steel' && material !== 'glass') return 'slate';
  return material;
}

const nn = (v: N): N => (typeof v === 'number' ? float(v) : v);
const max = (a: N, b: N): N => _max(nn(a), nn(b));
const min = (a: N, b: N): N => _min(nn(a), nn(b));
const mix = (a: N, b: N, t: N): N => _mix(nn(a), nn(b), nn(t));
const smoothstep = (a: N, b: N, x: N): N => _smoothstep(nn(a), nn(b), nn(x));
const select = (c: N, a: N, b: N): N => _select(c, nn(a), nn(b));
const mod = (a: N, b: N): N => _mod(nn(a), nn(b));
const c3 = (hex: number): N => color(hex);

const h21 = Fn(([p]: [N]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(p3.dot(vec3(p3.y, p3.z, p3.x).add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});
const h11 = (x: N): N => {
  const f = float(x);
  return h21(vec2(f, f.mul(0.6180339).add(7.13)));
};
const vnoise = Fn(([p]: [N]) => {
  const i = floor(p);
  const f = fract(p);
  const u: N = f.mul(f).mul(f.mul(-2.0).add(3.0));
  const a = h21(i);
  const b = h21(i.add(vec2(1, 0)));
  const c = h21(i.add(vec2(0, 1)));
  const d = h21(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});
const fadeFor = (period: number, fp: N): N => oneMinus(smoothstep(0.22, 0.6, fp.div(period)));

export type MaterialMode = 'batch' | 'static';

export function createPieceMaterials(quality: QualityPreset, mode: MaterialMode): Record<Look, THREE.MeshStandardNodeMaterial> {
  const D = quality.materialDetail;
  const P: N = attribute('plocal', 'vec3');
  const PN: N = attribute('pn', 'vec4');
  const faceKind: N = floor(PN.w.add(0.001));
  const seed: N = PN.w.sub(faceKind);
  const inner: N = faceKind.greaterThan(0.5);
  const tint: N = mode === 'batch' ? batchColor : attribute('rtint', 'vec4');
  const damage: N = tint.a;

  // Axis-picked 2D face coordinates (outer faces are axis aligned boxes).
  const an: N = abs(PN.xyz);
  const isY: N = an.y.greaterThan(max(an.x, an.z));
  const isX: N = an.x.greaterThan(an.z);
  const u: N = select(isY, P.x, select(isX, P.z, P.x));
  const v: N = select(isY, P.z, P.y);
  // Footprint of one pixel in metres, to fade patterns that would alias.
  const fp: N = max(P.dFdx().length(), P.dFdy().length()).max(float(0.0005));

  const rawNoise = (f: number): N => mx_fractal_noise_float(P.mul(f), 3, 2.0, 0.5).mul(0.5).add(0.5);

  /** Dark crack lines that grow with damage. */
  const cracks = (): N => {
    const q = vec2(u, v);
    const n1 = vnoise(q.mul(4.0).add(seed.mul(50.0))).sub(0.5).abs();
    const n2 = vnoise(q.mul(9.0).add(seed.mul(20.0)).add(vec2(7.7, 1.3))).sub(0.5).abs();
    const line = oneMinus(smoothstep(0.0, 0.035, min(n1, n2.mul(1.6))));
    return line.mul(smoothstep(0.18, 0.6, damage)).mul(fadeFor(0.1, fp).max(float(0.5)));
  };

  const finish = (m: THREE.MeshStandardNodeMaterial, albedo: N, rough: N, metal: N, emissive?: N): void => {
    let a: N = albedo;
    // overall soot / wear with damage
    a = a.mul(oneMinus(damage.mul(0.28)));
    if (D >= 1) a = mix(a, a.mul(0.18), cracks().mul(0.85));
    m.colorNode = mode === 'static' ? a.mul(tint.rgb) : a;
    m.roughnessNode = rough;
    m.metalnessNode = metal;
    if (emissive) m.emissiveNode = emissive;
  };

  const mk = (): THREE.MeshStandardNodeMaterial => new THREE.MeshStandardNodeMaterial();
  const out = {} as Record<Look, THREE.MeshStandardNodeMaterial>;

  // ---------------------------------------------------------- masonry (brick, stone)
  const masonry = (
    m: THREE.MeshStandardNodeMaterial,
    o: { courseH: number; brickL: number; mortarW: number; palette: number[]; mortar: number; lenVar?: number; rough: number; core: number[]; coreFleck: number },
  ): void => {
    const row = floor(v.div(o.courseH));
    const lenRow = o.lenVar ? h11(row.add(seed.mul(53.0))).mul(o.lenVar).add(1.0 - o.lenVar * 0.5) : float(1.0);
    const L = lenRow.mul(o.brickL);
    const bu = u.div(L).add(mod(row, 2.0).mul(0.5)).add(seed.mul(13.7));
    const col = floor(bu);
    const fx = fract(bu);
    const fy = fract(v.div(o.courseH));
    const edge = min(min(fx, oneMinus(fx)).mul(L), min(fy, oneMinus(fy)).mul(o.courseH));
    const aa = fp.mul(0.75).add(0.0012);
    const mortarRaw = oneMinus(smoothstep(aa.negate().add(o.mortarW * 0.5), aa.add(o.mortarW * 0.5), edge));
    const fine = fadeFor(o.courseH, fp);
    const mortarAvg = (o.mortarW * (o.brickL + o.courseH)) / (o.brickL * o.courseH);
    const mortarM = mix(float(mortarAvg), mortarRaw, fine);
    const cell = vec2(col.add(seed.mul(31.0)), row);
    const h1 = h21(cell);
    const h2 = h21(cell.add(vec2(11.7, 3.1)));
    const h3 = h21(cell.add(vec2(5.3, 19.4)));
    const pal = o.palette.map(c3);
    const avg = mix(pal[0], pal[1], 0.5).mul(0.9);
    let bc = mix(pal[0], pal[1], h1);
    bc = mix(bc, pal[2], smoothstep(0.7, 0.92, h2).mul(0.85));
    bc = mix(bc, pal[3], smoothstep(0.78, 0.95, h3).mul(0.75));
    bc = bc.mul(h1.mul(0.4).add(0.8));
    let outer: N = mix(avg, bc, fine);
    outer = mix(outer, c3(o.mortar), mortarM);
    const patch = vnoise(vec2(u, v).mul(0.27).add(seed.mul(40.0)));
    outer = outer.mul(patch.mul(0.35).add(0.85));

    // raw core: crumbly body with mortar / grit flecks
    const n = rawNoise(o.coreFleck);
    const fleck = smoothstep(0.62, 0.7, rawNoise(o.coreFleck * 2.7));
    let core: N = mix(c3(o.core[0]), c3(o.core[1]), n);
    core = mix(core, c3(o.core[2]), fleck.mul(0.7));
    core = core.mul(rawNoise(o.coreFleck * 7.0).mul(0.3).add(0.85));

    finish(m, select(inner, core, outer), select(inner, float(o.rough + 0.07), float(o.rough).add(mortarM.mul(0.05))), float(0));
  };

  out.brick = mk();
  masonry(out.brick, {
    courseH: 0.075, brickL: 0.225, mortarW: 0.012, palette: [0x7c2f22, 0x5a2b22, 0x1f1614, 0xa8502c], mortar: 0x6e675d,
    rough: 0.88, core: [0x8c4a30, 0x6a4034, 0x8a8478], coreFleck: 38,
  });
  out.stone = mk();
  masonry(out.stone, {
    courseH: 0.36, brickL: 0.85, mortarW: 0.014, lenVar: 0.55, palette: [0xa48860, 0x8a7352, 0x4a4036, 0xb89d70], mortar: 0x6d6556,
    rough: 0.85, core: [0xc7b48c, 0xa7966f, 0x786d58], coreFleck: 30,
  });

  // ---------------------------------------------------------- concrete
  out.concrete = mk();
  {
    const panelW = 2.4;
    const pu = u.add(seed.mul(9.0)).div(panelW);
    const fh = 3.0;
    const dU = min(fract(pu), oneMinus(fract(pu))).mul(panelW);
    const dV = min(fract(v.div(fh)), oneMinus(fract(v.div(fh)))).mul(fh);
    const seamD = min(dU, dV);
    const aa = fp.mul(0.8).add(0.002);
    const seam = oneMinus(smoothstep(0.008, aa.max(float(0.012)).add(0.008), seamD));
    const pcol = h21(vec2(floor(pu), floor(v.div(fh)).add(seed.mul(17.0))));
    let base: N = mix(c3(0x8a8a84), c3(0xa09e96), pcol).mul(0.55);
    base = base.mul(float(1.0).sub(sin(v.mul(Math.PI / 0.12)).mul(0.5).add(0.5).mul(fadeFor(0.12, fp)).mul(0.07)));
    base = base.mul(vnoise(vec2(u, v).mul(45.0)).mul(fadeFor(0.02, fp)).mul(0.12).add(0.94));
    const stain = smoothstep(0.4, 0.85, vnoise(vec2(u.mul(5.2).add(seed.mul(30.0)), v.mul(0.5))));
    base = mix(base, base.mul(0.55), stain.mul(0.45));
    const outer = mix(base, base.mul(0.35), seam.mul(mix(float(0.5), float(1.0), fadeFor(0.5, fp))));
    // raw core: pale cement with aggregate
    const agg = smoothstep(0.58, 0.66, rawNoise(60.0));
    const dark = smoothstep(0.6, 0.68, rawNoise(36.0).mul(0.8).add(0.1));
    let core: N = mix(c3(0xb9b6ac), c3(0x9c9a92), rawNoise(14.0));
    core = mix(core, c3(0x66625a), dark.mul(0.55));
    core = mix(core, c3(0xd4cfc2), agg.mul(0.5));
    finish(out.concrete, select(inner, core, outer), select(inner, 0.95, 0.92), float(0));
  }

  // ---------------------------------------------------------- slate roof
  out.slate = mk();
  {
    const courseH = 0.24;
    const row = floor(v.div(courseH));
    const wRow = h11(row.add(seed.mul(19.0))).mul(0.12).add(0.26);
    const bu = u.div(wRow).add(mod(row, 2.0).mul(0.5)).add(h11(row.mul(3.1)).mul(5.0));
    const fx = fract(bu);
    const fy = fract(v.div(courseH));
    const cell = vec2(floor(bu).add(seed.mul(7.0)), row);
    const h1 = h21(cell);
    const h2 = h21(cell.add(vec2(3.3, 9.9)));
    const fine = fadeFor(courseH, fp);
    let sc: N = mix(c3(0x2a2f3a), c3(0x4b5260), h1);
    sc = mix(sc, c3(0x3a4640), smoothstep(0.82, 0.95, h2).mul(0.7));
    const shade = smoothstep(0.0, 0.85, fy).mul(0.5).add(0.55);
    const jointX = oneMinus(smoothstep(0.0015, fp.mul(0.7).add(0.006), min(fx, oneMinus(fx)).mul(wRow)));
    let outer: N = mix(c3(0x383e4a), sc.mul(shade), fine);
    outer = mix(outer, c3(0x101216), jointX.mul(0.6).mul(fine));
    outer = outer.mul(vnoise(vec2(u, v).mul(0.45).add(seed.mul(31.0))).mul(0.5).add(0.75));
    const core: N = mix(c3(0x2c3038), c3(0x4a4f5a), rawNoise(26.0)).mul(rawNoise(70.0).mul(0.3).add(0.85));
    finish(out.slate, select(inner, core, outer), select(inner, 0.8, 0.82), float(0.05));
  }

  // ---------------------------------------------------------- steel
  out.steel = mk();
  {
    const brushed = vnoise(vec2(u.mul(2.0), v.mul(60.0)).add(seed.mul(20.0)));
    const rust = smoothstep(0.55, 0.8, vnoise(vec2(u, v).mul(1.7).add(seed.mul(40.0))));
    let outer: N = mix(c3(0x596069), c3(0x7b828b), brushed.mul(0.5)).mul(brushed.mul(0.18).add(0.88));
    outer = mix(outer, c3(0x6a3a22), rust.mul(0.45));
    const core: N = mix(c3(0xaab0b8), c3(0x7d838b), rawNoise(50.0));
    finish(out.steel, select(inner, core, outer), select(inner, 0.28, mix(float(0.45), float(0.75), rust)), select(inner, 0.95, mix(float(0.85), float(0.2), rust)));
  }

  // ---------------------------------------------------------- wood
  out.wood = mk();
  {
    const plank = floor(u.div(0.18).add(seed.mul(30.0)));
    const grain = sin(v.mul(31.0).add(h11(plank).mul(40.0)).add(vnoise(vec2(u.mul(3.0), v.mul(2.0))).mul(6.0))).mul(0.5).add(0.5);
    const gap = oneMinus(smoothstep(0.003, 0.009, min(fract(u.div(0.18).add(seed.mul(30.0))), oneMinus(fract(u.div(0.18).add(seed.mul(30.0))))).mul(0.18)));
    let outer: N = mix(c3(0x5a3d26), c3(0x7a5535), h11(plank.add(3.0))).mul(grain.mul(0.25).add(0.82));
    outer = mix(outer, outer.mul(0.3), gap);
    const core: N = mix(c3(0xc8a779), c3(0x9c7c52), rawNoise(34.0));
    finish(out.wood, select(inner, core, outer), float(0.82), float(0));
  }

  // ---------------------------------------------------------- glass (lit / unlit panes)
  out.glass = mk();
  {
    const lit = smoothstep(0.52, 0.56, seed.mul(1.01));
    const warm = h11(seed.mul(91.0));
    const lampColor = mix(c3(0xffb866), c3(0xcfe6ff), smoothstep(0.6, 0.9, warm));
    const room = vnoise(vec2(u, v).mul(1.6).add(seed.mul(30.0)));
    // pane: dark sky-reflecting glass, a soft glow when lit, thin frame at the border
    const sky = mix(c3(0x0b1220), c3(0x1b2c42), smoothstep(0.0, 1.0, vnoise(vec2(u, v).mul(0.6).add(seed.mul(5.0)))));
    const outer: N = sky.mul(0.9);
    const core: N = mix(c3(0x9ec3bd), c3(0xd9f0ec), rawNoise(22.0));
    const glow = lampColor.mul(room.mul(0.6).add(0.55)).mul(lit).mul(2.2);
    finish(
      out.glass, select(inner, core, outer), select(inner, 0.22, 0.06), float(0),
      select(inner, vec3(0.0), glow),
    );
  }

  return out;
}
