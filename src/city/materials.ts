// Procedural TSL material library for the night town. Everything is metre
// scaled (bricks are 0.215 x 0.065 m) and driven from per-vertex attributes
// written by MeshBuilder, so a whole material class is ONE draw call.
//
// Vertex attribute conventions (uv is always in metres unless noted):
//   masonry (brick / stone / viaduct):
//     aA = (tintR, tintG, tintB, soot 0..1)
//     aB = (bayW, bayPhase, winW, sillH)  -- window rhythm, used for under-sill streaks
//     aC = (floorH, buildingH, seed 0..1, flags)
//   concrete: aA=(tint rgb, soot) aB=(panelW, panelPhase, _, _) aC=(floorH, bldH, seed, _)
//   curtain wall: aA=(seed, litProb, floorH, bayW) aB=(spandrelH, mullionW, phase, _)
//   windows (uv = 0..1 across the pane):
//     aA=(seed, kind, roomW, roomH) aB=(winW, winH, offX, offY) aC=(roomDepth, litProb, warmProb, _)
//     kind 0 terrace sash, 1 tower/office, 2 shop/large, 3 pub, 4 stained glass
//   paint / props: aA=(r,g,b,metalness) aB=(emissive r,g,b, roughness)
//   signs: uv = atlas uv, aB = (emissive intensity, flicker 0..1, seed, _)
//   slate roofs: uv = (metres along ridge, metres up slope), aC.z = seed
//
// Wetness and rain are live uniforms read from `config.weather` every frame.

