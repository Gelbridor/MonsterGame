// Start-up: renderer, physics, game loop.
//
// Order per fixed 60 Hz tick: read input → Basalt.fixedUpdate → physics.step.
// Per rendered frame: interpolate Basalt, update follow camera, render, stats.

import * as THREE from 'three/webgpu';
import { config } from './config';
import { createLoop } from './core/loop';
import { createInput } from './core/input';
import { detectQuality, getQualityPreset } from './core/quality';
import { createRenderer, applyShadowFlags, reloadWithWebGL } from './render/renderer';
import { createPhysics } from './physics/world';
import { buildTown } from './city/town-layout';
import { createBasalt } from './monster/basalt';
import { createFollowCamera } from './camera/follow-camera';
import { createDebugUI } from './debug/panel';
import type { FrameStats, InputSnapshot } from './core/types';

const loadingEl = document.getElementById('loading')!;

async function start() {
  const container = document.getElementById('app')!;

  const quality = getQualityPreset(detectQuality());
  config.render.maxPixelRatio = quality.pixelRatio;

  // Renderer and physics initialise in parallel (WebGPU adapter + Rapier wasm).
  const [ctx, physics] = await Promise.all([createRenderer(container, quality), createPhysics()]);

  // WebGPU errors after start-up arrive as uncaught async errors, not from
  // render(). If one hits, fall back to WebGL 2 instead of a blank canvas.
  if (ctx.backend === 'webgpu') {
    const isGpuError = (e: unknown) => /GPU|WebGPU|createBuffer|Instance dropped/i.test(String(e));
    window.addEventListener('error', (ev) => {
      if (isGpuError(ev.message)) reloadWithWebGL(ev.message);
    });
    window.addEventListener('unhandledrejection', (ev) => {
      if (isGpuError(ev.reason)) reloadWithWebGL(ev.reason);
    });
  }

  const town = buildTown(ctx.scene, physics);
  town.group.traverse((o) => {
    const kind = o.userData.kind;
    if (kind === 'ground') applyShadowFlags(o, 'ground', quality);
    else if (kind === 'building') applyShadowFlags(o, 'city', quality);
  });

  const basalt = createBasalt(ctx.scene, physics, town.spawn, quality);
  applyShadowFlags(basalt.object, 'monster', quality);

  const followCam = createFollowCamera(ctx.camera);
  const input = createInput(container);
  const debug = createDebugUI(config, {
    onRestartRequired: (key) => console.warn(`[config] ${key} changed: reload the page to apply.`),
  });
  input.onDebugToggle(() => debug.toggle());

  // Latest input, read once per rendered frame and reused by every fixed step in that frame.
  let snapshot: InputSnapshot = input.read(0);
  let physicsMs = 0;

  const stats: FrameStats = {
    fps: 0,
    frameMs: 0,
    physicsMs: 0,
    physicsSteps: 0,
    bodies: 0,
    activeBodies: 0,
    joints: 0,
    colliders: 0,
    drawCalls: 0,
    triangles: 0,
    backend: ctx.backend,
    quality: quality.level,
    inputDevice: 'keyboard',
    monsterSpeed: 0,
  };

  const visualPos = new THREE.Vector3();

  const loop = createLoop({
    fixedUpdate(dt) {
      basalt.fixedUpdate(dt, snapshot, followCam.yaw);
      physics.step();
      physicsMs += physics.stats().stepMs;
    },
    frame(frameDt, alpha, steps) {
      basalt.syncVisual(alpha);
      basalt.object.getWorldPosition(visualPos);

      // Read input after the steps so look deltas apply this frame; movement
      // intent feeds the next frame's fixed steps (≤ 1 frame of latency).
      snapshot = input.read(frameDt);
      const speed = Math.hypot(basalt.velocity.x, basalt.velocity.z);
      followCam.update(frameDt, visualPos, snapshot, basalt.heading, speed);

      ctx.setShadowFocus(visualPos);
      ctx.render();

      const p = physics.stats();
      const r = ctx.info();
      stats.fps = frameDt > 0 ? 1 / frameDt : 0;
      stats.frameMs = frameDt * 1000;
      stats.physicsMs = physicsMs;
      stats.physicsSteps = steps;
      stats.bodies = p.bodies;
      stats.activeBodies = p.activeBodies;
      stats.joints = p.joints;
      stats.colliders = p.colliders;
      stats.drawCalls = r.drawCalls;
      stats.triangles = r.triangles;
      stats.inputDevice = snapshot.device;
      stats.monsterSpeed = speed;
      debug.updateStats(stats);
      physicsMs = 0;
    },
  });

  loadingEl.remove();
  loop.start();

  // Pause the simulation while the tab is hidden; resume cleanly.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) loop.stop();
    else loop.start();
  });

  // Handy from the browser console while tuning.
  Object.assign(window as unknown as Record<string, unknown>, { mb: { config, ctx, physics, basalt, town } });
  console.info(
    `[Monster Brawl] ${ctx.backend.toUpperCase()} · quality ${quality.level} · ${town.buildingCount} buildings`,
  );
}

start().catch((err: unknown) => {
  console.error(err);
  loadingEl.classList.add('error');
  loadingEl.textContent = `Could not start Monster Brawl: ${err instanceof Error ? err.message : String(err)}`;
});
