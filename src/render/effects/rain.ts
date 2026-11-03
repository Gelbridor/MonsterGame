// GPU rain: two instanced layers, zero CPU per-drop work.
//
//  1. Near layer: `quality.rainDrops * config.weather.rain` velocity-aligned
//     streaks in a ~90 m box that follows the camera (wrapped with modulo in
//     the vertex shader, so there is no CPU update and no visible seam: drops
//     fade out at the box edges).
//  2. Far layer: 2 large camera-centred cylindrical "sheets" drawn in a single
//     instanced call, carrying procedural falling streaks so rain still reads
//     against distant buildings and the sky.
//
// Both are additive and unlit by the scene: they pick up brightness from the
// moon (a faint cool term) plus up to MAX_LAMPS nearby lamps (sodium orange,
// forward-scattering so rain backlit by a lamp glows).

import * as THREE from 'three/webgpu';
import { config } from '../../config';
import type { QualityPreset } from '../../core/types';
import { type N, T, rand, cellRand, fogDensityOf, weatherLamps } from './weather-common';

const { Fn, atan, floor, fract, positionLocal, step, vec2, Discard, abs, clamp, cameraPosition, cross, exp, float, instanceIndex, length, max, mod, normalize, smoothstep, uniform, uv, varying, vec3, vec4, pow } = T;

/** Side length (m) of the near-rain box, and its world-space height. */
const BOX = 90;
const BOX_Y = 70;
/** How far ahead of the camera (along its horizontal heading) the box is centred. */
const LEAD = 26;
/** Drop fall speed (m/s). */
const FALL = 9.5;
/** Cinematic streak length / width in metres. */
const STREAK_LEN = 1.5;
const STREAK_W = 0.011;

/** Moon / sky ambient term on the drops (linear). */
const AMBIENT = new THREE.Color(0.10, 0.13, 0.21);

export interface WeatherEffect {
  object: THREE.Object3D;
  update(dt: number): void;
}

export interface RainEffect extends WeatherEffect {
  /** Current number of near-layer streaks drawn. */
  readonly dropCount: number;
}

function makeQuad(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = 0;
  return g;
}

export interface RainOptions {
  /** Far cylindrical sheets (default true except on low). */
  sheets?: boolean;
  /** Near instanced streaks (default true). */
  near?: boolean;
}

