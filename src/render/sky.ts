// Night sky and atmosphere (TSL).
//
// Everything here is a shader function of a world-space view direction, so the
// same code draws the visible sky (scene.backgroundNode), is baked into the
// PMREM environment map, and supplies the colour of the distance / height fog,
// which keeps haze, sky and reflections consistent.
//
// Look: a deep blue-black zenith, an orange-brown light-pollution glow on the
// horizon (a British town under rain cloud), slowly drifting moonlit cloud
// with the moon shining through it, and faint stars in the gaps.

import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { config } from '../config';
import type { QualityPreset } from '../core/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

// TSL's generic typings fight dynamic graph building; the node graph is untyped here on purpose.
const {
  Fn, float, vec2, vec3, vec4, uniform, mix, smoothstep, clamp, dot, normalize, pow, exp, max, abs, floor, fract, length, time, positionWorld, cameraPosition, output, mx_noise_float, mx_fractal_noise_float,
} = TSL as any;

/** Direction from the town towards the moon. In front-left of the default view so shapes get rim light and wet streets get a long moon streak. */
export const MOON_DIR = new THREE.Vector3(-0.62, 0.5, -0.6).normalize();

/** Moon colour (linear): cool, slightly desaturated. */
const MOON_COLOR = new THREE.Color(0.62, 0.74, 1.0);

/** Warm light-pollution tint at the horizon (linear). Also the base of the fog colour. */
const HORIZON = new THREE.Color(0.017, 0.023, 0.038);

