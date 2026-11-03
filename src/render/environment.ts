// Environment lighting: bakes the night sky (plus a few warm "street glow"
// blobs low down) into a PMREM so PBR materials, wet tarmac and glass get
// believable night reflections and ambient colour.

import * as THREE from 'three/webgpu';
import { vec3, vec4, positionLocal, normalize, color } from 'three/tsl';
import type { Sky } from './sky';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Environment {
  texture: THREE.Texture;
  dispose(): void;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build scene.environment from the sky. Call once after the renderer is initialised.
 * `size` is the cube face size the sky is rendered at before filtering.
 */
export function createEnvironment(renderer: THREE.WebGPURenderer, sky: Sky, size: number): Environment {
  const envScene = new THREE.Scene();

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(90, 48, 24),
    (() => {
      const m = new THREE.NodeMaterial();
      m.side = THREE.BackSide;
      m.depthWrite = false;
      m.fog = false;
      m.colorNode = vec4(sky.envColor(normalize(positionLocal)) as any, 1);
      return m;
    })(),
  );
  envScene.add(dome);

  // Street glow: soft warm blobs just above the horizon, plus a couple of white LED and one red.
  const rng = mulberry32(7);
  const blobGeo = new THREE.SphereGeometry(1, 12, 8);
  const mkBlob = (r: number, g: number, b: number, az: number, el: number, radius: number) => {
    const m = new THREE.NodeMaterial();
    m.fog = false;
    m.colorNode = color(r, g, b) as any;
    const mesh = new THREE.Mesh(blobGeo, m);
    const d = 70;
    mesh.position.set(Math.cos(az) * Math.cos(el) * d, Math.sin(el) * d, Math.sin(az) * Math.cos(el) * d);
    mesh.scale.setScalar(radius);
    envScene.add(mesh);
  };
  for (let i = 0; i < 14; i++) {
    const az = (i / 14) * Math.PI * 2 + rng() * 0.4;
    const el = THREE.MathUtils.degToRad(1.5 + rng() * 7);
    const k = 0.7 + rng() * 0.9;
    mkBlob(2.4 * k, 1.05 * k, 0.28 * k, az, el, 4 + rng() * 5);
  }
  for (let i = 0; i < 3; i++) mkBlob(1.0, 1.25, 1.6, rng() * Math.PI * 2, THREE.MathUtils.degToRad(3 + rng() * 5), 3.5);
  mkBlob(2.0, 0.12, 0.08, rng() * Math.PI * 2, THREE.MathUtils.degToRad(4), 3);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = (pmrem as any).fromScene(envScene, 0, 0.1, 200, { size });

  // Free the temporary scene.
  dome.geometry.dispose();
  (dome.material as THREE.Material).dispose();
  blobGeo.dispose();
  envScene.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (m && o !== dome) m.dispose();
  });
  pmrem.dispose();

  return {
    texture: target.texture,
    dispose() {
      target.dispose();
    },
  };
}

void vec3;
