// Rain ripples on puddles: a TSL function the city's wet-ground material calls.
// Owned by the weather module; the city materials import it.
//
// Three layers of cell-grid ripples. Each cell re-hashes every cycle (new
// centre, new on/off), so nothing visibly repeats. Each ripple is a short wave
// packet (2-3 concentric crests) that expands, decays and fades. Rings reach
// ~10-28 cm and fire a few times per m^2 per second at intensity 1.

import * as THREE from 'three/webgpu';
import { type N, T, cellRand } from './weather-common';

const { Fn, vec2, vec3, float, floor, fract, length, max, normalize, smoothstep, sin, cos, exp, pow, time, fwidth, step } = T;

// [cell size (m), max ring radius (m), cycle period (s), activity probability, wave number (rad/m)]
const LAYERS: [number, number, number, number, number][] = [
  [0.72, 0.28, 1.15, 0.55, 150],
  [0.56, 0.20, 0.9, 0.7, 190],
  [0.44, 0.15, 0.75, 0.75, 230],
];

/**
 * @param worldXZ   vec2 node: world-space x/z of the shaded point (metres).
 * @param intensity float node: 0..1 rain amount (e.g. a uniform of config.weather.rain).
 * @returns vec3 node: tangent-space normal for the ripples (z-up), to blend into the puddle normal.
 *          Tangent x = world +X, tangent y = world +Z.
 */
export function rainRipples(worldXZ: THREE.Node | N, intensity: THREE.Node | N): THREE.Node {
  const xz: N = worldXZ;
  const inten: N = intensity;
  let grad: N = vec2(0, 0);

  LAYERS.forEach(([cell, rMax, period, prob, k], li) => {
    const p = xz.div(cell).add(vec2(li * 17.31, li * 5.77));
    const id = floor(p);
    const f = fract(p).sub(0.5).mul(cell); // metres from cell centre
    const phase = cellRand(id, 40 + li);
    const cyc = time.div(period).add(phase.mul(7.0));
    const n = floor(cyc);
    const age = fract(cyc);
    const seedId = id.add(vec2(n.mul(31.0), n.mul(17.0)));
    const jitterMax = (cell * 0.5 - rMax) * 0.95;
    const c = vec2(cellRand(seedId, 50 + li), cellRand(seedId, 60 + li)).sub(0.5).mul(2 * jitterMax);
    const active = step(cellRand(seedId, 70 + li), inten.mul(prob));
    const size = cellRand(seedId, 80 + li).mul(0.45).add(0.55); // ring radius scale
    const dv = f.sub(c);
    const d = max(length(dv), 1e-4);
    const r = float(rMax).mul(size).mul(float(1).sub(pow(float(1).sub(age), 2.2)));
    const x = d.sub(r);
    const w = float(0.022).add(age.mul(0.02)); // envelope width grows as it spreads
    const env = exp(x.mul(x).div(w * w).negate());
    const kk = float(k).mul(float(1.15).sub(size.mul(0.4)));
    const amp = pow(float(1).sub(age), 1.8).mul(float(0.18)).mul(active);
    // h = amp * env * sin(kk x);  dh/dd
    const dh = amp.mul(env.mul(kk).mul(cos(kk.mul(x))).sub(env.mul(x.mul(2).div(w * w)).mul(sin(kk.mul(x)))));
    // ignore the cell edges (ring radius keeps rings inside cells, but be safe)
    const inside = float(1).sub(smoothstep(cell * 0.42, cell * 0.5, max(f.x.abs(), f.y.abs())));
    grad = grad.add(dv.div(d).mul(dh.mul(inside)).mul(0.012));
  });

  // Fade out when the pixel footprint can no longer resolve the ripple wavelength.
  const foot = max(fwidth(xz.x), fwidth(xz.y));
  const resolve = float(1).sub(smoothstep(0.012, 0.045, foot));
  const g = grad.mul(resolve).mul(inten);
  return normalize(vec3(g.x.negate(), g.y.negate(), 1)) as THREE.Node;
}

// keep Fn referenced for tree-shaking-free builds
void Fn;
