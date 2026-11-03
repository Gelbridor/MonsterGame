// Rain ripples on puddles: a TSL function the city's wet-ground material calls.
// Owned by the weather module; the city materials import it.
//
// STUB: returns "no ripple". The weather task replaces the body; the
// signature must stay the same.

import { vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';

/**
 * @param worldXZ   vec2 node: world-space x/z of the shaded point (metres).
 * @param intensity float node: 0..1 rain amount (e.g. a uniform of config.weather.rain).
 * @returns vec3 node: tangent-space normal for the ripples (z-up), to blend into the puddle normal.
 */
export function rainRipples(worldXZ: Node, intensity: Node): Node {
  void worldXZ;
  void intensity;
  return vec3(0, 0, 1);
}
