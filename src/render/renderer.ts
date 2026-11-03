// Renderer, scene, camera and night lighting.
//
// Uses THREE.WebGPURenderer, which has its own WebGL 2 backend. We make the
// fallback explicit: forced via URL / missing navigator.gpu, and retried if
// WebGPU init throws.

import * as THREE from 'three/webgpu';
import { normalize, positionLocal, vec4 } from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { config } from '../config';
import type { QualityPreset, RenderBackend, RenderContext } from '../core/types';
import { createSky, MOON_DIR } from './sky';
import { createEnvironment } from './environment';
import { createPost, type Post } from './post';

/** Half-size (m) of the orthographic shadow frustum around the focus point. */
const SHADOW_EXTENT = 90;
/** Distance (m) from the focus point to the moon light. */
const SHADOW_DISTANCE = 220;
/** Far edge (m) of the cascaded moon shadows. */
const CSM_FAR = 400;
/** Light units per config.render.moonIntensity / ambientIntensity. */
const MOON_GAIN = 1.5;
const HEMI_GAIN = 0.14;

function wantsForcedWebGL(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has('webgl') || params.get('backend') === 'webgl';
}

/** Dispose a renderer that may have failed to initialise, ignoring errors. */
function safeDispose(r: THREE.WebGPURenderer): void {
  try {
    void Promise.resolve(r.dispose()).catch(() => {});
  } catch {
    // ignore
  }
}

async function initRenderer(
  quality: QualityPreset,
): Promise<{ renderer: THREE.WebGPURenderer; backend: RenderBackend }> {
  let forceWebGL = wantsForcedWebGL() || !(navigator as Navigator & { gpu?: unknown }).gpu;
  let lastError: unknown;

  // Attempt 1: as requested. Attempt 2 (only if attempt 1 wasn't already WebGL): force WebGL 2.
  for (let attempt = 0; attempt < 2; attempt++) {
    const renderer = new THREE.WebGPURenderer({ antialias: quality.antialias && !quality.post.enabled, forceWebGL });
    try {
      await renderer.init();
      const backend: RenderBackend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
        ? 'webgpu'
        : 'webgl2';
      console.info(`[renderer] backend: ${backend}`);
      return { renderer, backend };
    } catch (err) {
      lastError = err;
      console.warn(`[renderer] ${forceWebGL ? 'WebGL 2' : 'WebGPU'} init failed`, err);
      safeDispose(renderer);
      if (forceWebGL) break;
      forceWebGL = true;
    }
  }

  const detail = lastError instanceof Error ? ` (${lastError.message})` : '';
  throw new Error(
    `Could not start the 3D renderer. Neither WebGPU nor WebGL 2 is available in this browser${detail}. ` +
      'Try a recent version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.',
  );
}

/**
 * Reload once with the WebGL 2 backend forced. Used when WebGPU initialised
 * but then failed (device lost, or render calls throwing), which otherwise
 * leaves a blank canvas. `?webgl` in the URL prevents a reload loop.
 */
export function reloadWithWebGL(reason: unknown): void {
  if (wantsForcedWebGL()) return;
  console.warn('[renderer] WebGPU failed after start-up, reloading with WebGL 2', reason);
  const url = new URL(window.location.href);
  url.searchParams.set('webgl', '');
  window.location.replace(url.toString());
}

