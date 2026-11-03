// Phase 2 contracts between the destruction simulation (physics side) and the
// destruction visuals (fracture + rendering side). Both sides build against
// these interfaces; main.ts wires them together.
//
// Design (see plan.md "Destruction system"; adapted because Rapier 0.21 exposes
// no joint force read-back):
// - A building is a graph of box PIECES (columns, slabs, wall panels, windows,
//   roof) linked by BONDS. Bonds are our breakable joints.
// - While a building is untouched it stays the merged town mesh + its static
//   box colliders ("asleep"). A hit within range WAKES it: the merged visuals
//   for that building are hidden and its pieces take over.
// - Each connected group of pieces is one Rapier rigid body (a compound of box
//   colliders, true mass). A group still bonded to the ground is fixed; when
//   bonds break and a group loses its ground path it becomes DYNAMIC and falls
//   under real gravity. Groups split again as bonds break in flight/landing.
// - Bond STRESS is real weight: each step (or when the graph changes) the load
//   each bond carries is computed from the masses it supports (vertical load)
//   and the moment of overhanging mass about it (bending). Impact forces come
//   from Rapier contact-force events. Load > strength => bond breaks.
// - A piece at 0 health detaches and is fractured into SHARDS (pre-split
//   convex cells), which become debris bodies. Debris sleeps, then is merged
//   into static rubble.

import type * as THREE from 'three/webgpu';

export type DMaterial = 'concrete' | 'brick' | 'stone' | 'glass' | 'steel' | 'wood';

export type PieceKind = 'column' | 'slab' | 'wall' | 'window' | 'roof' | 'beam';

/** One box piece of a building, in the building's local frame (x along width, z along depth, y up, base y = 0). */
export interface PieceDef {
  index: number;
  kind: PieceKind;
  material: DMaterial;
  /** Centre in building-local metres. */
  center: [number, number, number];
  halfExtents: [number, number, number];
  /** kg (density x volume). */
  mass: number;
  maxHealth: number;
  /** Floor index (0 = ground floor), for effects/LOD. */
  floor: number;
  /** Seed for deterministic fracture of this piece. */
  seed: number;
}

/** A breakable bond between two pieces, or between a piece and the ground (b = -1). */
export interface BondDef {
  a: number;
  b: number;
  /** Contact patch centre, building-local. */
  anchor: [number, number, number];
  /** Contact area (m^2); strength scales with it. */
  area: number;
  /** Max compressive/tensile force (N) before breaking. */
  maxForce: number;
  /** Max bending moment (N*m) before breaking. */
  maxMoment: number;
}

export interface BuildingGraph {
  specId: number;
  /** World placement of the building frame. */
  x: number;
  z: number;
  yaw: number;
  pieces: PieceDef[];
  bonds: BondDef[];
}

// ---------------------------------------------------------------- fracture

/** One convex cell of a fractured piece. */
export interface Shard {
  /** Shard centroid in piece-local metres. */
  center: [number, number, number];
  /** Convex hull points relative to `center` (xyz triplets), for a Rapier convexHull collider. */
  hull: Float32Array;
  /** m^3 (mass = volume x density). */
  volume: number;
}

export interface FractureResult {
  shards: Shard[];
  /** Opaque id the renderer uses to draw these shards (geometry cached by the renderer). */
  geometryKey: string;
}

// ---------------------------------------------------------------- rendering

/** Handle to something the destruction renderer draws (a piece, or a shard). */
export type RenderHandle = number;

/**
 * Implemented by the visuals side (src/destruction/piece-render.ts).
 * The simulation calls it; it never touches Three.js scene objects itself.
 * Transforms are world-space and set every frame (interpolated) by the simulation.
 */
export interface DestructionRenderer {
  /** Hide the building's merged town visuals (it has woken and its pieces take over). */
  hideBuilding(specId: number): void;
  /** Create the visual for an intact piece of a woken building. */
  addPiece(graph: BuildingGraph, piece: PieceDef): RenderHandle;
  /** Pre-split a piece into 4..12 convex shards (deterministic from piece.seed). Called at wake time or on demand. */
  fracture(piece: PieceDef, count: number): FractureResult;
  /** Create the visual for one shard of a fractured piece. */
  addShard(piece: PieceDef, fracture: FractureResult, shardIndex: number): RenderHandle;
  /** World transform of a handle (position, quaternion). Called each frame for awake things only. */
  setTransform(h: RenderHandle, pos: THREE.Vector3Like, quat: { x: number; y: number; z: number; w: number }): void;
  /** 0..1 accumulated damage (crack/darkening look). */
  setDamage(h: RenderHandle, damage01: number): void;
  remove(h: RenderHandle): void;
  /** Bake these (now at rest) handles into static rubble geometry and stop drawing them individually. */
  bakeToRubble(handles: RenderHandle[]): void;
  /** Per-frame upkeep (upload instance buffers etc.). */
  update(): void;
  stats(): { liveHandles: number; rubbleTriangles: number };
}

// ---------------------------------------------------------------- damage

export type DamageShape =
  | { kind: 'sphere'; center: THREE.Vector3Like; radius: number }
  | { kind: 'ring'; center: THREE.Vector3Like; radius: number; height: number }
  | { kind: 'capsule'; a: THREE.Vector3Like; b: THREE.Vector3Like; radius: number };

export interface DamageEvent {
  shape: DamageShape;
  /** Health removed at the centre; falls off with distance. */
  damage: number;
  /** Impulse (N*s) applied to detached pieces, directed away from the centre (plus `direction` if given). */
  impulse: number;
  direction?: THREE.Vector3Like;
}

export interface DestructionStats {
  awakeBuildings: number;
  /** Dynamic destruction bodies currently awake (budget: quality.maxActiveChunks). */
  activeChunks: number;
  liveBonds: number;
  rubbleBodies: number;
}

/** Implemented by the simulation side (src/destruction/index.ts). */
export interface Destruction {
  applyDamage(ev: DamageEvent): void;
  /** Fixed-step update, called right after physics.step(). */
  fixedUpdate(dt: number): void;
  /** Per-frame visual sync (interpolate bodies by alpha, push transforms to the renderer). */
  syncVisual(alpha: number): void;
  stats(): DestructionStats;
}