export function createRain(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  quality: QualityPreset,
  options: RainOptions = {},
): RainEffect {
  const root = new THREE.Group();
  root.name = 'rain';

  // ------------------------------------------------------------ uniforms
  const uTime = uniform(0);
  const uCentre = uniform(new THREE.Vector3());
  const uWind = uniform(new THREE.Vector2(config.weather.windX, config.weather.windZ));
  const uPx = uniform(0.0015); // radians per screen pixel
  const uFog = uniform(0);
  const uAmbient = uniform(AMBIENT.clone());
  const uIntensity = uniform(1);
  const uCols = uniform(800);
  const uLampBoost = uniform(4);

  // How many lamps this tier lights rain with.
  const lampCount = quality.level === 'low' ? 4 : quality.level === 'medium' ? 6 : quality.level === 'high' ? 10 : 12;

  // ------------------------------------------------------------ near layer
  const nearGeo = makeQuad();
  const nearMat = new THREE.MeshBasicNodeMaterial();
  nearMat.transparent = true;
  nearMat.depthWrite = false;
  nearMat.blending = THREE.AdditiveBlending;
  nearMat.side = THREE.DoubleSide;
  nearMat.fog = false;

  {
    const i = instanceIndex;
    const r = (k: number): N => rand(i, k);

    const fall = float(FALL).mul(r(3).mul(0.3).add(0.85));
    const vel = vec3(
      uWind.x.mul(r(4).mul(0.6).add(0.7)),
      fall.negate(),
      uWind.y.mul(r(5).mul(0.6).add(0.7)),
    ).toVar('rainVel');
    const base = vec3(r(0).mul(BOX), r(1).mul(BOX_Y), r(2).mul(BOX));
    const p0 = base.add(vel.mul(uTime));
    const rx = mod(p0.x.sub(uCentre.x).add(BOX / 2), BOX).sub(BOX / 2);
    const rz = mod(p0.z.sub(uCentre.z).add(BOX / 2), BOX).sub(BOX / 2);
    const py = mod(p0.y, BOX_Y);
    const P = vec3(uCentre.x.add(rx), py, uCentre.z.add(rz)).toVar('rainP');

    const d = normalize(vel).toVar('rainDir');
    const toP = P.sub(cameraPosition).toVar('rainToP');
    const dist = length(toP).toVar('rainDist');
    const V = toP.div(dist).toVar('rainV');

    const rightRaw = cross(d, V);
    const right = rightRaw.div(max(length(rightRaw), 0.2)); // degenerate when looking along the rain

    const len = max(float(STREAK_LEN).mul(r(6).mul(0.7).add(0.7)), dist.mul(uPx).mul(7));
    const w0 = float(STREAK_W).mul(r(7).mul(0.6).add(0.7));
    const wd = max(w0, dist.mul(uPx).mul(1.25)).toVar('rainW');

    const q = uv();
    nearMat.positionNode = P.add(d.mul(q.y.sub(0.5).mul(len))).add(right.mul(q.x.sub(0.5).mul(wd)));

    // ---- per-drop opacity
    const nearFade = smoothstep(1.5, 8.0, dist);
    const edge = float(1).sub(smoothstep(0.72, 1.0, max(abs(rx), abs(rz)).div(BOX / 2)));
    const yFade = smoothstep(len.mul(0.5), len.mul(0.5).add(0.8), py).mul(float(1).sub(smoothstep(BOX_Y - 12, BOX_Y, py)));
    const thin = clamp(w0.div(wd), 0.35, 1.0);
    const fogAtt = exp(dist.mul(uFog).mul(dist.mul(uFog)).negate());
    const alpha = nearFade.mul(edge).mul(yFade).mul(thin).mul(fogAtt).mul(uIntensity).mul(0.42);

    // ---- per-drop light (vertex stage, shared by the 4 corners)
    const lamp = weatherLamps.light(P, V, { lamps: lampCount, r0: 7, forward: 3.0 }).mul(uLampBoost);
    const lit = varying(uAmbient.add(lamp), 'rainLit');
    const vAlpha = varying(alpha, 'rainAlpha');

    // ---- fragment: soft streak profile (gaussian across, bright head fading to the tail)
    nearMat.colorNode = Fn(() => {
      const x = abs(q.x.sub(0.5)).mul(2);
      const across = exp(x.mul(x).mul(-3.5));
      const along = pow(q.y, 1.4).mul(float(1).sub(smoothstep(0.82, 1.0, q.y).mul(0.5)));
      return vec4(lit, vAlpha.mul(across).mul(along));
    })();
  }

  const near = new THREE.Mesh(nearGeo, nearMat);
  near.name = 'rain-near';
  near.frustumCulled = false;
  near.renderOrder = 10;
  root.add(near);

  // ------------------------------------------------------------ far sheets
  // Camera-centred cylinders carrying procedural falling streaks, so rain still
  // reads against distant buildings and sky. One instanced draw for all sheets.
  let sheet: THREE.Mesh | null = null;
  if (quality.level !== 'low' && options.sheets !== false) {
    const SHEETS = quality.level === 'medium' ? 1 : 2;
    const SHEET_H = 160;
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 48, 1, true);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', cyl.getAttribute('position'));
    geo.setIndex(cyl.getIndex());
    geo.instanceCount = SHEETS;

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    mat.side = THREE.BackSide;
    mat.fog = false;

    const sheetId = instanceIndex.toFloat();
    const R = sheetId.mul(70).add(100).toVar('sheetR'); // 100 m, 170 m
    const lp = positionLocal;
    const wpos = vec3(cameraPosition.x.add(lp.x.mul(R)), lp.y.add(0.5).mul(SHEET_H).sub(6), cameraPosition.z.add(lp.z.mul(R)));
    mat.positionNode = wpos;
    const vW = varying(wpos, 'sheetWP');
    const vR = varying(R, 'sheetRad');
    const vId = varying(sheetId, 'sheetIdx');

    mat.colorNode = Fn(() => {
      const d = vW.sub(cameraPosition);
      const az = atan(d.x, d.z).div(Math.PI * 2).add(0.5); // 0..1 around the camera
      const u = az.mul(uCols);
      const col = floor(u);
      const fx = fract(u);
      const colSalt = vId.mul(7919);
      const h0 = cellRand(vec2(col, colSalt), 11);
      const h1 = cellRand(vec2(col, colSalt), 12);
      const h2 = cellRand(vec2(col, colSalt), 13);

      // streak across the column (px units)
      const cellPx = float(Math.PI * 2).div(uCols).div(uPx);
      const dx = fx.sub(h0.mul(0.5).add(0.25)).mul(cellPx);
      const across = exp(dx.mul(dx).mul(-0.9));

      // vertical dashes scrolling down
      const dashLen = vR.mul(uPx).mul(h1.mul(12).add(12));
      const speed = float(FALL * 1.6).mul(h2.mul(0.3).add(0.85));
      const s = vW.y.add(uTime.mul(speed)).div(dashLen).add(h1.mul(40));
      const k = floor(s);
      const fs = fract(s);
      const present = step(0.42, cellRand(vec2(col.add(k.mul(131)), colSalt), 14));
      const along = smoothstep(0, 0.06, fs).mul(pow(float(1).sub(fs), 1.6));

      const aFade = smoothstep(0, 14, vW.y).mul(float(1).sub(smoothstep(SHEET_H - 40, SHEET_H - 10, vW.y)));
      const fogAtt = exp(vR.mul(uFog).mul(vR).mul(uFog).negate());
      const a = across.mul(along).mul(present).mul(aFade).mul(fogAtt).mul(uIntensity).mul(0.32);
      Discard(a.lessThan(0.004));
      const V = normalize(d);
      const lamp = weatherLamps.light(vW, V, { lamps: Math.min(lampCount, 6), r0: 9, forward: 3.0, reach: 90 });
      return vec4(uAmbient.add(lamp.mul(uLampBoost)), a);
    })();

    sheet = new THREE.Mesh(geo, mat);
    sheet.name = 'rain-sheets';
    sheet.frustumCulled = false;
    sheet.renderOrder = 9;
    root.add(sheet);
  }

  scene.add(root);

  // ------------------------------------------------------------ update
  const fwd = new THREE.Vector3();
  let t = 0;
  let drops = 0;
  const limit = quality.rainDrops;

  function update(dt: number): void {
    t += Math.min(dt, 0.1);
    uTime.value = t % 20000;

    camera.getWorldDirection(fwd);
    fwd.y = 0;
    const l = fwd.length();
    if (l > 1e-3) fwd.multiplyScalar(1 / l);
    else fwd.set(0, 0, -1);
    const cx = camera.position.x + fwd.x * LEAD;
    const cz = camera.position.z + fwd.z * LEAD;
    uCentre.value.set(cx, 0, cz);
    weatherLamps.update(cx, cz);

    uWind.value.set(config.weather.windX, config.weather.windZ);
    const h = Math.max(1, window.innerHeight);
    uPx.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / h;
    uFog.value = fogDensityOf(scene);
    uCols.value = Math.max(64, Math.round((Math.PI * 2) / (4.5 * uPx.value)));

    const rain = THREE.MathUtils.clamp(config.weather.rain, 0, 1);
    uIntensity.value = rain > 0 ? 1 : 0;
    drops = Math.floor(limit * rain);
    nearGeo.instanceCount = drops;
    near.visible = drops > 0 && options.near !== false;
  }

  return {
    object: root,
    update,
    get dropCount() {
      return drops;
    },
  };
}
