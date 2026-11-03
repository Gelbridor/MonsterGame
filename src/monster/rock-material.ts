// Basalt's material: wet, vesicular, blue-black basalt with a network of glowing
// lava cracks. One node material covers rock, cracks, eyes, mouth and joint glow
// (so each bone is a single draw call); per-vertex attributes from basalt-geom
// say which parts are rock and which are molten:
//
//   aRest  rest-pose position: the domain for every noise, so patterns are glued
//          to the body (and continuous across bones) while the bones move
//   aEdge  distance to the nearest face edge -> worn, lighter edges
//   aMat   x molten amount, y crack density, z tint, w per-chunk random
//
// Works on WebGPU and the WebGL 2 fallback (no storage buffers, no textures).
// materialDetail: 2 = full (bump, vesicles, rivulets, clearcoat wet sheen),
// 1 = albedo noise + a single crack layer, 0 = flat colours + plain emissive.

import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  clamp,
  dot,
  float,
  floor,
  fract,
  max,
  min,
  mix,
  mx_noise_float,
  normalLocal,
  normalWorld,
  normalView,
  normalize,
  positionViewDirection,
  pow,
  saturate,
  sin,
  smoothstep,
  sqrt,
  time,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { QualityPreset } from '../core/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface BasaltMaterialHandle {
  material: THREE.MeshStandardNodeMaterial;
  /** Global lava brightness multiplier (breathing / heartbeat / running heat), ~1. */
  pulse: { value: number };
  /** Extra heat 0..1 (run, roar): widens cracks and brightens them. */
  heat: { value: number };
  /** Rain wetness 0..1. */
  wet: { value: number };
}

// ------------------------------------------------------------------ noise

/** vec3 -> vec3 in [0,1): cheap sine hash (fine at the small coordinates used here). */
const hash33 = (p: N): N => {
  const q = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(q).mul(43758.5453123));
};

/**
 * 3D Voronoi: returns vec2(F1, F2) distances in cell units.
 * full = 3x3x3 neighbourhood (exact), else 2x2x2 (cheaper, slightly artefacty).
 */
const voronoi = (p: N, full: boolean): N => {
  const base = full ? floor(p) : floor(p.sub(0.5));
  const f = p.sub(base);
  let f1: N = float(8);
  let f2: N = float(8);
  const lo = full ? -1 : 0;
  const hi = full ? 1 : 1;
  for (let k = lo; k <= hi; k++) {
    for (let j = lo; j <= hi; j++) {
      for (let i = lo; i <= hi; i++) {
        const o = vec3(i, j, k);
        const r = o.add(hash33(base.add(o)).mul(0.86)).sub(f);
        const d = dot(r, r);
        f2 = min(f2, max(f1, d));
        f1 = min(f1, d);
      }
    }
  }
  return vec2(sqrt(f1), sqrt(f2));
};

const fbm2 = (p: N): N => mx_noise_float(p).mul(0.62).add(mx_noise_float(p.mul(2.13).add(17.3)).mul(0.38));

// ------------------------------------------------------------------ material

