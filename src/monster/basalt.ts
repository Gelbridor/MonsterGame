// Basalt: the first monster. Phase 1 is a 30 m capsule stand-in with glowing
// lava cracks, a face marker, kinematic character-controller movement with a
// heavy, slow-to-turn feel, and a procedural walk bob / lean.
//
// Angle conventions: heading 0 = facing -Z, positive = counter-clockwise from
// above (same as object.rotation.y). Forward(a) = (-sin a, 0, -cos a),
// right(a) = (cos a, 0, -sin a).

import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../config';
import type { InputSnapshot, Monster, Physics } from '../core/types';

/** Character controller skin offset (m). */
const CONTROLLER_OFFSET = 0.1;
/** Distance the controller snaps down to stay on slopes / steps (m). */
const SNAP_DISTANCE = 1;
const MAX_SLOPE = Math.PI / 4;
/** Distance covered per full bob cycle (two footfalls), in metres. */
const STRIDE_LENGTH = 22;
const MAX_LEAN = 0.16;

const TWO_PI = Math.PI * 2;

function wrapAngle(a: number): number {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

export function createBasalt(scene: THREE.Scene, physics: Physics, spawn: THREE.Vector3): Monster {
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
  let stridePhase = 0;
  let prevStridePhase = 0;
  let lean = 0;
  let prevLean = 0;

  const desired = new THREE.Vector3();

  // ------------------------------------------------------------- visual
  const object = new THREE.Group();
  object.name = 'Basalt';
  object.userData.kind = 'monster';
  object.position.copy(spawn);

  // Everything visible hangs off `bodyGroup` (origin = feet) so bob/lean never
  // moves the root, which stays exactly on the interpolated physics position.
  const bodyGroup = new THREE.Group();
  object.add(bodyGroup);

  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x2b2623,
    roughness: 0.9,
    metalness: 0.05,
    flatShading: true,
  });
  const lavaMat = new THREE.MeshStandardMaterial({
    color: 0x330a00,
    emissive: new THREE.Color(0xff4a1a),
    emissiveIntensity: 2.5,
    roughness: 0.6,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x331100,
    emissive: new THREE.Color(0xffb020),
    emissiveIntensity: 4,
    roughness: 0.4,
  });

  const cylLength = height - 2 * radius;
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(radius, cylLength, 6, 12), rockMat);
  torso.position.y = height / 2;
  bodyGroup.add(torso);

  // Lava cracks: tilted glowing rings around the cylinder part...
  const ringHeights = [0.12, 0.3, 0.5, 0.68, 0.86];
  ringHeights.forEach((f, i) => {
    const y = radius + cylLength * f;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius + 0.05, 0.22 + (i % 2) * 0.1, 5, 24), lavaMat);
    ring.rotation.x = Math.PI / 2 + (i % 2 ? 0.12 : -0.1);
    ring.rotation.z = i * 0.7;
    ring.position.y = y;
    bodyGroup.add(ring);
  });
  // ...and a few vertical seams.
  for (let i = 0; i < 4; i++) {
    const a = i * (TWO_PI / 4) + 0.5;
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.35, cylLength * (0.5 + 0.12 * i), 0.3), lavaMat);
    seam.position.set(Math.cos(a) * (radius + 0.03), radius + cylLength * 0.5, Math.sin(a) * (radius + 0.03));
    seam.rotation.y = -a;
    bodyGroup.add(seam);
  }

  // Face on the -Z side near the top: glowing eyes, brow ridge and a jutting jaw.
  const headCentreY = height - radius;
  for (const side of [-1, 1]) {
    const az = side * 0.32;
    const elev = 0.3;
    const nx = Math.cos(elev) * Math.sin(az);
    const nz = -Math.cos(elev) * Math.cos(az);
    const eye = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.5, 0.6), eyeMat);
    eye.position.set(nx * (radius + 0.05), headCentreY + Math.sin(elev) * radius, nz * (radius + 0.05));
    eye.rotation.y = Math.atan2(nx, nz);
    bodyGroup.add(eye);
  }
  const brow = new THREE.Mesh(new THREE.BoxGeometry(radius * 1.7, 0.9, 1.6), rockMat);
  brow.position.set(0, headCentreY + radius * 0.42, -radius * 0.82);
  bodyGroup.add(brow);
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(radius * 1.1, 1.4, 2.6), rockMat);
  jaw.position.set(0, headCentreY - radius * 0.2, -radius * 0.95);
  bodyGroup.add(jaw);

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
    prevStridePhase = stridePhase;
    prevLean = lean;

    // Turn towards the desired direction, capped at turnSpeed.
    let targetSpeed = 0;
    if (mag > 0.01) {
      const desiredHeading = Math.atan2(-dx, -dz);
      const gap = wrapAngle(desiredHeading - heading);
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
    // Keep a small downward push while grounded so the controller keeps
    // detecting the ground every tick (zero vertical movement makes
    // computedGrounded() flicker).
    if (grounded) verticalVel = -2;
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

    // Procedural animation state.
    stridePhase += (actual / STRIDE_LENGTH) * TWO_PI * dt;
    const leanTarget = Math.min(1, Math.max(0, (actual - m.walkSpeed) / Math.max(0.1, m.runSpeed - m.walkSpeed))) * MAX_LEAN;
    lean += (leanTarget - lean) * (1 - Math.exp(-5 * dt));
  }

  function syncVisual(alpha: number): void {
    object.position.lerpVectors(prevPosition, position, alpha);
    object.rotation.y = lerpAngle(prevHeading, heading, alpha);

    const phase = prevStridePhase + (stridePhase - prevStridePhase) * alpha;
    const l = prevLean + (lean - prevLean) * alpha;
    const moveAmt = Math.min(1, Math.hypot(velocity.x, velocity.z) / Math.max(0.1, config.monster.walkSpeed));
    // Footfall bob (two per cycle), a slight side-to-side sway, forward lean.
    bodyGroup.position.y = Math.abs(Math.sin(phase * 2)) * 0.5 * moveAmt;
    bodyGroup.rotation.z = Math.sin(phase * 2 + Math.PI / 2) * 0.03 * moveAmt;
    // Forward is -Z, so a negative rotation about X tips the head towards it.
    bodyGroup.rotation.x = -(l + Math.sin(phase * 4) * 0.01 * moveAmt);
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
  };
}
