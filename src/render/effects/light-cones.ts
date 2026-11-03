// Soft volumetric light cones under street lamps.
//
// One instanced draw for every lamp. Each instance renders the back faces of a
// bounding cone/cylinder; the fragment shader marches the view ray through the
// real cone volume (density falls off radially, with height and with distance
// from the lamp) so edges are soft by construction, there is no mesh surface to
// see, and nothing clips through the ground (the ray stops at y = 0 and the
// density fades just above it). A slowly drifting, vertically-stretched noise
// inside the volume fakes rain passing through the beam. Additive, depthWrite off.
//
// Cost: the ray march is N steps per covered pixel (12 ultra .. 5 medium).
// Lamps further than FAR_CULL from the camera collapse in the vertex shader.

import * as THREE from 'three/webgpu';
import type { QualityPreset } from '../../core/types';
import { type N, T, SODIUM, fogDensityOf } from './weather-common';

const {
  Fn, Discard, attribute, cameraPosition, dot, exp, float, length, max, min, normalize, positionGeometry, pow,
  select, sin, smoothstep, sqrt, uniform, varying, vec2, vec3, vec4, fract, abs, mix,
} = T;

/** Radius (m) the cone reaches on the ground. Lamp head ~7 m up => pool ~ 11 m wide. */
const GROUND_RADIUS = 5.8;
/** Lamps further than this from the camera are not drawn. */
const FAR_CULL = 170;

export interface LightCones {
  object: THREE.Object3D;
  update(dt: number, camera: THREE.Camera): void;
  /** Overall brightness multiplier (default 1). */
  intensity: number;
}

export function stepsFor(quality: QualityPreset): number {
  switch (quality.level) {
    case 'ultra':
      return 12;
    case 'high':
      return 8;
    case 'medium':
      return 5;
    default:
      return 0;
  }
}