import * as THREE from 'three/webgpu';
import {
  Fn, If, abs, attribute, bool, cameraPosition, cameraViewMatrix, clamp as _clamp, color, cos, cross, dFdx, dFdy, dot, exp, float,
  floor, fract, length, max as _max, min as _min, mix as _mix, mod as _mod, mx_fractal_noise_float, normalize, normalViewGeometry, normalWorldGeometry,
  oneMinus, positionView, positionWorld, pow as _pow, round, saturate, select as _select, sign, sin, smoothstep as _smoothstep, sqrt, step as _step, texture, time,
  transformDirection, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { config } from '../config';
import type { QualityPreset } from '../core/types';
import { rainRipples } from '../render/effects/rain-ripples';
import { createSignAtlas, type SignAtlas } from './signage';

// TSL nodes are loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

// Function-form TSL helpers don't all promote raw JS numbers; wrap them.
const nn = (v: N): N => (typeof v === 'number' ? float(v) : v);
const max = (a: N, b: N): N => _max(nn(a), nn(b));
const min = (a: N, b: N): N => _min(nn(a), nn(b));
const mod = (a: N, b: N): N => _mod(nn(a), nn(b));
const pow = (a: N, b: N): N => _pow(nn(a), nn(b));
const step = (a: N, b: N): N => _step(nn(a), nn(b));
const mix = (a: N, b: N, t: N): N => _mix(nn(a), nn(b), nn(t));
const clamp = (a: N, lo: N, hi: N): N => _clamp(nn(a), nn(lo), nn(hi));
const smoothstep = (a: N, b: N, x: N): N => _smoothstep(nn(a), nn(b), nn(x));
const select = (c: N, a: N, b: N): N => _select(c, nn(a), nn(b));

export interface RoadInfo {
  roadX: number[];
  roadZ: number[];
  roadWidth: number;
  /** Zebra crossings: `axis` is the direction the road runs; `at` is the position along it. */
  zebras: Array<{ axis: 'x' | 'z'; roadIndex: number; at: number }>;
  groundSize: number;
}

export interface CityMaterials {
  brick: THREE.MeshStandardNodeMaterial;
  sandstone: THREE.MeshStandardNodeMaterial;
  sootStone: THREE.MeshStandardNodeMaterial;
  viaductBrick: THREE.MeshStandardNodeMaterial;
  concrete: THREE.MeshStandardNodeMaterial;
  slate: THREE.MeshStandardNodeMaterial;
  curtain: THREE.MeshStandardNodeMaterial;
  windows: THREE.MeshStandardNodeMaterial;
  ground: THREE.MeshStandardNodeMaterial;
  pavement: THREE.MeshStandardNodeMaterial;
  plaza: THREE.MeshStandardNodeMaterial;
  water: THREE.MeshStandardNodeMaterial;
  paint: THREE.MeshStandardNodeMaterial;
  rust: THREE.MeshStandardNodeMaterial;
  signs: THREE.MeshStandardNodeMaterial;
  /** Live uniforms (updated each render from config.weather). */
  uniforms: { wetness: N; rain: N };
  atlas: SignAtlas;
  /** Lamp light-pool texture (400 m square, rgb = additive sodium / LED glow). Paint it with `paintLampPools`. */
  poolTexture: THREE.DataTexture;
  all: THREE.Material[];
}

// ------------------------------------------------------------------ shader helpers

const h21 = Fn(([p]: [N]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, vec3(p3.y, p3.z, p3.x).add(33.33)));
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

const fbm3 = (p: N): N => {
  const a = vnoise(p);
  const b = vnoise(p.mul(2.03).add(vec2(17.1, 3.7)));
  const c = vnoise(p.mul(4.11).add(vec2(5.3, 11.9)));
  return a.mul(0.55).add(b.mul(0.3)).add(c.mul(0.15));
};

/** Fade factor: 1 while the pattern period is well above the pixel footprint, 0 once it aliases. */
const fadeFor = (period: number, fp: N): N => oneMinus(smoothstep(0.22, 0.6, fp.div(period)));

/** Screen-space bump (Mikkelsen) from a height field in metres, in view space. */
const bumpNormal = (h: N, strength: N): N => {
  const dpdx = dFdx(positionView);
  const dpdy = dFdy(positionView);
  const n0 = normalViewGeometry;
  const r1 = cross(dpdy, n0);
  const r2 = cross(n0, dpdx);
  const det = dot(dpdx, r1);
  const grad = sign(det).mul(r1.mul(dFdx(h)).add(r2.mul(dFdy(h)))).mul(strength);
  return normalize(abs(det).mul(n0).sub(grad));
};

const c3 = (hex: number): N => color(hex);

// ------------------------------------------------------------------ factory

export function createCityMaterials(quality: QualityPreset, roads: RoadInfo): CityMaterials {
  const D = quality.materialDetail;
  const all: THREE.Material[] = [];

  // live uniforms
  const wetness = uniform(config.weather.wetness).onRenderUpdate(() => config.weather.wetness);
  const rain = uniform(config.weather.rain).onRenderUpdate(() => config.weather.rain);
  const wet: N = wetness;

  const A = attribute('aA', 'vec4');
  const B = attribute('aB', 'vec4');
  const C = attribute('aC', 'vec4');
  const uvm = uv();
  const fp: N = max(positionWorld.dFdx().length(), positionWorld.dFdy().length()).max(float(0.0005));

  const newMat = (): THREE.MeshStandardNodeMaterial => {
    const m = new THREE.MeshStandardNodeMaterial();
    all.push(m);
    return m;
  };

  // ------------------------------------------------------------ masonry
  interface MasonryOpts {
    courseH: number; brickL: number; mortarW: number;
    palette: [number, number, number, number];
    mortar: number;
    lenVar?: number; rowShift?: boolean;
    sootCol?: number; roughBase?: number; bump?: number; windowStreaks?: boolean; plinth?: boolean;
    patchiness?: number;
  }

  const masonry = (o: MasonryOpts): { colorNode: N; roughNode: N; normalNode: N | null } => {
    const u = uvm.x;
    const v = uvm.y;
    const seed = C.z;
    const row = floor(v.div(o.courseH));
    const lenRow = o.lenVar ? h11(row.add(seed.mul(53.0))).mul(o.lenVar).add(1.0 - o.lenVar * 0.5) : float(1.0);
    const L = lenRow.mul(o.brickL);
    const bu = u.div(L).add(o.rowShift === false ? 0 : mod(row, 2.0).mul(0.5)).add(seed.mul(13.7));
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
    let albedo: N = mix(avg, bc, fine);
    albedo = mix(albedo, c3(o.mortar), mortarM);
    albedo = albedo.mul(A.xyz);

    // large-scale variation that survives distance
    const patch1 = vnoise(vec2(u, v).mul(0.27).add(seed.mul(40.0)));
    const patch2 = vnoise(vec2(u, v).mul(1.3).add(seed.mul(9.0))).mul(fadeFor(0.7, fp));
    albedo = albedo.mul(patch1.mul(o.patchiness ?? 0.34).add(0.85)).mul(patch2.mul(0.18).add(0.91));

    let soil: N = float(0.0);
    let wetStreak: N = float(0.0);
    const bldH = C.y;
    if (D >= 1) {
      const sn = vnoise(vec2(u.mul(3.1).add(seed.mul(77.0)), v.mul(0.16)));
      const streaks = smoothstep(0.42, 0.85, sn);
      const topDark = smoothstep(0.0, 1.0, v.div(bldH.max(float(1.0)))).mul(0.65).add(0.15);
      soil = A.w.mul(streaks.mul(0.7).add(0.25)).mul(topDark);
      // gutter / cornice run-off at the roofline
      const gutter = smoothstep(bldH.sub(2.2), bldH, v).mul(streaks.mul(0.6).add(0.35));
      soil = soil.add(gutter.mul(0.45));
      if (o.windowStreaks !== false) {
        const dxw = abs(fract(u.sub(B.y).div(B.x.max(float(0.5))).add(0.5)).sub(0.5)).mul(B.x);
        const inWin = oneMinus(smoothstep(B.z.mul(0.5), B.z.mul(0.5).add(0.35), dxw));
        const fh = C.x.max(float(1.0));
        const fyy = v.sub(floor(v.div(fh)).mul(fh));
        const under = oneMinus(smoothstep(0.0, 1.2, B.w.sub(fyy))).mul(step(fyy, B.w.add(0.02)));
        const sn2 = vnoise(vec2(u.mul(11.0), v.mul(0.6)).add(seed.mul(5.0)));
        soil = soil.add(inWin.mul(under).mul(sn2.mul(0.6).add(0.4)).mul(0.55));
      }
      wetStreak = smoothstep(0.55, 0.8, vnoise(vec2(u.mul(4.3).add(seed.mul(9.0)), v.mul(0.09))));
    }
    soil = clamp(soil, 0.0, 0.88);
    albedo = mix(albedo, albedo.mul(c3(o.sootCol ?? 0x2e2b2a)).mul(1.4), soil);

    // damp wall base + overall rain darkening
    const damp = oneMinus(smoothstep(0.0, 1.5, v));
    albedo = albedo.mul(mix(1.0, 0.72, wet.mul(0.7))).mul(mix(1.0, 0.6, damp.mul(wet)));
    if (o.plinth) {
      const pl = oneMinus(smoothstep(0.62, 0.68, v));
      albedo = mix(albedo, c3(0x1d2230).mul(vnoise(vec2(u, v).mul(1.1)).mul(0.5).add(0.7)), pl.mul(0.9));
    }

    const rough = mix(float(o.roughBase ?? 0.9), float(0.5), wet.mul(wetStreak.mul(0.45).add(0.3)).add(damp.mul(wet).mul(0.25)).clamp(float(0.0), float(0.9)))
      .add(mortarM.mul(0.05));

    let normalNode: N | null = null;
    if (D >= 2) {
      const relief = h1.sub(0.5).mul(0.0035).add(mortarM.mul(-(o.bump ?? 0.006)));
      normalNode = bumpNormal(relief.mul(fine), float(1.0));
    }
    return { colorNode: albedo, roughNode: rough, normalNode };
  };

  const applyMasonry = (m: THREE.MeshStandardNodeMaterial, o: MasonryOpts): void => {
    const r = masonry(o);
    m.colorNode = r.colorNode;
    m.roughnessNode = r.roughNode;
    m.metalness = 0;
    if (r.normalNode) m.normalNode = r.normalNode;
  };

  const brick = newMat();
  applyMasonry(brick, {
    courseH: 0.075, brickL: 0.225, mortarW: 0.012,
    palette: [0x7c2f22, 0x5a2b22, 0x1f1614, 0xa8502c], mortar: 0x6e675d, plinth: true, patchiness: 0.4,
  });

  const viaductBrick = newMat();
  applyMasonry(viaductBrick, {
    courseH: 0.075, brickL: 0.225, mortarW: 0.012,
    palette: [0x4c2b25, 0x35211e, 0x15100f, 0x6a3a2a], mortar: 0x4a463f, windowStreaks: false, sootCol: 0x1c1a19,
  });

  const sandstone = newMat();
  applyMasonry(sandstone, {
    courseH: 0.36, brickL: 0.85, mortarW: 0.014, lenVar: 0.55,
    palette: [0xa48860, 0x8a7352, 0x4a4036, 0xb89d70], mortar: 0x6d6556, sootCol: 0x151312, roughBase: 0.85, bump: 0.01, patchiness: 0.5,
  });

  const sootStone = newMat();
  applyMasonry(sootStone, {
    courseH: 0.3, brickL: 0.7, mortarW: 0.014, lenVar: 0.5,
    palette: [0x5c564b, 0x474239, 0x2a2622, 0x6b6253], mortar: 0x3d382f, sootCol: 0x0f0e0d, roughBase: 0.9, bump: 0.01, patchiness: 0.55,
  });

  // ------------------------------------------------------------ concrete panels (tower blocks)
  const concrete = newMat();
  {
    const u = uvm.x;
    const v = uvm.y;
    const seed = C.z;
    const panelW = B.x.max(float(1.0));
    const pu = u.sub(B.y).div(panelW);
    const pi = floor(pu);
    const fh = C.x.max(float(1.0));
    const fi = floor(v.div(fh));
    const pcol = h21(vec2(pi.add(seed.mul(17.0)), fi));
    // distance to nearest seam (m)
    const dU = min(fract(pu), oneMinus(fract(pu))).mul(panelW);
    const dV = min(fract(v.div(fh)), oneMinus(fract(v.div(fh)))).mul(fh);
    const seamD = min(dU, dV);
    const aa = fp.mul(0.8).add(0.002);
    const seam = oneMinus(smoothstep(0.008, aa.max(float(0.012)).add(0.008), seamD));
    const fineSeam = mix(float(0.05), seam, fadeFor(0.5, fp).max(float(0.35)));
    let base: N = mix(c3(0x8a8a84), c3(0xa09e96), pcol).mul(A.xyz).mul(0.55);
    // board-marked fine horizontal lines
    const board = sin(v.mul(Math.PI / 0.12)).mul(0.5).add(0.5).mul(fadeFor(0.12, fp));
    base = base.mul(float(1.0).sub(board.mul(0.07)));
    // aggregate
    const agg = vnoise(vec2(u, v).mul(45.0)).mul(fadeFor(0.02, fp));
    base = base.mul(agg.mul(0.12).add(0.94));
    // water staining: long vertical streaks, heavier under horizontal seams
    const stain = smoothstep(0.4, 0.85, vnoise(vec2(u.mul(5.2).add(seed.mul(30.0)), v.mul(0.07))));
    const belowSeam = oneMinus(smoothstep(0.0, 0.7, fract(v.div(fh)).mul(fh))).mul(0.5);
    const topSoot = smoothstep(0.0, 1.0, v.div(C.y.max(float(1.0)))).mul(0.5).add(0.2);
    const soil = clamp(stain.mul(0.45).mul(topSoot).add(belowSeam.mul(stain)).add(A.w.mul(0.25)), 0.0, 0.8);
    base = mix(base, base.mul(c3(0x2b2a29)).mul(1.5), soil);
    base = mix(base, c3(0x1a1b1d), fineSeam.mul(0.8));
    const damp = oneMinus(smoothstep(0.0, 1.6, v));
    base = base.mul(mix(1.0, 0.7, wet.mul(0.6))).mul(mix(1.0, 0.6, damp.mul(wet)));
    concrete.colorNode = base;
    concrete.roughnessNode = mix(float(0.92), float(0.55), wet.mul(stain.mul(0.4).add(0.35)).add(damp.mul(wet).mul(0.2)).clamp(float(0.0), float(0.85)));
    concrete.metalness = 0;
    if (D >= 2) {
      const relief = seam.mul(-0.005).add(board.mul(0.0006)).add(agg.mul(0.0006));
      concrete.normalNode = bumpNormal(relief.mul(fadeFor(0.5, fp).max(float(0.2))), float(1.0));
    }
  }

  // ------------------------------------------------------------ slate roofs
  const slate = newMat();
  {
    const u = uvm.x;
    const v = uvm.y;
    const seed = C.z;
    const courseH = 0.24;
    const row = floor(v.div(courseH));
    const wRow = h11(row.add(seed.mul(19.0))).mul(0.12).add(0.26);
    const bu = u.div(wRow).add(mod(row, 2.0).mul(0.5)).add(h11(row.mul(3.1)).mul(5.0));
    const col = floor(bu);
    const fx = fract(bu);
    const fy = fract(v.div(courseH));
    const cell = vec2(col.add(seed.mul(7.0)), row);
    const h1 = h21(cell);
    const h2 = h21(cell.add(vec2(3.3, 9.9)));
    const fine = fadeFor(courseH, fp);
    let sc: N = mix(c3(0x2a2f3a), c3(0x4b5260), h1);
    sc = mix(sc, c3(0x3a4640), smoothstep(0.82, 0.95, h2).mul(0.7));
    sc = mix(sc, c3(0x47404f), smoothstep(0.9, 1.0, h1.mul(h2).mul(1.6)).mul(0.6));
    const avg = c3(0x383e4a);
    const shade = smoothstep(0.0, 0.85, fy).mul(0.5).add(0.55);
    const jointX = oneMinus(smoothstep(0.0015, fp.mul(0.7).add(0.006), min(fx, oneMinus(fx)).mul(wRow)));
    let albedo: N = mix(avg, sc.mul(shade), fine);
    albedo = mix(albedo, c3(0x101216), jointX.mul(0.6).mul(fine));
    const patch = vnoise(vec2(u, v).mul(0.45).add(seed.mul(31.0)));
    const moss = smoothstep(0.62, 0.85, vnoise(vec2(u, v).mul(0.9).add(seed.mul(12.0))));
    albedo = albedo.mul(patch.mul(0.5).add(0.75));
    albedo = mix(albedo, c3(0x2c3a26), moss.mul(0.3));
    albedo = albedo.mul(mix(1.0, 0.65, wet.mul(0.7)));
    slate.colorNode = albedo;
    const lowEdge = oneMinus(smoothstep(0.0, 0.06, fy)).mul(fine);
    slate.roughnessNode = mix(float(0.82), float(0.3), wet.mul(h1.mul(0.5).add(0.5))).sub(lowEdge.mul(wet).mul(0.15)).clamp(float(0.15), float(1.0));
    slate.metalness = 0.05;
    if (D >= 2) {
      const relief = fy.mul(0.004).add(jointX.mul(-0.003)).add(h1.mul(0.0016));
      slate.normalNode = bumpNormal(relief.mul(fine), float(1.0));
    }
  }

  // ------------------------------------------------------------ glass curtain wall (offices)
  const curtain = newMat();
  {
    const u = uvm.x;
    const v = uvm.y;
    const seed = A.x;
    const floorH = A.z.max(float(1.0));
    const bayW = A.w.max(float(0.5));
    const spandrelH = B.x;
    const mw = B.y;
    const fl = floor(v.div(floorH));
    const fy = v.sub(fl.mul(floorH));
    const bu = u.sub(B.z).div(bayW);
    const fxm = fract(bu).mul(bayW);
    const dMull = min(fxm, bayW.sub(fxm));
    const mull = oneMinus(smoothstep(mw.mul(0.5), mw.mul(0.5).add(fp.mul(0.9).add(0.004)), dMull));
    const transom = oneMinus(smoothstep(0.035, fp.mul(0.9).add(0.004).add(0.035), abs(fy.sub(floorH).add(0.04)).min(abs(fy.sub(spandrelH)))));
    const inSpandrel = oneMinus(smoothstep(spandrelH.sub(0.02), spandrelH.add(0.02), fy));
    const frameM = clamp(mull.add(transom).add(inSpandrel), 0.0, 1.0);
    const fineF = fadeFor(0.8, fp);
    const frameAvg = mix(float(0.0), float(1.0), float(0.28));
    const fm = mix(frameAvg.mul(0.5), frameM, fineF.max(float(0.25)));

    // lit floors: whole bands in patches, with cool fluorescent light
    const fh = h21(vec2(fl, seed.mul(91.0)));
    const patchN = vnoise(vec2(u.div(11.0).add(seed.mul(33.0)), fl.mul(0.7)));
    const litFloor = step(fh, A.y).mul(smoothstep(0.32, 0.4, patchN));
    const lobby = oneMinus(step(0.5, fl));
    const lit = max(litFloor, lobby.mul(0.9));
    const ceilStrip = smoothstep(0.35, 0.55, sin(u.mul(Math.PI * 2 / 1.8)).mul(0.5).add(0.5));
    const interior = float(0.35).add(smoothstep(0.0, floorH, fy).mul(0.9)).add(ceilStrip.mul(smoothstep(floorH.mul(0.8), floorH, fy)).mul(1.8));
    const cool = mix(c3(0x7fa8e0), c3(0xffd8a0), step(0.82, h21(vec2(fl.add(5.0), seed))));
    const glassMask = oneMinus(fm);
    const litEmit: N = cool.mul(interior).mul(lit).mul(glassMask).mul(0.6);

    // glass: dark blue, metallic + smooth so env map / SSR reflect the street
    const tone = vnoise(vec2(u.mul(0.4), v.mul(0.25)).add(seed.mul(17.0)));
    const glassCol = mix(c3(0x0a1622), c3(0x14283a), tone);
    const spandrelCol = c3(0x0c1118);
    const frameCol = c3(0x1b1e22);
    let colr: N = mix(glassCol, mix(spandrelCol, frameCol, step(0.001, mull.add(transom))), frameM);
    // fake sky/skyline sheen so the glass reads even with no env map
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const nd = saturate(dot(viewDir, normalWorldGeometry));
    const fres = pow(oneMinus(nd), 4.0);
    const sky = mix(c3(0x1a2740), c3(0x4a3a50), smoothstep(0.0, 60.0, v)).mul(fres.mul(0.9).add(0.04));
    curtain.emissiveNode = litEmit.add(sky.mul(glassMask).mul(0.7));
    colr = colr.mul(mix(1.0, 0.8, wet.mul(0.4)));
    curtain.colorNode = colr;
    curtain.metalnessNode = mix(float(0.78), float(0.3), frameM);
    curtain.roughnessNode = mix(float(0.1), float(0.45), frameM).add(tone.mul(0.05));
  }

  // ------------------------------------------------------------ windows (lit interiors)
  const windows = newMat();
  {
    const seed = A.x;
    const kind = A.y;
    const winW = B.x;
    const winH = B.y;
    const litP = C.y;
    const warmP = C.z;
    const px = uvm.x.mul(winW);
    const py = uvm.y.mul(winH);
    const fd = min(min(px, winW.sub(px)), min(py, winH.sub(py)));
    const frameW = mix(float(0.07), float(0.05), step(0.5, kind)).add(select(kind.greaterThan(3.5), float(0.1), float(0.0)));
    const isFrameBase = oneMinus(smoothstep(frameW, frameW.add(fp.mul(0.9).add(0.003)), fd));
    // glazing bars: sash meeting rail + one vertical bar (terraces, pubs); a centre mullion on towers
    const barT = float(0.016);
    const fineBars = oneMinus(smoothstep(0.04, 0.14, fp));
    const rail = oneMinus(smoothstep(barT, barT.add(fp.mul(0.9).add(0.002)), abs(py.sub(winH.mul(0.5)))));
    const vbar = oneMinus(smoothstep(barT, barT.add(fp.mul(0.9).add(0.002)), abs(px.sub(winW.mul(0.5)))));
    const isTower = step(0.5, kind).mul(oneMinus(step(1.5, kind)));
    const sash = oneMinus(step(0.5, kind)).max(step(2.5, kind).mul(oneMinus(step(3.5, kind))));
    const bars = max(rail.mul(sash).max(vbar.mul(sash.max(isTower))), float(0.0)).mul(fineBars);
    const isFrame = clamp(isFrameBase.add(bars), 0.0, 1.0);

    const warmChoice = step(h11(seed.mul(41.0).add(3.0)), warmP);
    const litHash = h11(seed.mul(97.0).add(1.0));
    const lit = step(litHash, litP);
    const tv = step(0.9, h11(seed.mul(13.0).add(7.0))).mul(lit);
    const flick = float(0.55).add(sin(time.mul(7.0).add(seed.mul(60.0))).mul(sin(time.mul(3.1).add(seed.mul(13.0)))).mul(0.3))
      .add(vnoise(vec2(time.mul(9.0), seed.mul(30.0))).mul(0.35));
    const warmCol = mix(c3(0xffa347), c3(0xffcf8a), h11(seed.mul(5.0)));
    const coolCol = mix(c3(0xc4e0ff), c3(0xf0f7ff), h11(seed.mul(8.0)));
    const tvCol = c3(0x5a7dff).mul(flick);
    let lightCol: N = mix(coolCol, warmCol, warmChoice);
    lightCol = mix(lightCol, tvCol, tv);
    // pubs / shops glow warmer and stronger
    lightCol = mix(lightCol, c3(0xff9a3a).mul(1.25), step(2.5, kind).mul(oneMinus(step(3.5, kind))));

    const glassDark = mix(c3(0x05080c), c3(0x0c1620), uvm.y);
    const frameCol = mix(
      mix(c3(0xb9b4a4), c3(0x16191c), step(0.5, kind)),
      mix(c3(0x2b1a10), c3(0x4a4a46), step(3.5, kind)), step(2.5, kind),
    ).mul(0.6);

    if (D >= 2) {
      const sh = vec2(0.0, 1.0);
      void sh;
      // --- interior mapping
      const roomW = A.z;
      const roomH = A.w;
      const offX = B.z;
      const offY = B.w;
      const roomD = C.x;
      const Nw = normalWorldGeometry;
      const T = normalize(cross(vec3(0, 1, 0), Nw));
      const V = positionWorld.sub(cameraPosition);
      const vx0 = dot(V, T);
      const vy0 = V.y;
      const vz0 = dot(V, Nw).negate();
      const vx = select(abs(vx0).lessThan(0.0001), float(0.0001), vx0);
      const vy = select(abs(vy0).lessThan(0.0001), float(0.0001), vy0);
      const vz = max(vz0, 0.02);
      const x0 = offX.add(uvm.x.mul(winW));
      const y0 = offY.add(uvm.y.mul(winH));
      const tx = select(vx.greaterThan(0.0), roomW.sub(x0), x0.negate()).div(vx);
      const ty = select(vy.greaterThan(0.0), roomH.sub(y0), y0.negate()).div(vy);
      const tz = roomD.div(vz);
      const t = min(min(tx, ty), tz);
      const hit = vec3(x0, y0, 0.0).add(vec3(vx, vy, vz).mul(t));
      const isBack = step(tz, min(tx, ty));
      const isSide = oneMinus(isBack).mul(step(tx, ty));
      const isFlat = oneMinus(isBack).mul(oneMinus(isSide));
      const isCeil = isFlat.mul(step(0.0, vy));

      const lampPos = vec3(roomW.mul(0.5), roomH.sub(0.35), roomD.mul(0.45));
      const dl = length(hit.sub(lampPos));
      const irr = float(1.7).div(dl.mul(dl).mul(0.32).add(0.55));
      const wallHue = mix(
        mix(c3(0xd9c8a0), c3(0x9fbfa0), h11(seed.mul(3.0))),
        mix(c3(0xd9a0a0), c3(0xa0b4d9), h11(seed.mul(4.0))), step(0.5, h11(seed.mul(6.0))),
      );
      const floorCol = mix(c3(0x3a2a20), c3(0x6a5a48), h11(seed.mul(2.0))).mul(0.8);
      const bu = hit.x.div(roomW);
      const bv = hit.y.div(roomH);
      // furnishing on the back wall: sofa / cabinet, picture, TV
      const sofa = step(0.08, bu).mul(step(bu, 0.55)).mul(step(bv, 0.3)).mul(step(0.5, h11(seed.mul(21.0))));
      const pic = step(0.55, bu).mul(step(bu, 0.8)).mul(step(0.5, bv)).mul(step(bv, 0.78)).mul(step(0.45, h11(seed.mul(27.0))));
      const tvBox = step(0.6, bu).mul(step(bu, 0.92)).mul(step(0.18, bv)).mul(step(bv, 0.45));
      let albedoBack: N = wallHue;
      albedoBack = mix(albedoBack, c3(0x2a1f1c), sofa.mul(0.9));
      albedoBack = mix(albedoBack, mix(c3(0x7a3a2a), c3(0x2a5a7a), h11(seed.mul(31.0))), pic.mul(0.9));
      const surfAlbedo = mix(mix(wallHue.mul(0.8), floorCol, isFlat.mul(oneMinus(isCeil))), c3(0xe8e0d0), isCeil);
      const surf = mix(surfAlbedo, albedoBack, isBack);
      let radiance: N = surf.mul(irr);
      // lampshade glow on the ceiling
      const lampGlow = oneMinus(smoothstep(0.1, 0.4, length(vec2(hit.x.sub(lampPos.x), hit.z.sub(lampPos.z))))).mul(isCeil);
      radiance = radiance.add(vec3(1.6, 1.4, 1.1).mul(lampGlow));
      // TV screen
      radiance = radiance.add(isBack.mul(tvBox).mul(tv).mul(vec3(0.6, 0.9, 1.6)).mul(flick.mul(1.5)));
      radiance = radiance.mul(lightCol.mul(0.9).add(0.15));

      // --- curtains / blinds / nets in the glass plane
      const ct = h11(seed.mul(61.0).add(2.0));
      const cu = uvm.x;
      const cv = uvm.y;
      const fabricCol = mix(
        mix(c3(0xd8c9a8), c3(0x8a2a22), step(0.25, h11(seed.mul(71.0)))),
        mix(c3(0x4a6a90), c3(0x587a48), step(0.6, h11(seed.mul(72.0)))), step(0.5, h11(seed.mul(73.0))),
      );
      const folds = sin(cu.mul(winW).mul(38.0).add(seed.mul(9.0))).mul(0.18).add(0.86);
      const closedC = oneMinus(step(0.2, ct));
      const sideW = h11(seed.mul(81.0)).mul(0.12).add(0.14);
      const sidesC = step(0.2, ct).mul(oneMinus(step(0.5, ct))).mul(step(oneMinus(sideW), abs(cu.sub(0.5)).mul(2.0).sub(0.0)).max(float(0.0)));
      const sideEdge = smoothstep(sideW.mul(-0.5).add(0.5), 0.5, abs(cu.sub(0.5)));
      const sidesCov = step(0.2, ct).mul(oneMinus(step(0.5, ct))).mul(sideEdge);
      void sidesC;
      const drop = h11(seed.mul(91.0)).mul(0.55).add(0.2);
      const slats = step(0.5, fract(cv.mul(winH).div(0.035)));
      const blindC = step(0.5, ct).mul(oneMinus(step(0.66, ct))).mul(step(oneMinus(drop), cv)).mul(slats.mul(0.35).add(0.65));
      const netC = step(0.66, ct).mul(oneMinus(step(0.8, ct))).mul(step(cv, 0.62)).mul(0.5);
      const cover = clamp(closedC.add(sidesCov).add(blindC).add(netC), 0.0, 1.0);
      const fabricRad = mix(fabricCol, c3(0xe9e3d6), step(0.66, ct)).mul(folds).mul(lightCol).mul(0.9);
      radiance = mix(radiance, fabricRad, cover);

      const litRad = radiance.mul(lit);
      // unlit rooms: a faint hint of dark interior, bluish
      const idleRad = mix(vec3(0.004, 0.006, 0.01), vec3(0.01, 0.014, 0.022), bv.clamp(float(0.0), float(1.0)).mul(isBack));
      const sheen = mix(c3(0x0a1420), c3(0x1c2638), oneMinus(uvm.y)).mul(0.16);
      let interiorOut: N = mix(idleRad, litRad, lit).add(sheen.mul(oneMinus(lit)));

      // --- stained glass (church): lead-lined lattice, saturated jewel colours
      const sgU = uvm.x.mul(5.0).add(uvm.y.mul(winH).mul(0.45));
      const sgV = uvm.x.mul(5.0).sub(uvm.y.mul(winH).mul(0.45));
      const cellId = vec2(floor(sgU), floor(sgV));
      const band = floor(uvm.y.mul(4.0));
      const hh = h21(cellId.add(vec2(band.mul(3.7), seed.mul(20.0))));
      const jewel = mix(
        mix(c3(0xd01818), c3(0x1840d8), step(0.25, hh)),
        mix(c3(0x20a050), c3(0xf0a818), step(0.75, hh)), step(0.5, hh),
      );
      const lead = smoothstep(0.0, 0.06, min(min(fract(sgU), oneMinus(fract(sgU))), min(fract(sgV), oneMinus(fract(sgV)))));
      const pane = jewel.mul(h21(cellId.add(3.1)).mul(0.5).add(0.8)).mul(lead).mul(mix(1.1, 0.6, uvm.y.mul(0.5)));
      const isStained = step(3.5, kind);
      interiorOut = mix(interiorOut, pane.mul(1.5), isStained);
      const isLitWin = max(lit, isStained);

      const glassMask = oneMinus(isFrame);
      windows.emissiveNode = interiorOut.mul(glassMask).mul(float(2.6)).mul(mix(float(1.0), float(1.0), isLitWin));
      windows.colorNode = mix(glassDark, frameCol, isFrame);
      windows.roughnessNode = mix(float(0.05), float(0.55), isFrame);
      windows.metalnessNode = float(0.0);
    } else {
      // cheap: gradient glow, curtain stripes, no depth
      const stripes = step(0.5, fract(uvm.x.mul(winW).mul(2.2).add(seed.mul(9.0)))).mul(0.25).add(0.75);
      const grad = mix(float(1.3), float(0.55), uvm.y);
      const isStained = step(3.5, kind);
      const jewel = mix(c3(0xc02020), c3(0x2040d0), step(0.5, h11(floor(uvm.x.mul(4.0)).add(seed.mul(9.0)))));
      const glow = mix(lightCol.mul(grad).mul(stripes).mul(lit), jewel.mul(1.4), isStained);
      windows.emissiveNode = glow.mul(oneMinus(isFrame)).mul(2.4);
      windows.colorNode = mix(glassDark, frameCol, isFrame);
      windows.roughnessNode = mix(float(0.1), float(0.55), isFrame);
      windows.metalnessNode = float(0.0);
    }
  }

  // ------------------------------------------------------------ lamp light pools (baked, additive)
  const POOL_RES = 1024;
  const poolData = new Uint8Array(POOL_RES * POOL_RES * 4);
  const poolTexture = new THREE.DataTexture(poolData, POOL_RES, POOL_RES, THREE.RGBAFormat);
  poolTexture.minFilter = THREE.LinearFilter;
  poolTexture.magFilter = THREE.LinearFilter;
  poolTexture.generateMipmaps = false;
  poolTexture.colorSpace = THREE.NoColorSpace;
  poolTexture.needsUpdate = true;
  const gs = roads.groundSize;
  const poolUV = vec2(positionWorld.x.add(gs / 2).div(gs), positionWorld.z.add(gs / 2).div(gs));
  const pool: N = texture(poolTexture, poolUV).rgb;

  // ------------------------------------------------------------ ground (tarmac, markings, puddles)
  const ground = newMat();
  {
    const x = positionWorld.x;
    const z = positionWorld.z;
    const p2 = vec2(x, z);
    const hw = roads.roadWidth / 2;
    const rX0 = roads.roadX[0];
    const rZ0 = roads.roadZ[0];
    const spX = roads.roadX[1] - roads.roadX[0];
    const spZ = roads.roadZ[1] - roads.roadZ[0];
    const nX = roads.roadX.length;
    const nZ = roads.roadZ.length;
    const idxX = clamp(round(x.sub(rX0).div(spX)), 0.0, nX - 1);
    const idxZ = clamp(round(z.sub(rZ0).div(spZ)), 0.0, nZ - 1);
    const dx = x.sub(idxX.mul(spX).add(rX0)); // across a z-running road
    const dz = z.sub(idxZ.mul(spZ).add(rZ0)); // across an x-running road
    const inZ = oneMinus(step(hw + 0.35, abs(dx))); // z-running carriageway
    const inX = oneMinus(step(hw + 0.35, abs(dz)));
    const road = max(inZ, inX);
    const inter = inZ.mul(inX);
    const zOnly = inZ.mul(oneMinus(inX));
    const xOnly = inX.mul(oneMinus(inZ));
    // across / junction distance for whichever carriageway we're on
    const across = select(zOnly.greaterThan(0.5), dx, select(xOnly.greaterThan(0.5), dz, float(0.0)));
    const along = select(zOnly.greaterThan(0.5), z, x);
    const jd = select(zOnly.greaterThan(0.5), abs(dz), abs(dx));
    const jsign = select(zOnly.greaterThan(0.5), sign(dz), sign(dx));
    const aAbs = abs(across);
    const central = max(step(0.5, idxX).mul(step(idxX, 2.5)), step(0.5, idxZ).mul(step(idxZ, 2.5)));
    void central;

    // --- tarmac
    const agg = vnoise(p2.mul(38.0)).mul(fadeFor(0.03, fp));
    const patches = fbm3(p2.mul(0.09));
    let tar: N = mix(c3(0x1d1f23), c3(0x303337), vnoise(p2.mul(1.7))).mul(patches.mul(0.5).add(0.75));
    tar = tar.mul(agg.mul(0.35).add(0.85));
    // wheel tracks: lanes at +-2.5, tracks at +-0.9 either side of the lane centre
    const laneC = abs(aAbs.sub(2.5));
    const trackMask = oneMinus(smoothstep(0.15, 0.5, abs(laneC.sub(0.9)))).mul(oneMinus(inter)).mul(road);
    tar = tar.mul(mix(1.0, 0.78, trackMask.mul(vnoise(vec2(along.mul(0.4), across.mul(3.0))).mul(0.6).add(0.4))));

    // --- markings (white paint, double yellow)
    const wear = smoothstep(0.18, 0.45, vnoise(p2.mul(5.5)).add(0.12));
    const dashOn = step(fract(along.div(6.0)), 0.5);
    const centre = oneMinus(step(0.08, abs(across))).mul(dashOn).mul(step(7.0, jd));
    const yellowAny = max(
      step(4.45, aAbs).mul(oneMinus(step(4.57, aAbs))),
      step(4.68, aAbs).mul(oneMinus(step(4.8, aAbs))),
    ).mul(step(5.9, jd));
    const isCentralRoad = select(zOnly.greaterThan(0.5), step(0.5, idxX).mul(step(idxX, 2.5)), step(0.5, idxZ).mul(step(idxZ, 2.5)));
    const yellow = yellowAny.mul(isCentralRoad);
    const edgeWhite = oneMinus(step(0.1, abs(aAbs.sub(4.55)))).mul(oneMinus(isCentralRoad)).mul(step(5.9, jd)).mul(dashOn);
    // stop lines: on the approach lane (drive on the left)
    const laneSide = sign(across);
    const prod = laneSide.mul(jsign);
    const onApproach = select(zOnly.greaterThan(0.5), step(prod, -0.5), step(0.5, prod));
    const stopOn = step(5.65, jd).mul(oneMinus(step(6.05, jd))).mul(onApproach);
    const stopLine = stopOn.mul(step(0.3, aAbs)).mul(oneMinus(step(4.6, aAbs)));
    let paint: N = max(max(centre, edgeWhite), stopLine);
    // zebra crossings
    for (const zb of roads.zebras) {
      if (zb.axis === 'x') {
        const cz = roads.roadZ[zb.roadIndex];
        const inBox = oneMinus(step(2.0, abs(x.sub(zb.at)))).mul(oneMinus(step(4.85, abs(z.sub(cz)))));
        const stripe = step(fract(z.sub(cz).div(1.1).add(0.27)), 0.52);
        paint = max(paint, inBox.mul(stripe));
        // give-way studs / kerb-side white lines either side of the crossing
        const sideLines = oneMinus(step(0.12, abs(abs(x.sub(zb.at)).sub(2.55)))).mul(oneMinus(step(4.85, abs(z.sub(cz)))));
        paint = max(paint, sideLines.mul(step(0.5, dashOn)));
      } else {
        const cx = roads.roadX[zb.roadIndex];
        const inBox = oneMinus(step(2.0, abs(z.sub(zb.at)))).mul(oneMinus(step(4.85, abs(x.sub(cx)))));
        const stripe = step(fract(x.sub(cx).div(1.1).add(0.27)), 0.52);
        paint = max(paint, inBox.mul(stripe));
      }
    }
    const paintAmt = paint.mul(wear).mul(road);
    const yellowAmt = yellow.mul(wear).mul(road);

    // --- manholes + gullies
    const mhCell = floor(p2.div(26.0));
    const mhH = h21(mhCell);
    const mhC = vec2(h21(mhCell.add(3.0)), h21(mhCell.add(9.0))).mul(14.0).add(6.0);
    const mhD = length(fract(p2.div(26.0)).mul(26.0).sub(mhC));
    const manhole = oneMinus(smoothstep(0.42, 0.46, mhD)).mul(step(0.55, mhH)).mul(road).mul(oneMinus(paint));
    const manRing = smoothstep(0.38, 0.42, mhD).mul(oneMinus(smoothstep(0.42, 0.47, mhD))).mul(step(0.55, mhH)).mul(road);
    const gulleyAlong = fract(along.div(15.0).add(0.37)).mul(15.0);
    const gulley = oneMinus(step(0.28, abs(gulleyAlong.sub(7.5)))).mul(step(4.55, aAbs)).mul(oneMinus(step(5.15, aAbs))).mul(road).mul(oneMinus(inter));

    // --- puddles
    const thr = mix(float(0.82), float(0.58), wet);
    const pn = fbm3(p2.mul(0.13).add(vec2(7.3, 2.1))).add(smoothstep(3.2, 4.9, aAbs).mul(0.1)).add(vnoise(p2.mul(0.7)).mul(0.04));
    const puddleRaw = smoothstep(thr, thr.add(0.045), pn);
    const puddle: N = puddleRaw.mul(road).mul(oneMinus(paintAmt.mul(0.6))).mul(oneMinus(gulley));
    const dampZone = smoothstep(thr.sub(0.2), thr, pn);

    // --- wasteland (outside the road network and its slabs)
    const wasteN = vnoise(p2.mul(2.5)).mul(0.5).add(vnoise(p2.mul(0.2)).mul(0.5));
    const waste = mix(c3(0x1b1e16), c3(0x2b2c22), wasteN).mul(agg.mul(0.3).add(0.85));

    let albedo: N = mix(waste, tar, road);
    albedo = mix(albedo, c3(0x0a0b0d), manhole.mul(0.9));
    albedo = mix(albedo, c3(0x3a3a3c), manRing.mul(0.6));
    albedo = mix(albedo, c3(0x050506), gulley.mul(0.9));
    albedo = mix(albedo, c3(0xb5b8b0).mul(0.9), paintAmt);
    albedo = mix(albedo, c3(0xc89a0a).mul(0.85), yellowAmt);
    albedo = albedo.mul(mix(1.0, 0.8, wet.mul(0.5))).mul(mix(1.0, 0.6, puddle));
    ground.colorNode = albedo;

    // roughness: dry-ish asphalt -> damp -> puddle mirror
    let rough: N = mix(float(0.88), float(0.46), wet);
    rough = mix(rough, float(0.34), dampZone.mul(wet).mul(0.7));
    rough = rough.add(agg.mul(0.1));
    rough = mix(rough, float(0.5), paintAmt.mul(0.9));
    rough = mix(rough, float(0.55), manhole.mul(0.8));
    rough = mix(rough, float(0.2), puddle.mul(wet.mul(0.6).add(0.4)));
    rough = mix(rough, float(0.78), oneMinus(road));
    ground.roughnessNode = rough;
    ground.metalnessNode = manhole.mul(0.7);

    // --- normals: aggregate micro-bump, ripples in puddles
    let nrm: N;
    if (D >= 2) {
      const relief = vnoise(p2.mul(55.0)).mul(0.0016).mul(fadeFor(0.02, fp)).mul(oneMinus(puddle)).add(vnoise(p2.mul(6.0)).mul(0.004).mul(oneMinus(puddle)));
      const bumpN = bumpNormal(relief, float(1.0));
      const rr: N = rainRipples(p2, rain);
      const rippleWorld = normalize(vec3(rr.x, rr.z, rr.y.negate()));
      const rippleView = transformDirection(rippleWorld, cameraViewMatrix);
      nrm = normalize(mix(bumpN, rippleView, puddle.mul(0.9)));
      ground.normalNode = nrm;
    }

    // --- fake reflections for when SSR isn't running: sky sheen and lamp pools
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const nd = saturate(viewDir.y);
    const fres = float(0.03).add(pow(oneMinus(nd), 5.0).mul(0.97));
    const skyRefl = vec3(0.05, 0.07, 0.12).mul(fres).mul(puddle.mul(0.8).add(dampZone.mul(wet).mul(0.2)));
    const poolLit = pool.mul(albedo).mul(2.6).mul(oneMinus(puddle.mul(0.5)));
    const poolMirror = pool.mul(pool).mul(2.8).mul(puddle.mul(wet).add(dampZone.mul(wet).mul(0.18)));
    ground.emissiveNode = skyRefl.add(poolLit).add(poolMirror).mul(road.mul(0.85).add(0.15));
  }

  // ------------------------------------------------------------ pavement flagstones + kerbs
  const makePavement = (cobbles: boolean): THREE.MeshStandardNodeMaterial => {
    const m = newMat();
    const x = positionWorld.x;
    const z = positionWorld.z;
    const p2 = vec2(x, z);
    const isTop = step(0.5, normalWorldGeometry.y);

    let topAlbedo: N;
    let topRough: N;
    let topRelief: N = float(0.0);
    let puddle: N = float(0.0);
    const large = fbm3(p2.mul(0.35));
    if (!cobbles) {
      const rowH = 0.6;
      const row = floor(z.div(rowH));
      const colW = 0.9;
      const bu = x.div(colW).add(h11(row.mul(1.7)).mul(3.0));
      const col = floor(bu);
      const fx = fract(bu);
      const fy = fract(z.div(rowH));
      const edgeD = min(min(fx, oneMinus(fx)).mul(colW), min(fy, oneMinus(fy)).mul(rowH));
      const fine = fadeFor(0.6, fp);
      const joint = oneMinus(smoothstep(0.004, fp.mul(0.8).add(0.011), edgeD));
      const jointM = mix(float(0.06), joint, fine);
      const hc = h21(vec2(col, row));
      const hc2 = h21(vec2(col.add(4.0), row.add(2.0)));
      let fc: N = mix(c3(0x77777a), c3(0x9a9690), hc);
      fc = mix(fc, c3(0x5c5c60), step(0.86, hc2).mul(0.8));
      fc = mix(mix(fc.mul(0.6), fc, 0.0).mul(1.0), fc, 1.0);
      const avgC = c3(0x80807e);
      topAlbedo = mix(avgC.mul(0.55), fc.mul(0.55), fine);
      topAlbedo = mix(topAlbedo, c3(0x1a1a1c), jointM.mul(0.85));
      topAlbedo = topAlbedo.mul(large.mul(0.45).add(0.8)).mul(vnoise(p2.mul(30.0)).mul(fadeFor(0.03, fp)).mul(0.25).add(0.9));
      topAlbedo = topAlbedo.mul(mix(1.0, 0.65, wet.mul(0.8)));
      const thr = mix(float(0.9), float(0.74), wet);
      const pn = fbm3(p2.mul(0.5).add(vec2(2.2, 8.1))).add(hc.mul(0.12));
      puddle = smoothstep(thr, thr.add(0.05), pn).mul(0.7);
      topRough = mix(float(0.85), float(0.32), wet.mul(hc2.mul(0.4).add(0.5))).add(joint.mul(0.1));
      topRelief = joint.mul(-0.006).add(hc.mul(0.002));
      topRelief = topRelief.mul(fine);
    } else {
      // setts: coursed granite blocks 0.11 x 0.15 m
      const rowH = 0.12;
      const row = floor(z.div(rowH));
      const L = 0.17;
      const bu = x.div(L).add(h11(row.mul(2.3)).mul(7.0)).add(mod(row, 2.0).mul(0.5));
      const col = floor(bu);
      const fx = fract(bu);
      const fy = fract(z.div(rowH));
      const edgeD = min(min(fx, oneMinus(fx)).mul(L), min(fy, oneMinus(fy)).mul(rowH));
      const fine = fadeFor(rowH, fp);
      const joint = oneMinus(smoothstep(0.008, fp.mul(0.8).add(0.02), edgeD));
      const hc = h21(vec2(col, row));
      const hc2 = h21(vec2(col.add(9.0), row.add(5.0)));
      let sc: N = mix(c3(0x5a5a5e), c3(0x7e7a74), hc);
      sc = mix(sc, c3(0x5a5058), step(0.8, hc2).mul(0.7));
      sc = mix(sc, c3(0x474f58), step(0.9, hc).mul(0.6));
      topAlbedo = mix(c3(0x58585a).mul(1.0), sc.mul(1.0), fine);
      topAlbedo = mix(topAlbedo, c3(0x151517), mix(float(0.18), joint, fine).mul(0.9));
      topAlbedo = topAlbedo.mul(large.mul(0.5).add(0.75));
      topAlbedo = topAlbedo.mul(mix(1.0, 0.62, wet.mul(0.85)));
      // settled hollows hold water: wide, shallow puddles that break up around stones
      const thr = mix(float(0.84), float(0.6), wet);
      const pn = fbm3(p2.mul(0.22).add(vec2(5.5, 1.2))).add(hc.mul(0.1));
      puddle = smoothstep(thr, thr.add(0.05), pn).mul(0.9);
      topRough = mix(float(0.8), float(0.28), wet.mul(hc2.mul(0.5).add(0.5)));
      topRelief = joint.mul(-0.012).add(hc.mul(0.01)).mul(fine);
    }

    // kerb / slab side: granite
    const sideN = vnoise(vec2(x.add(z), positionWorld.y.mul(30.0)).mul(3.0));
    const kerb: N = mix(c3(0x6a6a6c), c3(0x8a8a88), sideN).mul(mix(1.0, 0.7, wet.mul(0.6))).mul(0.7);
    const kerbDirt = smoothstep(0.1, 0.0, positionWorld.y.sub(0.15).abs()).mul(0.0);
    void kerbDirt;
    const aSide = mix(kerb, topAlbedo, isTop);
    m.colorNode = mix(aSide, aSide.mul(0.35), puddle.mul(isTop));
    m.roughnessNode = mix(mix(float(0.55), topRough, isTop), float(0.16), puddle.mul(isTop).mul(wet.mul(0.5).add(0.5)));
    m.metalnessNode = float(0.0);
    if (D >= 2) {
      const bumpN = bumpNormal(topRelief.mul(oneMinus(puddle)).mul(isTop), float(1.0));
      const rr: N = rainRipples(p2, rain);
      const rippleView = transformDirection(normalize(vec3(rr.x, rr.z, rr.y.negate())), cameraViewMatrix);
      m.normalNode = normalize(mix(bumpN, rippleView, puddle.mul(isTop).mul(0.9)));
    }
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fres = float(0.03).add(pow(oneMinus(saturate(viewDir.y)), 5.0).mul(0.97));
    const skyRefl = vec3(0.07, 0.1, 0.17).mul(fres).mul(puddle.mul(1.4).add(wet.mul(0.06)));
    const poolLit = pool.mul(m.colorNode).mul(2.6).mul(isTop);
    const poolMirror = pool.mul(pool).mul(2.2).mul(puddle.mul(wet).add(wet.mul(0.05))).mul(isTop);
    m.emissiveNode = skyRefl.mul(isTop).add(poolLit).add(poolMirror);
    return m;
  };
  const pavement = makePavement(false);
  const plaza = makePavement(true);

  // ------------------------------------------------------------ canal water
  const water = newMat();
  {
    const p2 = vec2(positionWorld.x, positionWorld.z);
    const flow = vec2(time.mul(0.15), time.mul(0.02));
    const swell = fbm3(p2.mul(0.35).add(flow));
    const swell2 = vnoise(p2.mul(2.2).sub(flow.mul(3.0)));
    water.colorNode = mix(c3(0x061214), c3(0x0b2325), swell).mul(0.6);
    water.roughnessNode = float(0.05).add(swell2.mul(0.03));
    water.metalnessNode = float(0.0);
    const rr: N = rainRipples(p2, rain);
    const rippleWorld = normalize(vec3(rr.x.add(swell.sub(0.5).mul(0.15)), rr.z, rr.y.negate().add(swell2.sub(0.5).mul(0.1))));
    water.normalNode = transformDirection(rippleWorld, cameraViewMatrix);
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fres = float(0.03).add(pow(oneMinus(saturate(viewDir.y)), 5.0).mul(0.97));
    water.emissiveNode = vec3(0.06, 0.09, 0.14).mul(fres).mul(1.8).add(pool.mul(0.4));
  }

  // ------------------------------------------------------------ painted metal / props (per-vertex colour)
  const paint = newMat();
  {
    const x = positionWorld.x;
    const z = positionWorld.z;
    const y = positionWorld.y;
    const grime = vnoise(vec2(x.add(z), y).mul(3.0)).mul(0.25).add(0.8);
    const dirtBase = oneMinus(smoothstep(0.0, 1.2, y)).mul(0.35);
    paint.colorNode = A.xyz.mul(grime).mul(oneMinus(dirtBase)).mul(mix(1.0, 0.8, wet.mul(0.5)));
    paint.metalnessNode = A.w;
    paint.roughnessNode = mix(B.w, B.w.mul(0.55), wet.mul(0.6)).max(float(0.08));
    paint.emissiveNode = B.xyz;
  }

  // ------------------------------------------------------------ rusted gasholder steel
  const rust = newMat();
  {
    const u = uvm.x;
    const v = uvm.y;
    const seed = C.z;
    const plateU = fract(u.div(2.4));
    const plateV = fract(v.div(1.2));
    const edge = min(min(plateU, oneMinus(plateU)).mul(2.4), min(plateV, oneMinus(plateV)).mul(1.2));
    const seam = oneMinus(smoothstep(0.012, fp.mul(0.9).add(0.03), edge));
    const rivets = oneMinus(smoothstep(0.012, fp.mul(0.8).add(0.022), length(vec2(fract(u.div(0.3)).sub(0.5), fract(v.div(0.3)).sub(0.5)).mul(0.3)))).mul(oneMinus(step(0.18, edge)).mul(step(0.05, edge))).mul(fadeFor(0.3, fp));
    const base = mix(c3(0x2c3a33), c3(0x3e4a42), vnoise(vec2(u, v).mul(0.6).add(seed.mul(9.0))));
    const rustN = fbm3(vec2(u, v).mul(0.9).add(seed.mul(20.0)));
    const rustStreak = smoothstep(0.35, 0.8, vnoise(vec2(u.mul(2.2), v.mul(0.12)).add(seed.mul(5.0))));
    const rustAmt = clamp(smoothstep(0.5, 0.72, rustN).mul(0.8).add(rustStreak.mul(0.35)).add(A.w), 0.0, 1.0);
    const rustCol = mix(c3(0x5a2a12), c3(0x8a4a1c), vnoise(vec2(u, v).mul(8.0)));
    let albedo: N = mix(base, rustCol, rustAmt);
    albedo = mix(albedo, c3(0x0a0b0b), seam.mul(0.8).add(rivets.mul(0.3)));
    albedo = albedo.mul(mix(1.0, 0.75, wet.mul(0.5)));
    rust.colorNode = albedo;
    rust.roughnessNode = mix(float(0.45), float(0.9), rustAmt).mul(mix(1.0, 0.8, wet.mul(0.5)));
    rust.metalnessNode = mix(float(0.6), float(0.1), rustAmt);
    if (D >= 2) rust.normalNode = bumpNormal(seam.mul(-0.006).add(rivets.mul(0.004)).mul(fadeFor(0.3, fp)), float(1.0));
  }

  // ------------------------------------------------------------ signs (emissive atlas)
  const atlas = createSignAtlas();
  const signs = newMat();
  {
    const tex = texture(atlas.texture, uvm).rgb;
    const inten = B.x;
    const fl = B.y;
    const sd = B.z;
    const flick = oneMinus(step(0.94, h11(floor(time.mul(7.0)).add(sd.mul(100.0)))).mul(fl));
    signs.colorNode = tex.mul(0.12).add(0.015);
    signs.emissiveNode = tex.mul(inten).mul(flick);
    signs.roughnessNode = float(0.35);
    signs.metalnessNode = float(0.0);
  }

  void exp; void cos; void bool; void sqrt; void If; void vec4; void mx_fractal_noise_float;
  void normalViewGeometry; void min;

  return {
    brick, sandstone, sootStone, viaductBrick, concrete, slate, curtain, windows, ground, pavement, plaza, water, paint, rust, signs,
    uniforms: { wetness, rain }, atlas, poolTexture, all,
  };
}

/**
 * Bake lamp light pools into the 400 m ground-light texture.
 * `weight` lets lamps that already have a real PointLight contribute less.
 */
export function paintLampPools(
  tex: THREE.DataTexture,
  groundSize: number,
  lamps: Array<{ x: number; z: number; color: [number, number, number]; weight: number; radius: number }>,
): void {
  const res = tex.image.width;
  const data = tex.image.data as unknown as Uint8Array;
  const acc = new Float32Array(res * res * 3);
  const m = res / groundSize;
  for (const l of lamps) {
    const cx = (l.x + groundSize / 2) * m;
    const cz = (l.z + groundSize / 2) * m;
    const r = l.radius * m;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(res - 1, Math.ceil(cx + r));
    const z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(res - 1, Math.ceil(cz + r));
    for (let zz = z0; zz <= z1; zz++) {
      for (let xx = x0; xx <= x1; xx++) {
        const d = Math.hypot(xx + 0.5 - cx, zz + 0.5 - cz) / r;
        if (d >= 1) continue;
        // soft pool: bright core, long skirt
        const f = (1 - d * d) * (1 - d * d) * l.weight / (1 + 6 * d * d);
        const i = (zz * res + xx) * 3;
        acc[i] += l.color[0] * f;
        acc[i + 1] += l.color[1] * f;
        acc[i + 2] += l.color[2] * f;
      }
    }
  }
  for (let i = 0, j = 0; i < res * res; i++, j += 3) {
    data[i * 4] = Math.min(255, acc[j] * 255);
    data[i * 4 + 1] = Math.min(255, acc[j + 1] * 255);
    data[i * 4 + 2] = Math.min(255, acc[j + 2] * 255);
    data[i * 4 + 3] = 255;
  }
  tex.needsUpdate = true;
}
