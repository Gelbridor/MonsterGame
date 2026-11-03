// Shared helpers for the weather effects (rain, splashes, light cones):
//  - a registry of street lamps / fires that light the rain (nearest N are fed
//    to the shaders as a small uniform array),
//  - hashing helpers and a few TSL utilities.
//
// Everything is allocation-free per frame.

import * as THREE from 'three/webgpu';
import * as TSLNS from 'three/tsl';

// Node graphs are built dynamically; the d.ts types for TSL are too strict to be useful here,
// so the effect files take their TSL functions from this untyped view.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type N = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const T: Record<string, any> = TSLNS as any;
const { float, hash, uint, uniformArray, vec3, pow, max, dot, sqrt, smoothstep } = T;

/** Number of lamps the shaders see at once. */
export const MAX_LAMPS = 12;

/** Sodium-vapour orange (linear-ish, tuned by eye). */
export const SODIUM = new THREE.Color(1.0, 0.52, 0.16);

/** Pcg hash of (integer id + salt) -> [0,1). `id` must be a uint/int node. */
export const rand = (id: N, salt: number): N => hash(id.toUint().add(uint(Math.imul(salt + 1, 0x9e3779b1) >>> 0)));

/** Hash of a 2D integer cell id (float nodes holding integers) + salt -> [0,1). */
export const cellRand = (cell: N, salt: number): N => {
  const ix = cell.x.toInt().toUint();
  const iz = cell.y.toInt().toUint();
  const seed = ix.mul(uint(73856093)).bitXor(iz.mul(uint(19349663))).add(uint(Math.imul(salt + 1, 0x9e3779b1) >>> 0));
  return hash(seed);
};

/** Extract street-lamp head positions from the town's instanced meshes (userData.part === 'streetLight', emissive heads). */
export function collectLampPositions(root: THREE.Object3D): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const m = new THREE.Matrix4();
  root.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (!im.isInstancedMesh || im.userData?.part !== 'streetLight') return;
    const mat = im.material as THREE.MeshStandardMaterial;
    if (!mat.emissive || mat.emissive.getHex() === 0 || !(mat.emissiveIntensity > 0)) return; // posts, not heads
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      out.push(new THREE.Vector3().setFromMatrixPosition(m).applyMatrix4(im.matrixWorld));
    }
  });
  return out;
}

/**
 * Lamps (street lights, fires, lava) that light the rain. The nearest
 * MAX_LAMPS to a focus point are copied into a uniform array each frame.
 * One shared instance (`weatherLamps`) is used by every weather effect.
 */
export class LampField {
  private pos: THREE.Vector3[] = [];
  private col: THREE.Color[] = [];
  private inten: number[] = [];
  private d2: Float32Array = new Float32Array(0);
  private taken: Uint8Array = new Uint8Array(0);
  private lastX = 1e9;
  private lastZ = 1e9;
  private dirty = true;

  /** vec4 per lamp: xyz = position, w = intensity scale (0 = unused slot). */
  readonly posU: N;
  /** vec4 per lamp: rgb = colour. */
  readonly colU: N;
  private posArr: THREE.Vector4[] = [];
  private colArr: THREE.Vector4[] = [];

  constructor(readonly count = MAX_LAMPS) {
    for (let i = 0; i < count; i++) {
      this.posArr.push(new THREE.Vector4(0, -1000, 0, 0));
      this.colArr.push(new THREE.Vector4(1, 0.5, 0.15, 0));
    }
    this.posU = uniformArray(this.posArr, 'vec4');
    this.colU = uniformArray(this.colArr, 'vec4');
  }

  /** Replace the light list (call again whenever lamps/fires change). */
  set(positions: readonly THREE.Vector3[], colors?: readonly THREE.Color[], intensities?: readonly number[]): void {
    this.pos = positions.map((p) => p.clone());
    this.col = positions.map((_, i) => (colors?.[i] ?? SODIUM).clone());
    this.inten = positions.map((_, i) => intensities?.[i] ?? 1);
    this.d2 = new Float32Array(this.pos.length);
    this.taken = new Uint8Array(this.pos.length);
    this.dirty = true;
  }

  get size(): number {
    return this.pos.length;
  }

  /** Pick the lamps nearest to (x, z). Cheap early-out when the focus barely moved. */
  update(x: number, z: number): void {
    const n = this.pos.length;
    if (!this.dirty && Math.abs(x - this.lastX) < 1 && Math.abs(z - this.lastZ) < 1) return;
    this.dirty = false;
    this.lastX = x;
    this.lastZ = z;
    for (let i = 0; i < n; i++) {
      const dx = this.pos[i].x - x;
      const dz = this.pos[i].z - z;
      this.d2[i] = dx * dx + dz * dz;
      this.taken[i] = 0;
    }
    for (let k = 0; k < this.count; k++) {
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        if (!this.taken[i] && this.d2[i] < bd) {
          bd = this.d2[i];
          best = i;
        }
      }
      if (best < 0) {
        this.posArr[k].set(0, -1000, 0, 0);
        continue;
      }
      this.taken[best] = 1;
      const p = this.pos[best];
      const c = this.col[best];
      this.posArr[k].set(p.x, p.y, p.z, this.inten[best]);
      this.colArr[k].set(c.r, c.g, c.b, 1);
    }
  }

  /**
   * TSL: light scattered towards the viewer from a participating particle
   * (rain drop / splash) at world position `P`.
   * @param V     normalised view direction (camera -> P)
   * @param scale lamp radius scale: pool radius ~ r0 metres (default 5)
   * @param lamps how many of the nearest slots to evaluate (<= count)
   * @param forward strength of the forward-scatter lobe (rain backlit by lamp)
   */
  light(P: N, V: N, opts: { r0?: number; lamps?: number; forward?: number; reach?: number } = {}): N {
    const r0 = opts.r0 ?? 5;
    const reach = opts.reach ?? 60;
    const forward = opts.forward ?? 2.5;
    const n = Math.min(opts.lamps ?? this.count, this.count);
    let sum: N = vec3(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const lp = this.posU.element(i);
      const lc = this.colU.element(i);
      const Lv = lp.xyz.sub(P);
      const d2 = max(dot(Lv, Lv), 0.25);
      const d = sqrt(d2);
      // soft inverse-square pool: ~1 inside r0, falling off beyond, hard zero at `reach`
      const att = lp.w.div(float(1).add(d2.div(r0 * r0))).mul(float(1).sub(smoothstep(reach * 0.45, reach, d)));
      const cosT = max(dot(V, Lv.div(d)), 0);
      const phase = float(0.3).add(pow(cosT, 3).mul(forward));
      sum = sum.add(lc.xyz.mul(att.mul(phase)));
    }
    return sum;
  }
}

/** The shared lamp registry used by rain, splashes and (optionally) anything else. */
export const weatherLamps = new LampField();

/** Register the lights that illuminate rain. Positions are lamp-head world positions. */
export function setWeatherLamps(positions: readonly THREE.Vector3[], colors?: readonly THREE.Color[], intensities?: readonly number[]): void {
  weatherLamps.set(positions, colors, intensities);
}

/** Read fog density from a scene (FogExp2 only; 0 otherwise). */
export function fogDensityOf(scene: THREE.Scene): number {
  const f = scene.fog as THREE.FogExp2 | null;
  return f && (f as THREE.FogExp2).isFogExp2 ? f.density : 0;
}
