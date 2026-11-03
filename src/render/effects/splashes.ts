// Rain splashes on the ground: instanced quads animated entirely in the shader.
//
// Each instance cycles every ~0.55 s; on every cycle it re-hashes to a new
// spot inside a camera-following area, so the pattern never visibly repeats.
// One instance = a flat expanding crown ring (horizontal quad) + a few ballistic
// droplets (upright camera-facing quad), both drawn in one draw call.
// Brightness comes from a faint moon term plus the nearby lamps (sodium pools).

import * as THREE from 'three/webgpu';
import { config } from '../../config';
import type { QualityPreset } from '../../core/types';
import { type N, T, cellRand, fogDensityOf, weatherLamps } from './weather-common';
import type { WeatherEffect } from './rain';

const {
  Fn, abs, cameraPosition, cross, exp, float, floor, fract, instanceIndex, length, max, mod, normalize, positionGeometry,
  pow, smoothstep, sqrt, uniform, uv, varying, vec2, vec3, vec4, select, sin, cos,
} = T;

/** Side (m) of the camera-following square the splashes live in. */
const AREA = 84;
/** Look-ahead of the area centre along the camera heading (m). */
const LEAD = 28;
/** Seconds per splash cycle. */
const CYCLE = 0.55;
/** Crown radius in metres at the end of its life (before the distance boost). */
const CROWN_R = 0.2;
const DROPLETS = 5;

const AMBIENT = new THREE.Color(0.11, 0.145, 0.23);

export function splashCountFor(quality: QualityPreset): number {
  switch (quality.level) {
    case 'ultra':
      return 5000;
    case 'high':
      return 2800;
    case 'medium':
      return 900;
    default:
      return 0;
  }
}

