// Start-up: renderer, physics, game loop.
//
// Order per fixed 60 Hz tick: read input → Basalt.fixedUpdate → physics.step.
// Per rendered frame: interpolate Basalt, update follow camera, render, stats.

import * as THREE from 'three/webgpu';
import { config } from './config';
import { createLoop } from './core/loop';
import { createInput } from './core/input';
import { pickQuality, getQualityPreset, createAdaptiveQuality, showStoredToast } from './core/quality';
import { createRenderer, setBackendPreference, applyShadowFlags, reloadWithWebGL } from './render/renderer';
import { createPhysics } from './physics/world';
import { buildTown } from './city/town-layout';
import { buildingColliders } from './city/buildings';
import { createDestructionRenderer } from './destruction/piece-render';
import { createDestruction } from './destruction';
import { createBasalt } from './monster/basalt';
import { createFollowCamera } from './camera/follow-camera';
import { createDebugUI } from './debug/panel';
import { createRain } from './render/effects/rain';
import { createSplashes } from './render/effects/splashes';
import { createLightCones } from './render/effects/light-cones';
import { setWeatherLamps } from './render/effects/weather-common';
import type { FrameStats, InputSnapshot } from './core/types';

const loadingEl = document.getElementById('loading')!;

async function start() {
  const container = document.getElementById('app')!;

  const pick = await pickQuality();
  const quality = getQualityPreset(pick.level);
  config.render.renderScale = pick.renderScale;
  setBackendPreference(pick.preferWebGL);
  const adaptive = createAdaptiveQuality(pick.level, pick.forced);
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

  const town = buildTown(ctx.scene, physics, quality);
  town.group.traverse((o) => {
    const kind = o.userData.kind;
    if (kind === 'ground') applyShadowFlags(o, 'ground', quality);
    else if (kind === 'building') applyShadowFlags(o, 'city', quality);
  });

  const destructionRenderer = createDestructionRenderer(ctx.scene, town, quality);
  const destruction = createDestruction({
    physics, renderer: destructionRenderer, specs: town.specs, quality, buildingColliders,
  });

  const basalt = createBasalt(ctx.scene, physics, town.spawn, quality);
  applyShadowFlags(basalt.object, 'monster', quality);

  // Weather: rain and splashes are lit by the town's lamps; cones hang under them.
  setWeatherLamps(town.lampPositions, town.lampColors);
  const rain = createRain(ctx.scene, ctx.camera, quality);
  const splashes = createSplashes(ctx.scene, ctx.camera, quality);
  const cones = createLightCones(ctx.scene, town.lampPositions, town.lampColors, quality);

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
    gpu: pick.gpu,
    qualityReason: pick.reason,
    renderScale: config.render.renderScale,
    backendReason: pick.backendReason,
    inputDevice: 'keyboard',
    monsterSpeed: 0,
    activeChunks: 0,
    liveBonds: 0,
    awakeBuildings: 0,
    rubbleBodies: 0,
  };

  // Debug punch: preallocated so the loop never allocates.
  const punchCenter = new THREE.Vector3();
  const punchDir = new THREE.Vector3();
  let punchHeld = false;
  const punchAt = (x: number, y: number, z: number, dx = 0, dz = -1) => {
    punchCenter.set(x, y, z);
    punchDir.set(dx, 0, dz);
    destruction.applyDamage({
      shape: { kind: 'sphere', center: punchCenter, radius: config.destruction.punchRadius },
      damage: config.destruction.punchDamage,
      impulse: config.destruction.punchImpulse,
      direction: punchDir,
    });
  };

  const visualPos = new THREE.Vector3();

  const loop = createLoop({
    fixedUpdate(dt) {
      basalt.fixedUpdate(dt, snapshot, followCam.yaw);
      if (snapshot.punch && !punchHeld) {
        const h = basalt.heading;
        const fx = -Math.sin(h);
        const fz = -Math.cos(h);
        const reach = config.destruction.punchReach;
        punchAt(
          basalt.position.x + fx * reach,
          basalt.position.y + config.destruction.punchHeight,
          basalt.position.z + fz * reach,
          fx,
          fz,
        );
      }
      punchHeld = snapshot.punch;
      physics.step();
      destruction.fixedUpdate(dt);
      physicsMs += physics.stats().stepMs;
    },
    frame(frameDt, alpha, steps) {
      basalt.syncVisual(alpha);
      destruction.syncVisual(alpha);
      basalt.object.getWorldPosition(visualPos);

      // Read input after the steps so look deltas apply this frame; movement
      // intent feeds the next frame's fixed steps (≤ 1 frame of latency).
      snapshot = input.read(frameDt);
      const speed = Math.hypot(basalt.velocity.x, basalt.velocity.z);
      followCam.update(frameDt, visualPos, snapshot, basalt.heading, speed);

      rain.update(frameDt);
      splashes.update(frameDt);
      cones.update(frameDt, ctx.camera);

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
      const d = destruction.stats();
      stats.activeChunks = d.activeChunks;
      stats.liveBonds = d.liveBonds;
      stats.awakeBuildings = d.awakeBuildings;
      stats.rubbleBodies = d.rubbleBodies;
      debug.updateStats(stats);
      adaptive.frame(frameDt);
      stats.renderScale = config.render.renderScale;
      physicsMs = 0;
    },
  });

  loadingEl.remove();
  showStoredToast();
  loop.start();

  // Pause the simulation while the tab is hidden; resume cleanly.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) loop.stop();
    else loop.start();
  });

  // Handy from the browser console while tuning.
  Object.assign(window as unknown as Record<string, unknown>, { mb: { config, ctx, physics, basalt, town, destruction, punchAt, rain, splashes, cones } });
  console.info(
    `[Monster Brawl] ${ctx.backend.toUpperCase()} · quality ${quality.level} · ${town.buildingCount} buildings`,
  );
}

start().catch((err: unknown) => {
  console.error(err);
  loadingEl.classList.add('error');
  loadingEl.textContent = `Could not start Monster Brawl: ${err instanceof Error ? err.message : String(err)}`;
});