export async function createRenderer(container: HTMLElement, quality: QualityPreset): Promise<RenderContext> {
  const { renderer, backend } = await initRenderer(quality);
  if (backend === 'webgpu') {
    renderer.onDeviceLost = (info) => reloadWithWebGL(info);
  }

  // ---- renderer settings
  // Tone mapping is applied once: by the post pipeline's output stage, or by the renderer when post is off.
  // ACES keeps sodium orange punchy and holds contrast in the dark; `?tonemap=agx` is there for A/B checks.
  const tmParam = new URLSearchParams(window.location.search).get('tonemap');
  const toneMapping = tmParam === 'agx' ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMapping = toneMapping;
  renderer.toneMappingExposure = config.render.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const shadowsOn = quality.shadowMapSize > 0;
  renderer.shadowMap.enabled = shadowsOn;
  // WebGPURenderer maps PCFSoftShadowMap to PCFShadowMap (with a warning), so ask for PCF directly.
  // PCF here is a 5-tap rotated Vogel disk: `shadow.radius` (texels) sets the softness.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // Many point lights (street lamps, lava) are cheaper with clustered shading. Works on both backends.
  if (quality.maxDynamicLights >= 16) {
    renderer.lighting = new ClusteredLighting(Math.max(64, quality.maxDynamicLights * 2));
  }

  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.touchAction = 'none';
  container.appendChild(canvas);

  // ---- scene
  const scene = new THREE.Scene();
  const sky = createSky(quality);
  // Sky dome as a background node: far plane, no depth write, so AO / SSR treat it as empty space.
  scene.backgroundNode = vec4(sky.skyColor(normalize(positionLocal)), 1);
  // Distance + height fog coloured by the sky horizon glow.
  scene.fogNode = sky.fogNode();

  const env = createEnvironment(renderer, sky, 256);
  scene.environment = env.texture;
  scene.environmentIntensity = config.render.envIntensity;

  // ---- camera
  const camera = new THREE.PerspectiveCamera(config.camera.fov, 1, config.camera.near, config.camera.far);

  // ---- lighting
  // Dark scene with pools of light: a weak cool sky / warm ground fill, the rest comes from the environment and the moon.
  const hemi = new THREE.HemisphereLight(0x5f78a8, 0x3a2a20, config.render.ambientIntensity * HEMI_GAIN);
  scene.add(hemi);

  // The moon.
  const sun = new THREE.DirectionalLight(0xb4c8ff, config.render.moonIntensity * MOON_GAIN);
  sun.position.copy(MOON_DIR).multiplyScalar(SHADOW_DISTANCE);
  scene.add(sun);
  scene.add(sun.target);

  let csm: CSMShadowNode | null = null;
  let csmTuned = false;
  if (shadowsOn) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    sun.shadow.radius = 2.5;
    const cam = sun.shadow.camera;
    if (quality.cascadedShadows) {
      cam.near = 1;
      cam.far = 900;
      cam.updateProjectionMatrix();
      sun.shadow.bias = -0.0003;
      sun.shadow.normalBias = 0.12;
      const cascades = quality.level === 'ultra' ? 4 : 3;
      const splits = cascades === 4 ? [70, 140, 250, CSM_FAR] : [80, 190, CSM_FAR];
      csm = new CSMShadowNode(sun, {
        cascades,
        maxFar: CSM_FAR,
        mode: 'custom',
        lightMargin: 160,
        customSplitsCallback: (_n: number, _near: number, far: number, target: number[]) => {
          for (const d of splits) target.push(Math.min(d, far) / far);
        },
      });
      csm.fade = true;
      sun.shadow.shadowNode = csm;
    } else {
      cam.left = -SHADOW_EXTENT;
      cam.right = SHADOW_EXTENT;
      cam.top = SHADOW_EXTENT;
      cam.bottom = -SHADOW_EXTENT;
      cam.near = 10;
      cam.far = SHADOW_DISTANCE * 2;
      cam.updateProjectionMatrix();
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.2;
    }
  }

  // ---- shadow focus (snapped to shadow texels to stop shimmering)
  // With cascades the shadow node does its own texel snapping; only the single map needs this.
  const texelSize = shadowsOn && !csm ? (2 * SHADOW_EXTENT) / quality.shadowMapSize : 0;
  // Light-space axes: z points from the focus towards the moon.
  const lightX = new THREE.Vector3(0, 1, 0).cross(MOON_DIR).normalize();
  const lightY = new THREE.Vector3().crossVectors(MOON_DIR, lightX);
  const snapped = new THREE.Vector3();

  function setShadowFocus(target: THREE.Vector3): void {
    snapped.copy(target);
    if (texelSize > 0) {
      const px = target.dot(lightX);
      const py = target.dot(lightY);
      const sx = Math.round(px / texelSize) * texelSize;
      const sy = Math.round(py / texelSize) * texelSize;
      snapped.addScaledVector(lightX, sx - px).addScaledVector(lightY, sy - py);
    }
    sun.target.position.copy(snapped);
    sun.position.copy(snapped).addScaledVector(MOON_DIR, SHADOW_DISTANCE);
    sun.target.updateMatrixWorld();
  }
  setShadowFocus(new THREE.Vector3(0, 0, 0));

  // ---- post-processing
  let post: Post | null = null;
  if (quality.post.enabled) {
    try {
      post = createPost(renderer, scene, camera, quality, sky, toneMapping);
    } catch (err) {
      console.warn('[renderer] post-processing setup failed, rendering directly', err);
    }
  }

  // ---- sizing
  function resize(): void {
    const w = Math.max(1, container.clientWidth || window.innerWidth);
    const h = Math.max(1, container.clientHeight || window.innerHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, quality.pixelRatio, config.render.maxPixelRatio);
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  renderer.info.autoReset = false;

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  window.visualViewport?.addEventListener('resize', resize);

  let disposed = false;

  (window as unknown as { __THREE: unknown }).__THREE = THREE; // TEMP-DEBUG
  const ctx: RenderContext = {
    renderer,
    backend,
    scene,
    camera,
    quality,
    sun,
    render(): void {
      if (disposed) return;
      // Re-read tunables so the debug panel can change them live.
      renderer.toneMappingExposure = config.render.exposure;
      scene.environmentIntensity = config.render.envIntensity;
      hemi.intensity = config.render.ambientIntensity * HEMI_GAIN;
      sun.intensity = config.render.moonIntensity * MOON_GAIN;
      sky.update();
      let frustumChanged = false;
      if (camera.fov !== config.camera.fov || camera.near !== config.camera.near || camera.far !== config.camera.far) {
        camera.fov = config.camera.fov;
        camera.near = config.camera.near;
        camera.far = config.camera.far;
        camera.updateProjectionMatrix();
        frustumChanged = true;
      }
      if (csm) {
        if (frustumChanged) csm.updateFrustums();
        // The cascade lights exist after the first build; give each its own bias (texels grow with distance).
        if (!csmTuned && csm.lights.length > 0) {
          csm.lights.forEach((l, i) => {
            l.shadow!.normalBias = 0.1 + i * 0.09;
            l.shadow!.bias = -0.00025 * (i + 1);
            l.shadow!.radius = 2.5;
          });
          csmTuned = true;
        }
      }
      const ov = (ctx as unknown as { camOverride?: { pos: number[]; look: number[] } }).camOverride; // TEMP-DEBUG
      if (ov) {
        camera.position.set(ov.pos[0], ov.pos[1], ov.pos[2]);
        camera.lookAt(ov.look[0], ov.look[1], ov.look[2]);
        camera.updateMatrixWorld();
      }
      try {
        if (post) {
          post.render();
        } else {
          renderer.info.reset();
          renderer.render(scene, camera);
        }
      } catch (err) {
        if (backend === 'webgpu') reloadWithWebGL(err);
        else throw err;
      }
    },
    setShadowFocus,
    info() {
      return { drawCalls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('resize', resize);
      window.removeEventListener('orientationchange', resize);
      window.visualViewport?.removeEventListener('resize', resize);
      post?.dispose();
      env.dispose();
      canvas.remove();
      safeDispose(renderer);
    },
  };
  return ctx;
}

/**
 * Set castShadow / receiveShadow on every mesh under `object` for the given
 * quality preset.
 *  - 'monster': casts and receives whenever shadow maps are on.
 *  - 'city':    casts and receives only if the preset has shadowsOnCity.
 *  - 'ground':  receives whenever shadow maps are on (never casts).
 */
export function applyShadowFlags(
  object: THREE.Object3D,
  kind: 'monster' | 'city' | 'ground',
  quality: QualityPreset,
): void {
  const shadowsOn = quality.shadowMapSize > 0;
  let cast = false;
  let receive = false;
  switch (kind) {
    case 'monster':
      cast = receive = shadowsOn;
      break;
    case 'city':
      cast = receive = shadowsOn && quality.shadowsOnCity;
      break;
    case 'ground':
      receive = shadowsOn;
      break;
  }
  object.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
}