export function createLightCones(
  scene: THREE.Scene,
  lampPositions: THREE.Vector3[],
  colors: THREE.Color[] | undefined,
  quality: QualityPreset,
): LightCones {
  const root = new THREE.Group();
  root.name = 'light-cones';
  const steps = stepsFor(quality);
  const count = lampPositions.length;
  const api: LightCones = {
    object: root,
    intensity: 1,
    update() {},
  };
  if (steps === 0 || count === 0) return api;

  const uTime = uniform(0);
  const uFog = uniform(0);
  const uGain = uniform(1);

  // ---- geometry: bounding cone (apex up), unit height, unit bottom radius
  const cyl = new THREE.CylinderGeometry(0.2, 1, 1, 20, 1, false);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', cyl.getAttribute('position'));
  geo.setIndex(cyl.getIndex());

  const lampData = new Float32Array(count * 4);
  const colData = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const p = lampPositions[i];
    const c = colors?.[i] ?? SODIUM;
    lampData.set([p.x, p.y, p.z, 1], i * 4);
    colData.set([c.r, c.g, c.b, 1], i * 4);
  }
  geo.setAttribute('aLamp', new THREE.InstancedBufferAttribute(lampData, 4));
  geo.setAttribute('aCol', new THREE.InstancedBufferAttribute(colData, 4));
  geo.instanceCount = count;

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.AdditiveBlending;
  mat.side = THREE.BackSide;
  mat.fog = false;

  const lamp = attribute('aLamp', 'vec4');
  const lampCol = attribute('aCol', 'vec4');
  const A = lamp.xyz; // apex = lamp head
  const H = lamp.y; // height above the ground plane (y = 0)
  const RB = float(GROUND_RADIUS * 1.15);
  const TOP = 1.0; // the volume reaches 1 m above the head for the glare

  // ---- vertex: unit cylinder -> bounding cone from (apex + TOP) down to the ground
  const pg = positionGeometry; // y in [-0.5, 0.5]
  const yWorld = A.y.add(TOP).sub(pg.y.negate().add(0.5).mul(H.add(TOP)));
  const frac = pg.y.negate().add(0.5); // 0 at top, 1 at bottom
  const radius = mix(float(1.6), RB, frac); // 1.6 m at the glare, RB at the ground
  // pg.x/z are 0.2..1 of the radius at that height already; renormalise by the local radius
  const localR = mix(float(0.2), float(1.0), frac);
  const wx = A.x.add(pg.x.div(localR).mul(radius));
  const wz = A.z.add(pg.z.div(localR).mul(radius));
  const camDist = length(vec3(A.x, 0, A.z).sub(vec3(cameraPosition.x, 0, cameraPosition.z)));
  const culled = camDist.greaterThan(FAR_CULL);
  mat.positionNode = select(culled, vec3(0, -1e4, 0), vec3(wx, yWorld, wz));

  const vWorld = varying(vec3(wx, yWorld, wz), 'coneWP');
  const vApex = varying(A, 'coneApex');
  const vH = varying(H, 'coneH');
  const vCol = varying(lampCol.xyz, 'coneCol');

  // ---- fragment: ray march through the volume
  mat.colorNode = Fn(() => {
    const ro = cameraPosition;
    const rdv = vWorld.sub(ro);
    const rd = normalize(rdv).toVar('coneRd');
    const o = ro.sub(vApex).toVar('coneO');
    const k = float(GROUND_RADIUS).div(vH);

    // slab y in [0, apex + TOP]
    const rdy = select(abs(rd.y).lessThan(1e-4), float(1e-4), rd.y);
    const ta = float(0).sub(ro.y).div(rdy);
    const tb = vApex.y.add(TOP).sub(ro.y).div(rdy);
    const tSlab0 = min(ta, tb);
    const tSlab1 = max(ta, tb);
    // bounding cylinder about the axis
    const a2 = max(dot(rd.xz, rd.xz), 1e-6);
    const b2 = dot(o.xz, rd.xz);
    const c2 = dot(o.xz, o.xz).sub(float(GROUND_RADIUS * 1.12 * GROUND_RADIUS * 1.12));
    const disc = b2.mul(b2).sub(a2.mul(c2));
    const sq = sqrt(max(disc, 0));
    const tc0 = b2.negate().sub(sq).div(a2);
    const tc1 = b2.negate().add(sq).div(a2);
    const t0 = max(max(tSlab0, tc0), 0);
    const t1 = min(min(tSlab1, tc1), t0.add(70));
    Discard(disc.lessThan(0).or(t1.lessThanEqual(t0)));

    const dt = t1.sub(t0).div(float(steps));
    // interleaved-gradient jitter hides banding
    const fc = vec2(vWorld.x.mul(7.31).add(vWorld.y.mul(3.7)), vWorld.z.mul(5.17).add(vWorld.y.mul(2.3)));
    const jitter = fract(sin(dot(fc, vec2(12.9898, 78.233))).mul(43758.5453));

    let sum: N = float(0);
    for (let s = 0; s < steps; s++) {
      const t = t0.add(dt.mul(float(s).add(jitter)));
      const p = ro.add(rd.mul(t));
      const dy = vApex.y.sub(p.y); // depth below the head
      const rc = max(k.mul(dy), 0.35); // cone radius at this depth
      const r = length(p.xz.sub(vApex.xz));
      const u = r.div(rc);
      // soft radial profile: bright core, zero at the cone edge
      const radial = exp(u.mul(u).mul(-2.2)).mul(float(1).sub(smoothstep(0.55, 1.0, u)));
      // inverse-square-ish fall-off with distance from the lamp
      const d = length(p.sub(vApex));
      const falloff = float(1).div(float(1).add(d.mul(d).div(14.0)));
      // fade in below the head and out at the ground so no hard slab edges
      const below = smoothstep(-0.8, 0.6, dy);
      const toGround = smoothstep(0.0, 1.2, p.y);
      // glare ball around the head
      const glare = exp(d.mul(d).div(-1.6)).mul(2.2);
      // drifting rain shimmer: vertically stretched, falling quickly
      const sh = sin(p.x.mul(1.37).add(p.z.mul(0.91)).add(uTime.mul(0.6)))
        .mul(sin(p.z.mul(1.71).sub(p.x.mul(0.53)).add(p.y.mul(0.55)).add(uTime.mul(4.2))))
        .mul(sin(p.x.mul(0.63).sub(p.z.mul(1.13)).add(p.y.mul(0.9)).add(uTime.mul(6.5))));
      const shimmer = float(0.82).add(sh.mul(sh).mul(1.1));
      const dens = radial.mul(falloff).mul(below).mul(toGround).mul(shimmer).add(glare.mul(0.5));
      sum = sum.add(dens);
    }
    sum = sum.mul(dt).mul(0.085);

    // forward scatter: brighter when looking up into the lamp
    const cosT = max(dot(rd, vec3(0, 1, 0)), 0);
    const phase = float(0.75).add(pow(cosT, 3).mul(1.8));
    const dist = length(vApex.sub(ro));
    const fogAtt = exp(dist.mul(uFog).mul(dist.mul(uFog)).negate());
    // keep it subtle at distance so a row of lamps doesn't become a fog wall
    const farFade = float(1).sub(smoothstep(60, FAR_CULL, dist));
    const amount = sum.mul(phase).mul(fogAtt).mul(farFade).mul(uGain);
    return vec4(vCol.mul(amount), 1);
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'light-cones-mesh';
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  root.add(mesh);
  scene.add(root);

  let t = 0;
  api.update = (dt: number): void => {
    t += Math.min(dt, 0.1);
    uTime.value = t % 3000;
    uFog.value = fogDensityOf(scene);
    uGain.value = api.intensity;
  };
  return api;
}
