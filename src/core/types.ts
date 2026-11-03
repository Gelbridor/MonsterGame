// Shared contracts between modules. Phase 1 modules are built against these
// interfaces so they can be developed independently and wired in main.ts.

import type * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';

// ---------------------------------------------------------------- quality

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  level: QualityLevel;
  /** devicePixelRatio cap. */
  pixelRatio: number;
  /** Shadow map size in px, or 0 for no shadow maps (blob shadows later). */
  shadowMapSize: number;
  /** Whether buildings/ground receive shadows (monster always casts if shadows on). */
  shadowsOnCity: boolean;
  antialias: boolean;
  /** Plan budgets (used from Phase 2). */
  maxActiveChunks: number;
  /** Multiplier on config.destruction.solverWorkPerStep (structural stress solver CPU per step). */
  solverWorkScale: number;
  maxParticles: number;

  // ---- graphics features (all scale down for phones)
  /** Cascaded shadow maps for the moon (else a single shadow map). */
  cascadedShadows: boolean;
  /** Post-processing chain. `enabled: false` = render straight to screen. */
  post: {
    enabled: boolean;
    bloom: boolean;
    /** Ground-truth ambient occlusion. */
    ao: boolean;
    /** Screen-space reflections (wet streets). */
    ssr: boolean;
    /** Anti-aliasing applied in post: temporal (TRAA), SMAA, FXAA or none. */
    aa: 'traa' | 'smaa' | 'fxaa' | 'none';
    /** Film grain, vignette, chromatic fringe and colour grade. */
    filmic: boolean;
    /** Internal resolution scale for expensive passes (AO / SSR), 0.25..1. */
    effectScale: number;
  };
  /** Number of real (shading) street/fire point lights allowed; others are emissive-only. */
  maxDynamicLights: number;
  /** Rain streak count (0 = no rain). */
  rainDrops: number;
  /** Procedural material detail: 0 = flat colours, 1 = basic noise, 2 = full (normals, wetness, puddles, interiors). */
  materialDetail: 0 | 1 | 2;
  /** Geometric detail on buildings and Basalt: 0 = boxes, 1 = medium, 2 = full. */
  geometryDetail: 0 | 1 | 2;
}

// ---------------------------------------------------------------- renderer

export type RenderBackend = 'webgpu' | 'webgl2';

export interface RenderContext {
  renderer: THREE.WebGPURenderer;
  /** Which backend actually initialised. */
  backend: RenderBackend;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  quality: QualityPreset;
  /** The moon light, so its shadow camera can follow the monster. */
  sun: THREE.DirectionalLight;
  render(): void;
  /** Keep the shadow frustum centred on a point (e.g. Basalt). */
  setShadowFocus(target: THREE.Vector3): void;
  /** Draw calls and triangles of the last rendered frame. */
  info(): { drawCalls: number; triangles: number };
  dispose(): void;
}

// ---------------------------------------------------------------- physics

export interface PhysicsStats {
  /** All rigid bodies in the world. */
  bodies: number;
  /** Dynamic bodies that are awake. */
  activeBodies: number;
  /** Live impulse joints. */
  joints: number;
  /** Colliders in the world. */
  colliders: number;
  /** Time spent in the last world.step() (ms). */
  stepMs: number;
}

export interface Physics {
  RAPIER: typeof RAPIER;
  world: RAPIER.World;
  /** Advance exactly one fixed step (config.physics.timestep). */
  step(): void;
  stats(): PhysicsStats;
  /** Create a fixed (static) box collider. Centre and half-extents in metres, optional yaw (rad). */
  addStaticBox(center: THREE.Vector3Like, halfExtents: THREE.Vector3Like, yaw?: number): RAPIER.Collider;
  /** Remove a collider made by addStaticBox together with its (single-collider) body. */
  removeStaticCollider(collider: RAPIER.Collider): void;
  /**
   * Call `cb` for every contact-force event of the last step() (colliders flagged with
   * CONTACT_FORCE_EVENTS), then clear them. Force components are world-space; magnitude is the
   * sum of the contact force magnitudes (N).
   */
  drainContactForces(cb: (handle1: number, handle2: number, fx: number, fy: number, fz: number, magnitude: number) => void): void;
}

// ---------------------------------------------------------------- input

export interface InputSnapshot {
  /** Movement intent, camera-relative. x = right, y = forward. Length <= 1, dead zone applied. */
  moveX: number;
  moveY: number;
  /** Camera look delta since the last read(), in radians. x = yaw (positive = turn right), y = pitch (positive = look down). */
  lookX: number;
  lookY: number;
  /** Run modifier held. */
  run: boolean;
  /** Punch button held (keyboard J, gamepad X, touch Punch). */
  punch: boolean;
  /** Which device produced the most recent input. */
  device: 'keyboard' | 'gamepad' | 'touch';
}

export interface Input {
  /** Read the current state. Consumes accumulated look deltas. `dt` is frame time (s) for stick-based look. */
  read(dt: number): InputSnapshot;
  /** Register a callback for the debug toggle (backtick key, gamepad Back/Select, three-finger tap). */
  onDebugToggle(cb: () => void): void;
  dispose(): void;
}

// ---------------------------------------------------------------- town

export interface Town {
  /** Root group with all town meshes. */
  group: THREE.Group;
  /** Where Basalt spawns (feet position, y = ground). */
  spawn: THREE.Vector3;
  /** Number of buildings generated. */
  buildingCount: number;
}

// ---------------------------------------------------------------- monster

export interface Monster {
  /** Visual root (capsule mesh etc.). Position = feet. */
  object: THREE.Object3D;
  /** Feet position after the last physics step. */
  readonly position: THREE.Vector3;
  /** Horizontal velocity (m/s) after the last physics step. */
  readonly velocity: THREE.Vector3;
  /** Facing angle (rad), 0 = facing -Z (Three.js forward), positive = counter-clockwise seen from above. */
  readonly heading: number;
  readonly grounded: boolean;
  /** Fixed-step update. `cameraYaw` is the follow camera's yaw so movement is camera-relative. */
  fixedUpdate(dt: number, input: InputSnapshot, cameraYaw: number): void;
  /** Interpolate visuals between the previous and current physics state (alpha 0..1). */
  syncVisual(alpha: number): void;
}

// ---------------------------------------------------------------- camera

export interface FollowCamera {
  /** Current yaw (rad), same convention as Monster.heading. */
  readonly yaw: number;
  /** Per-frame update (variable rate). `target` is the interpolated monster feet position. */
  update(dt: number, target: THREE.Vector3, input: InputSnapshot, monsterHeading: number, monsterSpeed: number): void;
}

// ---------------------------------------------------------------- debug

export interface FrameStats {
  fps: number;
  frameMs: number;
  physicsMs: number;
  physicsSteps: number;
  bodies: number;
  activeBodies: number;
  joints: number;
  colliders: number;
  drawCalls: number;
  triangles: number;
  backend: RenderBackend;
  quality: QualityLevel;
  inputDevice: InputSnapshot['device'];
  monsterSpeed: number;
  /** Phase 2 destruction: dynamic bodies alive (budget: quality.maxActiveChunks). */
  activeChunks: number;
  liveBonds: number;
  awakeBuildings: number;
  rubbleBodies: number;
}

export interface DebugUI {
  /** Show/hide the lil-gui tuning panel. */
  toggle(): void;
  /** Push fresh numbers to the stats overlay (call every frame; it throttles DOM writes itself). */
  updateStats(stats: FrameStats): void;
  dispose(): void;
}
