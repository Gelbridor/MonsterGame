// Renderer, scene, camera and night lighting.
//
// Uses THREE.WebGPURenderer, which has its own WebGL 2 backend. We make the
// fallback explicit: forced via URL / missing navigator.gpu, and retried if
// WebGPU init throws.

import * as THREE from 'three/webgpu';
import { config } from '../config';
import type { QualityPreset, RenderBackend, RenderContext } from '../core/types';

/** Half-size (m) of the orthographic shadow frustum around the focus point. */
const SHADOW_EXTENT = 90;
/** Distance (m) from the focus point to the moon light. */
const SHADOW_DISTANCE = 220;
/** Direction from the focus point towards the moon. */
const MOON_DIR = new THREE.Vector3(-0.45, 0.8, 0.4).normalize();

const BACKGROUND_COLOR = 0x10141c;

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
    const renderer = new THREE.WebGPURenderer({ antialias: quality.antialias, forceWebGL });
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
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = config.render.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const shadowsOn = quality.shadowMapSize > 0;
  renderer.shadowMap.enabled = shadowsOn;
  // WebGPURenderer maps PCFSoftShadowMap to PCFShadowMap (with a warning), so ask for PCF directly.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.touchAction = 'none';
  container.appendChild(canvas);

  // ---- scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND_COLOR);
  const fog = new THREE.FogExp2(BACKGROUND_COLOR, config.render.fogDensity);
  scene.fog = fog;

  // ---- camera
  const camera = new THREE.PerspectiveCamera(config.camera.fov, 1, config.camera.near, config.camera.far);

  // ---- lighting
  // Cool sky / dark warm ground so shapes stay readable in the blockout.
  const hemi = new THREE.HemisphereLight(0x6d86b8, 0x2a2118, 1.1);
  scene.add(hemi);

  // The moon.
  const sun = new THREE.DirectionalLight(0xbcd0ff, 2.2);
  sun.position.copy(MOON_DIR).multiplyScalar(SHADOW_DISTANCE);
  scene.add(sun);
  scene.add(sun.target);

  if (shadowsOn) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    const cam = sun.shadow.camera;
    cam.left = -SHADOW_EXTENT;
    cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT;
    cam.bottom = -SHADOW_EXTENT;
    cam.near = 10;
    cam.far = SHADOW_DISTANCE * 2;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.5;
  }

  // Two cheap warm sodium-style fills (no shadows) so the dark isn't flat.
  const fillA = new THREE.PointLight(0xff9a4a, 400, 120, 2);
  fillA.position.set(40, 12, 30);
  const fillB = new THREE.PointLight(0xff9a4a, 400, 120, 2);
  fillB.position.set(-50, 12, -40);
  scene.add(fillA, fillB);

  // ---- shadow focus (snapped to shadow texels to stop shimmering)
  const texelSize = shadowsOn ? (2 * SHADOW_EXTENT) / quality.shadowMapSize : 0;
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

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  window.visualViewport?.addEventListener('resize', resize);

  let disposed = false;

  return {
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
      fog.density = config.render.fogDensity;
      if (camera.fov !== config.camera.fov || camera.near !== config.camera.near || camera.far !== config.camera.far) {
        camera.fov = config.camera.fov;
        camera.near = config.camera.near;
        camera.far = config.camera.far;
        camera.updateProjectionMatrix();
      }
      try {
        renderer.render(scene, camera);
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
      canvas.remove();
      safeDispose(renderer);
    },
  };
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
