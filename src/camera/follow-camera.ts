// Third-person follow camera.
//
// Orbits a look-at point (monster feet + lookAtHeight). Yaw/pitch come straight
// from player input (no smoothing, direct feels better); only the look-at point
// is smoothed. When the player is running forward and hasn't touched the look
// controls for a moment, yaw eases round to sit behind the monster again.
//
// Angle conventions: yaw 0 = looking toward -Z. Forward(a) = (-sin a, 0, -cos a),
// so the camera sits at lookAt - forward * cos(pitch) * d + up * sin(pitch) * d.

import * as THREE from 'three/webgpu';
import { config } from '../config';
import type { FollowCamera, InputSnapshot } from '../core/types';

/** Seconds without look input before auto-follow kicks in. */
const AUTO_FOLLOW_DELAY = 1.5;
/** Monster speed (m/s) above which auto-follow applies. */
const AUTO_FOLLOW_MIN_SPEED = 1;
/** Camera never drops below this height (m). */
const MIN_CAMERA_Y = 2;

const TWO_PI = Math.PI * 2;

function wrapAngle(a: number): number {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

export function createFollowCamera(camera: THREE.PerspectiveCamera): FollowCamera {
  let yaw = 0;
  let pitch = clampPitch(config.camera.pitch);
  let initialised = false;
  let lookIdle = AUTO_FOLLOW_DELAY; // seconds since last look input

  const lookAt = new THREE.Vector3();
  const desiredLookAt = new THREE.Vector3();

  let appliedFov = NaN;
  let appliedNear = NaN;
  let appliedFar = NaN;

  function clampPitch(p: number): number {
    return Math.min(config.camera.maxPitch, Math.max(config.camera.minPitch, p));
  }

  function syncLens(): void {
    const c = config.camera;
    if (c.fov !== appliedFov || c.near !== appliedNear || c.far !== appliedFar) {
      camera.fov = c.fov;
      camera.near = c.near;
      camera.far = c.far;
      camera.updateProjectionMatrix();
      appliedFov = c.fov;
      appliedNear = c.near;
      appliedFar = c.far;
    }
  }

  return {
    get yaw() {
      return yaw;
    },

    update(dt: number, target: THREE.Vector3, input: InputSnapshot, monsterHeading: number, monsterSpeed: number): void {
      const c = config.camera;
      syncLens();

      desiredLookAt.set(target.x, target.y + c.lookAtHeight, target.z);

      if (!initialised) {
        // First frame: snap straight behind the monster, no smoothing.
        initialised = true;
        yaw = wrapAngle(monsterHeading);
        lookAt.copy(desiredLookAt);
      }

      // --- player look input (already radians). lookX > 0 = turn view right = yaw decreases.
      yaw -= input.lookX;
      pitch = clampPitch(pitch + input.lookY);
      if (Math.abs(input.lookX) > 1e-5 || Math.abs(input.lookY) > 1e-5) lookIdle = 0;
      else lookIdle += dt;

      // --- auto-follow: swing behind the monster while it moves forward.
      // Weighted by the forward component of the stick so walking backwards or
      // strafing does not make the camera chase the heading round in circles.
      if (c.autoFollowStrength > 0 && lookIdle >= AUTO_FOLLOW_DELAY && monsterSpeed > AUTO_FOLLOW_MIN_SPEED) {
        const forwardness = Math.max(0, input.moveY);
        const speedFrac = Math.min(1, monsterSpeed / Math.max(0.001, config.monster.runSpeed));
        const rate = c.autoFollowStrength * speedFrac * forwardness;
        const gap = wrapAngle(monsterHeading - yaw);
        yaw += gap * (1 - Math.exp(-rate * dt));
      }
      yaw = wrapAngle(yaw);

      // --- smooth the look-at point (frame-rate independent).
      const k = 1 - Math.exp(-c.followSharpness * dt);
      lookAt.lerp(desiredLookAt, k);

      // --- position: behind (relative to yaw) and above.
      // PHASE-2 HOOK: pull-back on collapses (scale `dist`), screen shake (add an
      // offset to the final position / look-at) and slow-motion FOV punch go here.
      const dist = c.distance;
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      camera.position.set(
        lookAt.x - fx * cosP * dist,
        Math.max(MIN_CAMERA_Y, lookAt.y + sinP * dist),
        lookAt.z - fz * cosP * dist,
      );
      camera.lookAt(lookAt);
    },
  };
}