// Dave Hoskins hash: float from vec3, no sin().
const hash13 = Fn(([p]: N[]) => {
  const p3 = fract(p.mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.zyx.add(31.32)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

export interface Sky {
  /** Visible sky colour for a normalised world direction (HDR, linear). */
  skyColor: (dir: N) => N;
  /** Same sky for the environment map: ground below the horizon, tamer moon. */
  envColor: (dir: N) => N;
  /** Fog / horizon haze colour for a normalised world direction. */
  fogColor: (dir: N) => N;
  /** Moon direction uniform (world space, normalised). */
  moonDir: N;
  /** Per-frame: refresh uniforms from config. */
  update(): void;
  /** Fog transmittance (1 = clear, 0 = fully fogged) at the current fragment. Use inside materials / MRT. */
  fogTransmittance: () => N;
  /** Value for scene.fogNode (a vec4). */
  fogNode: () => N;
}

export function createSky(quality: QualityPreset): Sky {
  const moonDir = uniform(MOON_DIR.clone());
  const fogDensity = uniform(config.render.fogDensity);

  // Cloud detail follows the quality tier (the sky covers the whole screen).
  const cloudOctaves = quality.level === 'ultra' || quality.level === 'high' ? 5 : quality.level === 'medium' ? 3 : 0;

  const horizonCol = vec3(HORIZON.r, HORIZON.g, HORIZON.b);
  const moonCol = vec3(MOON_COLOR.r, MOON_COLOR.g, MOON_COLOR.b);

  // Smooth gradient only: used by the fog, so it must be cheap and have no clouds.
  const fogColor = Fn(([dir]: N[]) => {
    const up = max(dir.y, 0);
    // Warm at the horizon, cooling towards the zenith.
    const cool = vec3(0.005, 0.009, 0.022);
    const t = pow(smoothstep(0.0, 0.55, up), 0.65);
    // Thin low sodium band right at the horizon only.
    const warm = vec3(0.05, 0.026, 0.011).mul(exp(abs(dir.y).mul(-38.0)));
    return mix(horizonCol, cool, t).add(warm);
  });

  /**
   * @param dir normalised world direction
   * @param env true when baking the environment map
   */
  const makeSky = (env: boolean) =>
    Fn(([dir]: N[]) => {
      const up = max(dir.y, 0);
      const base = fogColor(dir).toVar();

      // Darker zenith.
      base.assign(mix(base, vec3(0.0016, 0.0035, 0.011), smoothstep(0.25, 1.0, up)));
      // Broad warm skyglow, a little uneven so the horizon is not a perfect ring.
      const azimuth = vec3(dir.x, dir.z, 0.0).mul(2.3);
      const uneven = mx_noise_float(azimuth).mul(0.25).add(1.0);
      base.addAssign(vec3(0.17, 0.075, 0.03).mul(exp(up.mul(-14.0))).mul(uneven).mul(0.1));

      const col = base.toVar();
      const cloudDensity = float(0).toVar();
      const core = float(0).toVar();

      if (cloudOctaves > 0) {
        const t = time.mul(0.0035);
        const proj = dir.xz.div(up.add(0.22)).mul(0.55);
        const p = proj.add(vec2(t.mul(2.2), t.mul(0.8))).toVar();
        // Domain warp so the clouds do not look like plain noise.
        const warp = mx_noise_float(vec3(p.mul(0.45), t.mul(3.0)));
        p.addAssign(vec2(warp, warp.mul(-0.7)).mul(0.55));
        const n = mx_fractal_noise_float(vec3(p, t.mul(2.0)), cloudOctaves, 2.1, 0.5).mul(0.5).add(0.52);
        // Mostly overcast, with gaps.
        cloudDensity.assign(smoothstep(0.42, 0.78, n));
        core.assign(smoothstep(0.55, 0.95, n));
        // The layer merges into the horizon haze rather than aliasing in the distance.
        cloudDensity.mulAssign(smoothstep(0.0, 0.22, up));
      }

      // Stars, only where there is no cloud.
      const sp = dir.mul(190.0);
      const cell = floor(sp);
      const h = hash13(cell);
      const jitter = vec3(hash13(cell.add(17.0)), hash13(cell.add(31.0)), hash13(cell.add(53.0))).sub(0.5).mul(0.5);
      const d = length(fract(sp).sub(0.5).sub(jitter));
      const star = smoothstep(0.985, 1.0, h).mul(smoothstep(0.22, 0.0, d)).mul(h.sub(0.97).mul(30.0).min(1.0));
      const starFade = smoothstep(0.06, 0.4, up).mul(float(1).sub(cloudDensity).pow(3.0));
      col.addAssign(vec3(0.55, 0.65, 0.9).mul(star).mul(starFade).mul(env ? 0.0 : 0.45));

      // Moon: disc, tight glow and a wide halo that the cloud scatters.
      const moonCos = clamp(dot(dir, normalize(moonDir)), 0, 1);
      const discR = 0.034;
      const disc = smoothstep(Math.cos(discR * 1.08), Math.cos(discR * 0.94), moonCos);
      // Faint maria so the disc is not a flat sticker.
      const maria = mx_noise_float(dir.mul(46.0)).mul(0.5).add(0.5);
      const moonDisc = disc.mul(mix(0.55, 1.0, maria)).mul(env ? 4.0 : 6.5);
      const glow = pow(moonCos, 500.0).mul(1.2).add(pow(moonCos, 40.0).mul(0.09)).add(pow(moonCos, 6.0).mul(0.012));
      // Cloud lit from behind: bright rims near the moon, dark cores.
      const silver = pow(moonCos, 8.0).mul(0.22).add(pow(moonCos, 60.0).mul(0.9));
      const thin = float(1).sub(core.mul(0.75));

      const cloudBase = mix(vec3(0.014, 0.021, 0.045), vec3(0.05, 0.058, 0.08), exp(up.mul(-5.0)));
      const cloudCol = cloudBase.mul(float(1).sub(core.mul(0.45)))
        .add(moonCol.mul(silver).mul(thin).mul(0.55));

      col.assign(mix(col, cloudCol, cloudDensity.mul(0.93)));
      col.addAssign(moonCol.mul(glow).mul(mix(1.0, 0.8, cloudDensity)));
      col.addAssign(moonCol.mul(moonDisc).mul(float(1).sub(cloudDensity.mul(0.78))));

      // Fade into the fog colour at the horizon so the two always meet.
      const horizonBlend = smoothstep(0.0, 0.1, dir.y);
      col.assign(mix(fogColor(dir), col, horizonBlend));

      if (env) {
        // Below the horizon: dark, warm, wet ground.
        const ground = vec3(0.02, 0.015, 0.011).add(vec3(0.05, 0.022, 0.009).mul(exp(abs(dir.y).mul(-14.0))));
        col.assign(mix(col, ground, smoothstep(0.0, -0.06, dir.y)));
      }
      return col;
    });

  const skyColor = makeSky(false);
  const envColor = makeSky(true);

  // ---- fog: exponential distance fog plus exponential height fog (rain haze hugging the streets).
  const HEIGHT_FALLOFF = 0.028; // 1/m: scale height ~35 m
  const fogParts = () => {
    const toFrag = positionWorld.sub(cameraPosition);
    const dist = max(length(toFrag), 0.001);
    const dir = toFrag.div(dist);
    const dy = toFrag.y;
    // Analytic integral of exp(-k*h) along the ray.
    const t = dy.mul(HEIGHT_FALLOFF);
    const tt = abs(t).lessThan(0.002).select(float(0.002), t);
    const heightTerm = exp(cameraPosition.y.mul(-HEIGHT_FALLOFF)).mul(float(1).sub(exp(tt.negate()))).div(tt);
    const tau = dist.mul(fogDensity).mul(heightTerm.mul(1.7).add(0.22));
    const transmittance = exp(tau.negate().min(0)).toVar();
    return { transmittance, dir, dist };
  };

  const fogTransmittance = () => fogParts().transmittance;

  const fogNode = () => {
    const { transmittance, dir } = fogParts();
    const color = fogColor(dir);
    return vec4(mix(color, (output as N).rgb, transmittance), (output as N).a);
  };

  return {
    skyColor,
    envColor,
    fogColor,
    moonDir,
    update() {
      fogDensity.value = config.render.fogDensity;
    },
    fogTransmittance,
    fogNode,
  };
}