export function createSplashes(scene: THREE.Scene, camera: THREE.PerspectiveCamera, quality: QualityPreset): WeatherEffect {
  const root = new THREE.Group();
  root.name = 'splashes';
  const max_ = splashCountFor(quality);
  if (max_ === 0) {
    return { object: root, update() {} };
  }

  const uTime = uniform(0);
  const uCentre = uniform(new THREE.Vector3());
  const uPx = uniform(0.0015);
  const uFog = uniform(0);
  const uAmbient = uniform(AMBIENT.clone());
  const uIntensity = uniform(1);
  const lampCount = quality.level === 'medium' ? 4 : quality.level === 'high' ? 8 : 12;

  // Quad: xy in [-0.5,0.5]; z = part (0 = flat crown ring, 1 = upright droplet card).
  const geo = new THREE.InstancedBufferGeometry();
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let part = 0; part < 2; part++) {
    const o = part * 4;
    pos.push(-0.5, -0.5, part, 0.5, -0.5, part, 0.5, 0.5, part, -0.5, 0.5, part);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.instanceCount = max_;

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.AdditiveBlending;
  mat.side = THREE.DoubleSide;
  mat.fog = false;

  const i = instanceIndex.toFloat();
  const cyc = uTime.div(CYCLE).add(cellRand(vec2(i, 0), 1));
  const n = floor(cyc);
  const age = fract(cyc).toVar('splAge');
  const rA = cellRand(vec2(i, n), 2);
  const rB = cellRand(vec2(i, n), 3);
  const rC = cellRand(vec2(i, n), 4);
  const rD = cellRand(vec2(i, n), 5);

  const gx = rA.mul(AREA);
  const gz = rB.mul(AREA);
  const rx = mod(gx.sub(uCentre.x).add(AREA / 2), AREA).sub(AREA / 2);
  const rz = mod(gz.sub(uCentre.z).add(AREA / 2), AREA).sub(AREA / 2);
  const C = vec3(uCentre.x.add(rx), 0.035, uCentre.z.add(rz)).toVar('splC');

  const toC = C.sub(cameraPosition).toVar('splToC');
  const dist = length(toC).toVar('splDist');
  const V = toC.div(dist);

  // Size: physical crown, but never smaller than ~7 px radius so it reads from 45 m.
  const sizeScale = rC.mul(0.6).add(0.7);
  const R = max(float(CROWN_R).mul(sizeScale), dist.mul(uPx).mul(7)).toVar('splR');
  const part = positionGeometry.z;
  const qx = positionGeometry.x;
  const qy = positionGeometry.y;

  // flat crown quad: spans +-1.25 R
  const flat = vec3(C.x.add(qx.mul(R).mul(2.5)), C.y, C.z.add(qy.mul(R).mul(2.5)));
  // droplet card: camera-facing about Y, 2.5 R wide, 3.5 R tall
  const right = normalize(cross(vec3(0, 1, 0), V));
  const card = C.add(right.mul(qx.mul(R).mul(2.5))).add(vec3(0, qy.add(0.5).mul(R).mul(3.5), 0));
  mat.positionNode = select(part.greaterThan(0.5), card, flat);

  // ---- opacity
  const edge = float(1).sub(smoothstep(0.7, 1.0, max(abs(rx), abs(rz)).div(AREA / 2)));
  const nearFade = smoothstep(2, 9, dist);
  const fogAtt = exp(dist.mul(uFog).mul(dist.mul(uFog)).negate());
  const vFade = varying(edge.mul(nearFade).mul(fogAtt).mul(uIntensity).mul(rD.mul(0.5).add(0.5)), 'splFade');
  const vPart = varying(part, 'splPart');
  const vAge = varying(age, 'splAgeV');
  // one screen pixel in quad-normalised units (for min dot size)
  const vPix = varying(dist.mul(uPx).div(R), 'splPix');
  const vSeed = varying(vec2(rC, rA), 'splSeed');

  const lamp = weatherLamps.light(C.add(vec3(0, 0.3, 0)), V, { lamps: lampCount, r0: 6, forward: 0.6, reach: 55 });
  const vLit = varying(uAmbient.add(lamp.mul(2.5)), 'splLit');

  const q = uv();
  // distance (in R units) between a card point and the segment a-b
  const sdSeg = (p: N, a: N, b: N): N => {
    const pa = p.sub(a);
    const ba = b.sub(a);
    const h = pa.dot(ba).div(max(ba.dot(ba), 1e-5)).clamp(0, 1);
    return length(pa.sub(ba.mul(h)));
  };
  mat.colorNode = Fn(() => {
    const a = vAge;
    const px = vPix; // one screen pixel in R units
    const isCard = vPart.greaterThan(0.5);

    // ---- crown ring (flat quad spanning +-1.25 R): expands, thins, fades
    const pr = q.sub(0.5).mul(2.5);
    const rr = length(pr);
    const rad = sqrt(a).mul(0.95).add(0.05);
    const w = px.mul(0.9).add(float(0.07).mul(float(1).sub(a)));
    const ringD = rr.sub(rad).div(w);
    const ring = exp(ringD.mul(ringD).negate()).mul(pow(float(1).sub(a), 1.3));
    const rad2 = rad.mul(0.58);
    const ring2D = rr.sub(rad2).div(w);
    const ring2 = exp(ring2D.mul(ring2D).negate()).mul(pow(float(1).sub(a), 2.2)).mul(0.5);
    const flatA = ring.add(ring2).mul(0.55);

    // ---- droplets (upright card, 2.5 R wide x 3.5 R tall): short ballistic streaks
    const cp = vec2(q.x.sub(0.5).mul(2.5), q.y.mul(3.5));
    let drops: N = float(0);
    for (let k = 0; k < DROPLETS; k++) {
      const kk = float(k);
      const ang = kk.mul(2.399).add(vSeed.x.mul(6.283));
      const hv = fract(sin(kk.mul(12.9898).add(vSeed.y.mul(78.233))).mul(43758.5453));
      const vx = cos(ang).mul(hv.mul(0.55).add(0.25));
      const vy = hv.mul(1.1).add(1.5);
      const g = vy.mul(2.0);
      const pos2 = vec2(vx.mul(a), vy.mul(a).sub(g.mul(a).mul(a).mul(0.5)).add(0.02));
      const vel = vec2(vx, vy.sub(g.mul(a)));
      const tail = pos2.sub(vel.mul(0.09));
      const dd = sdSeg(cp, tail, pos2);
      const r = px.mul(0.75).add(0.012);
      drops = drops.add(exp(dd.div(r).mul(dd.div(r)).negate()).mul(hv.mul(0.6).add(0.4)));
    }
    const dropA = drops.mul(pow(float(1).sub(a), 0.7)).mul(0.6);

    const alpha = select(isCard, dropA, flatA).mul(vFade);
    return vec4(vLit, alpha);
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'splashes-mesh';
  mesh.frustumCulled = false;
  mesh.renderOrder = 11;
  root.add(mesh);
  scene.add(root);

  const fwd = new THREE.Vector3();
  let t = 0;

  function update(dt: number): void {
    t += Math.min(dt, 0.1);
    uTime.value = t % 5000;
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    const l = fwd.length();
    if (l > 1e-3) fwd.multiplyScalar(1 / l);
    else fwd.set(0, 0, -1);
    const cx = camera.position.x + fwd.x * LEAD;
    const cz = camera.position.z + fwd.z * LEAD;
    uCentre.value.set(cx, 0, cz);
    weatherLamps.update(cx, cz);
    uPx.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, window.innerHeight);
    uFog.value = fogDensityOf(scene);
    const rain = THREE.MathUtils.clamp(config.weather.rain, 0, 1);
    uIntensity.value = rain > 0 ? 1 : 0;
    geo.instanceCount = Math.floor(max_ * rain);
    mesh.visible = geo.instanceCount > 0;
  }

  return { object: root, update };
}
