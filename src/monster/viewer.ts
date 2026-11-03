// Dev-only Basalt viewer (open /src/monster/viewer.html?webgl&quality=ultra).
// Runs the real createBasalt on a flat ground without the city, and exposes
// window.mb.sim(seconds, forward, run, turn) / mb.view(name) so a headless script
// can render deterministic frames (software WebGL is slow; sim steps are free).

import * as THREE from 'three/webgpu';
import { config } from '../config';
import { detectQuality, getQualityPreset } from '../core/quality';
import { createPhysics } from '../physics/world';
import { applyShadowFlags } from '../render/renderer';
import { createBasalt } from './basalt';

async function main() {
  const quality = getQualityPreset(detectQuality());
  const container = document.getElementById('app')!;
  const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: true });
  await renderer.init();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = quality.shadowMapSize > 0;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10141c);
  scene.fog = new THREE.FogExp2(0x10141c, config.render.fogDensity);
  scene.add(new THREE.HemisphereLight(0x6d86b8, 0x2a2118, 1.1));
  const sun = new THREE.DirectionalLight(0xbcd0ff, 2.2);
  const moonDir = new THREE.Vector3(-0.45, 0.8, 0.4).normalize();
  scene.add(sun, sun.target);
  if (quality.shadowMapSize > 0) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -90;
    c.right = 90;
    c.top = 90;
    c.bottom = -90;
    c.near = 10;
    c.far = 440;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.5;
  }

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.55 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(300, 30, 0x667788, 0x2a3038);
  grid.position.y = 0.03;
  scene.add(grid);
  // A few reference pillars (10 m) so scale is visible.
  for (const [x, z] of [[-30, 60]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(4, 10, 4), new THREE.MeshStandardMaterial({ color: 0x555a66 }));
    m.position.set(x, 5, z);
    scene.add(m);
  }

  const physics = await createPhysics();
  physics.addStaticBox({ x: 0, y: -1, z: 0 }, { x: 300, y: 1, z: 300 });
  const basalt = createBasalt(scene, physics, new THREE.Vector3(0, 0, 0), quality);
  applyShadowFlags(basalt.object, 'monster', quality);

  const camera = new THREE.PerspectiveCamera(config.camera.fov, window.innerWidth / window.innerHeight, 0.5, 2000);

  const input = { moveX: 0, moveY: 0, lookX: 0, lookY: 0, run: false, punch: false, device: 'keyboard' as const };
  const dt = config.physics.timestep;
  let simTime = 0;

  function sim(seconds: number, forward = 0, run = false, turn = 0): void {
    input.moveY = forward;
    input.moveX = turn;
    input.run = run;
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) {
      basalt.fixedUpdate(dt, input, 0);
      physics.step();
      simTime += dt;
    }
    basalt.syncVisual(1);
  }

  const target = new THREE.Vector3();
  /** The real default gameplay camera (config.camera) behind and above Basalt. */
  function gameCam(): void {
    const c = config.camera;
    camera.fov = c.fov;
    camera.updateProjectionMatrix();
    const p = basalt.object.position;
    const h = basalt.heading;
    target.set(p.x, p.y + c.lookAtHeight, p.z);
    const dir = new THREE.Vector3(0, Math.sin(c.pitch), Math.cos(c.pitch));
    dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), h);
    camera.position.copy(target).addScaledVector(dir, c.distance);
    camera.lookAt(target);
    basalt.object.updateMatrixWorld(true);
    sun.target.position.copy(p);
    sun.position.copy(p).addScaledVector(moonDir, 220);
    sun.target.updateMatrixWorld();
    renderer.render(scene, camera);
  }
  function view(name: string, dist = 60, lookH = 14, fov = 45): void {
    camera.fov = fov;
    camera.updateProjectionMatrix();
    const p = basalt.object.position;
    const h = basalt.heading;
    // Camera offsets are in the monster's own frame (x right, z back).
    const o: Record<string, [number, number, number]> = {
      front: [0, 0.18, -1],
      back: [0, 0.3, 1],
      right: [1, 0.12, 0],
      left: [-1, 0.12, 0],
      three: [-0.75, 0.2, -0.65],
      threeR: [0.75, 0.2, -0.65],
      top: [0, 1, 0.001],
      game: [0, 0.62, 1],
    };
    const v = o[name] ?? o.three;
    const dir = new THREE.Vector3(v[0], v[1], v[2]).normalize();
    dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), h);
    target.set(p.x, p.y + lookH, p.z);
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.lookAt(target);
    basalt.object.updateMatrixWorld(true);
    sun.target.position.copy(p);
    sun.position.copy(p).addScaledVector(moonDir, 220);
    sun.target.updateMatrixWorld();
    renderer.render(scene, camera);
  }

  function fixed(cx: number, cy: number, cz: number, tx: number, ty: number, tz: number, fov = 40): void {
    camera.fov = fov;
    camera.updateProjectionMatrix();
    camera.position.set(cx, cy, cz);
    camera.lookAt(tx, ty, tz);
    const p = basalt.object.position;
    sun.target.position.copy(p);
    sun.position.copy(p).addScaledVector(moonDir, 220);
    sun.target.updateMatrixWorld();
    renderer.render(scene, camera);
  }

  Object.assign(window, { mb: { config, basalt, physics, sim, view, gameCam, fixed, time: () => simTime, renderer } });
  sim(0.2);
  view('three');
}

main().catch((e) => {
  console.error(e);
});
