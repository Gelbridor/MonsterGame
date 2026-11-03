// Basalt: the first monster. A ~30 m lava-cored basalt beast built from merged rock
// chunks on a bone hierarchy (basalt-model.ts), shaded by a procedural wet-rock +
// lava-crack material (rock-material.ts) and animated procedurally with planted-foot
// IK (basalt-anim.ts). Movement is kinematic character-controller based with a
// heavy, slow-to-turn feel; the physics here is unchanged from the capsule stand-in.
//
// Angle conventions: heading 0 = facing -Z, positive = counter-clockwise from
// above (same as object.rotation.y). Forward(a) = (-sin a, 0, -cos a),
// right(a) = (cos a, 0, -sin a).

import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../config';
import { detectQuality, getQualityPreset } from '../core/quality';
import type { InputSnapshot, Monster, Physics, QualityPreset } from '../core/types';
import { BasaltAnimator, type FootstepEvent } from './basalt-anim';
import { createBasaltRig } from './basalt-model';
import { createGroundGlowMaterial } from './rock-material';

export type { FootstepEvent } from './basalt-anim';

/** Monster plus the animation hooks later phases use (camera shake, dust, stomp damage). */
export interface BasaltMonster extends Monster {
  /** Assign a callback: fired from the fixed step whenever a foot lands. */
  onFootstep: ((e: FootstepEvent) => void) | null;
  /** Footsteps since the last call (polling alternative to `onFootstep`). */
  drainFootsteps(): FootstepEvent[];
  /** Model statistics for the debug overlay. */
  readonly modelStats: { triangles: number; meshes: number; chunks: number; lights: number };
  /** Bone groups, e.g. to attach effects to the hands or mouth. */
  readonly bones: import('./basalt-model').BasaltRig['bones'];
}

/** Character controller skin offset (m). */
const CONTROLLER_OFFSET = 0.1;
/** Distance the controller snaps down to stay on slopes / steps (m). */
const SNAP_DISTANCE = 1;
const MAX_SLOPE = Math.PI / 4;
const TWO_PI = Math.PI * 2;