export function createBasaltMaterial(quality: QualityPreset): BasaltMaterialHandle {
  const detail = quality.materialDetail;
  const pulse = uniform(1);
  const heat = uniform(0);
  const wet = uniform(0);

  const aRest: N = attribute('aRest', 'vec3');
  const aEdge: N = attribute('aEdge', 'vec4');
  const aMat: N = attribute('aMat', 'vec4');

  const molten = aMat.x;
  const crackDensity = aMat.y;
  const tint = aMat.z;
  const rnd = aMat.w;

  const edgeDist = min(min(aEdge.x, aEdge.y), min(aEdge.z, aEdge.w));

  let material: THREE.MeshStandardNodeMaterial;

  if (detail === 0) {
    // ---- flat colours: tinted rock, plain orange emissive on molten parts
    material = new THREE.MeshStandardNodeMaterial();
    material.roughness = 0.9;
    material.metalness = 0;
    material.colorNode = vec3(0.075, 0.08, 0.095).mul(tint.mul(1.1));
    material.emissiveNode = vec3(1.0, 0.36, 0.06).mul(smoothstep(0.2, 0.6, molten)).mul(pulse.mul(2.2));
    return { material, pulse, heat, wet };
  }

  const useBump = detail >= 2;
  material = detail >= 2 ? new THREE.MeshPhysicalNodeMaterial() : new THREE.MeshStandardNodeMaterial();
  const wetEff = wet; // uniform 0..1

  // ---- lava crack field ------------------------------------------------
  // Two scales: big plates (~3.4 m) whose borders are the main cracks, and a
  // finer network (~1.1 m) that only shows in "hot zones" (joints, chest).
  const p = aRest;
  const zoneNoise = fbm2(p.mul(0.085).add(vec3(3.1, 7.7, 1.3))); // -1..1 big blobs: where cracks are dense
  const widthNoise = fbm2(p.mul(0.23).add(vec3(11.3, 2.2, 5.9))); // varies width along a crack
  const vA = voronoi(p.mul(1 / 3.4).add(vec3(0.0, 0.0, 0.0)), detail >= 2);
  const edgeA = vA.y.sub(vA.x); // ~0 on borders, grows into the cell interior

  const zone = smoothstep(0.0, 0.75, zoneNoise.add(crackDensity.sub(1).mul(0.55))); // 0..1: where the big cracks open
  const hot = saturate(zone.mul(crackDensity.mul(0.8)).add(heat.mul(0.3)));
  // Crack half-width in F2-F1 cell units: thin hairlines most places, fat in hot zones.
  const wA = mix(0.006, 0.075, widthNoise.mul(0.5).add(0.5).mul(hot)).add(heat.mul(0.02));
  // 0 = no crack .. 1 = crack core
  const crackA = float(1)
    .sub(smoothstep(wA.mul(0.1), wA, edgeA))
    .mul(smoothstep(0.05, 0.3, zone.mul(crackDensity)));

  let crackB: N = float(0);
  let edgeB: N = float(9);
  if (detail >= 2) {
    const vB = voronoi(p.mul(1 / 1.15).add(vec3(5.2, 1.7, 9.1)), false);
    edgeB = vB.y.sub(vB.x);
    const hair = smoothstep(0.55, 0.95, hot.add(zoneNoise.mul(0.15)));
    crackB = float(1).sub(smoothstep(0.0, 0.045, edgeB)).mul(hair).mul(0.7);
  }
  const crack = max(crackA, crackB);
  // Soft warm bleed on the rock beside cracks (fake glow spill; shows without bloom).
  const bleed = max(float(1).sub(smoothstep(0.0, wA.mul(2.6).add(0.03), edgeA)).mul(hot), crackB.mul(0.3)).mul(0.7);

  // Slow flowing + pulsing: bright waves crawl down along the cracks.
  const flow = mx_noise_float(vec3(p.x.mul(0.31), p.y.mul(0.22).add(time.mul(0.45)), p.z.mul(0.31)).add(vec3(4.0, 0.0, 9.0)))
    .mul(0.5)
    .add(0.5);
  const throb = sin(time.mul(1.7).add(p.y.mul(0.35)).add(rnd.mul(6.28))).mul(0.12).add(0.88);

  // Molten parts (eyes, mouth, core, joint glow): crusted lava.
  const vM = voronoi(p.mul(1 / 1.3).add(time.mul(vec3(0.015, -0.03, 0.01))).add(vec3(2.0, 8.0, 4.0)), false);
  const edgeM = vM.y.sub(vM.x);
  const crust = smoothstep(0.04, 0.34, edgeM);
  const moltenHeat = saturate(molten.mul(float(0.72).add(flow.mul(0.5))).sub(crust.mul(0.55).mul(saturate(float(1.4).sub(molten)))));

  const h0 = max(crack.mul(float(0.62).add(flow.mul(0.5))).mul(throb), moltenHeat);
  const h = saturate(h0.add(heat.mul(0.15).mul(crack)));

  // Heat ramp: deep red edge -> orange -> yellow -> white-yellow core.
  const c0 = vec3(0.5, 0.03, 0.006);
  const c1 = vec3(1.0, 0.2, 0.02);
  const c2 = vec3(1.0, 0.55, 0.1);
  const c3 = vec3(1.0, 0.9, 0.55);
  let ramp: N = mix(c0, c1, smoothstep(0.0, 0.35, h));
  ramp = mix(ramp, c2, smoothstep(0.35, 0.7, h));
  ramp = mix(ramp, c3, smoothstep(0.72, 1.0, h));
  const intensity = mix(0.0, 6.5, pow(h, 1.2)).add(h.mul(0.3));
  const lavaEmissive = ramp.mul(intensity).mul(pulse);
  const bleedEmissive = c0.mul(1.1).mul(bleed).mul(float(1).sub(h)).mul(pulse).mul(float(0.7).add(flow.mul(0.6)));

  // ---- rock surface ----------------------------------------------------
  const patch = fbm2(p.mul(0.33).add(vec3(8.0, 1.0, 3.0))).mul(0.5).add(0.5); // 0..1
  const grain = mx_noise_float(p.mul(2.7)).mul(0.5).add(0.5);
  // Blue-black basalt with rare warm brown / pale grey patches.
  let albedo: N = mix(vec3(0.052, 0.058, 0.074), vec3(0.105, 0.1, 0.108), smoothstep(0.35, 0.9, patch));
  albedo = mix(albedo, vec3(0.1, 0.075, 0.062), smoothstep(0.62, 0.95, mx_noise_float(p.mul(0.21).add(21.0)).mul(0.5).add(0.5)).mul(0.5));
  albedo = albedo.mul(tint).mul(float(0.82).add(grain.mul(0.36)));

  let rough: N = float(0.86).sub(grain.mul(0.18));

  let vesicle: N = float(0);
  if (detail >= 2) {
    // Gas bubble pits: small voronoi cells, darker and rough inside.
    const pits = mx_noise_float(p.mul(3.3));
    vesicle = smoothstep(0.42, 0.62, pits).mul(smoothstep(0.1, 0.5, mx_noise_float(p.mul(0.5)).mul(0.5).add(0.5)));
    albedo = albedo.mul(float(1).sub(vesicle.mul(0.55)));
    rough = mix(rough, float(0.97), vesicle);
  }

  // Worn lighter edges on every facet.
  const edgeWear = float(1).sub(smoothstep(0.0, 0.32, edgeDist));
  albedo = albedo.add(vec3(0.05, 0.052, 0.06).mul(edgeWear).mul(tint));
  rough = rough.sub(edgeWear.mul(0.2));

  // Scorched near cracks: darker, slightly redder char; molten parts have no albedo.
  albedo = albedo.mul(float(1).sub(bleed.mul(0.4)));
  albedo = mix(albedo, vec3(0.02, 0.008, 0.004), saturate(molten.mul(1.2)));

  // ---- rain wetness ----------------------------------------------------
  let wetness: N = wetEff;
  if (detail >= 2) {
    const streakN = mx_noise_float(vec3(p.x.mul(1.9), p.y.mul(0.16).add(time.mul(0.35)), p.z.mul(1.9)).add(7.0)).mul(0.5).add(0.5);
    const streak = smoothstep(0.25, 0.7, streakN);
    wetness = wetEff.mul(mix(0.6, 1.0, streak)).mul(float(0.6).add(saturate(normalWorld.y).mul(0.4)));
  } else {
    wetness = wetEff.mul(0.8);
  }
  wetness = saturate(wetness.sub(vesicle.mul(0.0)));
  albedo = albedo.mul(float(1).sub(wetness.mul(0.28)));
  rough = mix(rough, rough.mul(0.3).add(0.06), wetness);
  // Cracks and molten parts are glossy-hot, not wet rock.
  rough = mix(rough, float(0.5), saturate(h.mul(2)));

  // ---- night readability: cool rim light + lava-lit underside -----------
  const nv = saturate(dot(normalView, positionViewDirection));
  const rim = pow(float(1).sub(nv), 3.0);
  const rimEmissive = vec3(0.1, 0.16, 0.3).mul(rim).mul(float(0.55).add(saturate(normalWorld.y).mul(0.9)));
  // A hint of the lava's own light bouncing up onto the underside / lower body.
  const underGlow = vec3(0.55, 0.12, 0.02).mul(saturate(normalWorld.y.negate().mul(0.6).add(0.2))).mul(0.14).mul(pulse);

  material.colorNode = albedo;
  material.roughnessNode = rough;
  material.metalnessNode = float(0.04).add(wetness.mul(0.04));
  material.emissiveNode = lavaEmissive.add(bleedEmissive).add(rimEmissive).add(underGlow.mul(float(1).sub(h)));

  if (material instanceof THREE.MeshPhysicalNodeMaterial) {
    material.clearcoatNode = wetness.mul(0.85).mul(float(1).sub(saturate(h.mul(3))));
    material.clearcoatRoughnessNode = float(0.14);
  }

  // ---- micro bump (object space, finite differences) ---------------------
  if (useBump) {
    const bp = p.mul(1.9);
    const e = 0.07;
    const n0 = mx_noise_float(bp);
    const gx = mx_noise_float(bp.add(vec3(e, 0, 0))).sub(n0);
    const gy = mx_noise_float(bp.add(vec3(0, e, 0))).sub(n0);
    const gz = mx_noise_float(bp.add(vec3(0, 0, e))).sub(n0);
    const grad = vec3(gx, gy, gz).div(e);
    const no = normalize(normalLocal);
    const tang = grad.sub(no.mul(dot(grad, no)));
    // Pits push the normal outward from their rim; fade bump on molten parts.
    const strength = float(0.09).mul(float(1).sub(saturate(h.mul(1.5))));
    const nb = normalize(no.sub(tang.mul(strength)));
    material.normalNode = transformNormalToView(nb);
  }

  void abs;
  void clamp;
  void vec4;
  return { material, pulse, heat, wet };
}

// ------------------------------------------------------------------ ground glow

/** Additive lava-light pool on the ground under Basalt (cheap stand-in for low tiers). */
export function createGroundGlowMaterial(): { material: THREE.MeshBasicNodeMaterial; intensity: { value: number } } {
  const intensity = uniform(1);
  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.fog = false;
  material.toneMapped = true;
  const uvN = attribute('uv', 'vec2');
  const d = uvN.sub(0.5).mul(2);
  const r = sqrt(dot(d, d));
  const wob = mx_noise_float(vec3(d.x.mul(2.5), d.y.mul(2.5), time.mul(0.35))).mul(0.12);
  const fall = saturate(float(1).sub(r.add(wob)));
  const glow = pow(fall, 2.6).mul(0.55).add(pow(fall, 7).mul(0.5));
  const col = mix(vec3(0.7, 0.1, 0.015), vec3(1.0, 0.38, 0.06), pow(fall, 2.0)).mul(glow).mul(intensity);
  material.colorNode = col;
  material.opacityNode = float(1);
  return { material, intensity };
}