function wrapAngle(a: number): number {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/** Dev only: ?bmat=0|1|2 and ?bgeo=0|1|2 override Basalt's material / geometry detail. */
function withDebugOverrides(q: QualityPreset): QualityPreset {
  try {
    const params = new URLSearchParams(window.location.search);
    const m = params.get('bmat');
    const g = params.get('bgeo');
    if (m === null && g === null) return q;
    return {
      ...q,
      materialDetail: m !== null ? (Math.min(2, Math.max(0, Number(m))) as 0 | 1 | 2) : q.materialDetail,
      geometryDetail: g !== null ? (Math.min(2, Math.max(0, Number(g))) as 0 | 1 | 2) : q.geometryDetail,
    };
  } catch {
    return q;
  }
}

/**
 * @param quality quality preset (geometry / material detail, light budget). Defaults to
 *                the preset detected from the URL / device, so main.ts can omit it.
 */
export function createBasalt(
  scene: THREE.Scene,
  physics: Physics,
  spawn: THREE.Vector3,
  qualityIn: QualityPreset = getQualityPreset(detectQuality()),
): BasaltMonster {
  const quality = withDebugOverrides(qualityIn);
  const { RAPIER: R, world } = physics;
  const height = config.monster.height;
  const radius = config.monster.radius;
  const halfHeight = Math.max(0.01, (height - 2 * radius) / 2);

  // ------------------------------------------------------------- physics
  const body: RAPIER.RigidBody = world.createRigidBody(
    R.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + height / 2, spawn.z),
  );
  const collider: RAPIER.Collider = world.createCollider(R.ColliderDesc.capsule(halfHeight, radius), body);

  const controller = world.createCharacterController(CONTROLLER_OFFSET);
  controller.setUp({ x: 0, y: 1, z: 0 });
  controller.setSlideEnabled(true);
  controller.enableAutostep(config.monster.stepHeight, 0.5, false);
  controller.enableSnapToGround(SNAP_DISTANCE);
  controller.setMaxSlopeClimbAngle(MAX_SLOPE);
  controller.setApplyImpulsesToDynamicBodies(true);
  controller.setCharacterMass(config.monster.mass);

  // ------------------------------------------------------------- state
  const position = new THREE.Vector3().copy(spawn);
  const prevPosition = new THREE.Vector3().copy(spawn);
  const velocity = new THREE.Vector3();
  let heading = 0;
  let prevHeading = 0;
  let speed = 0; // horizontal speed along heading (>= 0)
  let verticalVel = 0;
  let grounded = false;
  let turnGap = 0;

  const desired = new THREE.Vector3();

  // ------------------------------------------------------------- visual
  const object = new THREE.Group();
  object.name = 'Basalt';
  object.userData.kind = 'monster';
  object.position.copy(spawn);

  // The model (feet at the root origin, facing -Z) hangs off `object`, so the root
  // stays exactly on the interpolated physics position. The animator moves the bones.
  const rig = createBasaltRig(quality);
  object.add(rig.root);
  const anim = new BasaltAnimator(rig);

  // Lava light: warm, flickering, parented to the chest. 0 on low, 1 medium/high, 2 on ultra.
  const wanted = quality.level === 'low' ? 0 : quality.level === 'ultra' ? 2 : 1;
  const lightCount = Math.min(wanted, quality.maxDynamicLights);
  const lights: THREE.PointLight[] = [];
  const lightBase = [700, 320];
  const lightColor = [0xff6a22, 0xff4a12];
  const lightPos: [number, number, number][] = [
    [0, 2.5, -10],
    [0, -2.0, -8],
  ];
  for (let i = 0; i < lightCount; i++) {
    const l = new THREE.PointLight(lightColor[i], lightBase[i], i === 0 ? 150 : 90, 2);
    l.position.set(...lightPos[i]);
    l.castShadow = false;
    (i === 0 ? rig.bones.chest : rig.bones.pelvis).add(l);
    lights.push(l);
  }

  // Ground glow: additive lava-light pool under the monster (the whole story on low tiers).
  const glow = createGroundGlowMaterial();
  const glowMesh = new THREE.Mesh(new THREE.PlaneGeometry(46, 46), glow.material);
  glowMesh.rotation.x = -Math.PI / 2;
  glowMesh.position.y = 0.15;
  glowMesh.renderOrder = 2;
  glowMesh.frustumCulled = false;
  // main.ts flags every mesh under `object` as a shadow caster; a ground decal must never cast.
  Object.defineProperty(glowMesh, 'castShadow', { get: () => false, set: () => {} });
  Object.defineProperty(glowMesh, 'receiveShadow', { get: () => false, set: () => {} });
  glow.intensity.value = quality.level === 'low' ? 1.0 : 0.7;
  object.add(glowMesh);

  scene.add(object);

  // ------------------------------------------------------------- update
  function fixedUpdate(dt: number, input: InputSnapshot, cameraYaw: number): void {
    const m = config.monster;

    // Camera-relative desired direction.
    const fx = -Math.sin(cameraYaw);
    const fz = -Math.cos(cameraYaw);
    const rx = Math.cos(cameraYaw);
    const rz = -Math.sin(cameraYaw);
    const dx = fx * input.moveY + rx * input.moveX;
    const dz = fz * input.moveY + rz * input.moveX;
    const mag = Math.min(1, Math.hypot(input.moveX, input.moveY));

    prevPosition.copy(position);
    prevHeading = heading;

    // Turn towards the desired direction, capped at turnSpeed.
    let targetSpeed = 0;
    turnGap = 0;
    if (mag > 0.01) {
      const desiredHeading = Math.atan2(-dx, -dz);
      const gap = wrapAngle(desiredHeading - heading);
      turnGap = gap;
      const maxTurn = m.turnSpeed * dt;
      heading = wrapAngle(heading + Math.max(-maxTurn, Math.min(maxTurn, gap)));
      // Slow down while the heading is far from where the player wants to go,
      // so Basalt pivots on the spot rather than running in wide circles.
      const remaining = wrapAngle(desiredHeading - heading);
      targetSpeed = mag * (input.run ? m.runSpeed : m.walkSpeed) * Math.max(0, Math.cos(remaining));
    }

    // Ease horizontal speed (heavy feel).
    const rate = targetSpeed > speed ? m.acceleration : m.deceleration;
    const dv = targetSpeed - speed;
    speed += Math.max(-rate * dt, Math.min(rate * dt, dv));

    // Vertical: gravity while airborne.
    if (grounded) verticalVel = 0;
    else verticalVel -= config.physics.gravity * config.physics.gravityScale * dt;

    desired.set(-Math.sin(heading) * speed * dt, verticalVel * dt, -Math.cos(heading) * speed * dt);

    controller.enableAutostep(m.stepHeight, 0.5, false);
    controller.computeColliderMovement(collider, desired);
    const mv = controller.computedMovement();
    grounded = controller.computedGrounded();

    // Where the body will be after the world step.
    const t = body.translation();
    body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });
    position.set(position.x + mv.x, position.y + mv.y, position.z + mv.z);

    velocity.set(mv.x / dt, 0, mv.z / dt);
    // If we got blocked, don't keep building up phantom speed.
    const actual = Math.hypot(velocity.x, velocity.z);
    if (actual < speed * 0.5) speed = actual;

    // Procedural animation state (gait, feet, springs) advances on the fixed step.
    anim.step(dt, {
      position,
      heading,
      velocity,
      turnGap,
      walkSpeed: m.walkSpeed,
      runSpeed: m.runSpeed,
      turnSpeed: m.turnSpeed,
      grounded,
    });
  }

  const flicker = { t: 0 };

  function syncVisual(alpha: number): void {
    object.position.lerpVectors(prevPosition, position, alpha);
    object.rotation.y = lerpAngle(prevHeading, heading, alpha);
    object.updateMatrixWorld();

    anim.apply(alpha, object.position, object.rotation.y);

    // Lava reacts to breathing / exertion; rain wets the rock.
    const pulse = anim.pulse;
    rig.material.pulse.value = pulse;
    rig.material.heat.value = anim.heat;
    rig.material.wet.value = Math.min(1, Math.max(0, config.weather.rain));
    flicker.t += 1 / 60;
    const fl = 0.93 + 0.07 * Math.sin(flicker.t * 11.3) * Math.sin(flicker.t * 7.1 + 1.3);
    for (let i = 0; i < lights.length; i++) lights[i].intensity = lightBase[i] * (0.72 + 0.28 * pulse) * fl;
    glow.intensity.value = (quality.level === 'low' ? 1.0 : 0.7) * (0.75 + 0.25 * pulse) * fl;
  }

  return {
    object,
    position,
    velocity,
    get heading() {
      return heading;
    },
    get grounded() {
      return grounded;
    },
    fixedUpdate,
    syncVisual,
    get onFootstep() {
      return anim.onFootstep;
    },
    set onFootstep(cb) {
      anim.onFootstep = cb;
    },
    drainFootsteps: () => anim.drainFootsteps(),
    modelStats: { ...rig.stats, lights: lightCount },
    bones: rig.bones,
  };
}
