// Rapier set-up: world, fixed step, stats, static box helper.

import RAPIER from '@dimforge/rapier3d-compat';
import type { Physics, PhysicsStats } from '../core/types';
import { config } from '../config';

export async function createPhysics(): Promise<Physics> {
  // The compat build embeds the wasm; init() takes no arguments in 0.21.
  await RAPIER.init();
  return createPhysicsWorld();
}

/**
 * A new, independent world with the same wrapper (RAPIER must be initialised). Used for the main
 * world and for throwaway warm-up worlds; free a throwaway one with `world.free()`.
 */
export function createPhysicsWorld(): Physics {
  const world = new RAPIER.World({
    x: 0,
    y: -config.physics.gravity * config.physics.gravityScale,
    z: 0,
  });
  world.timestep = config.physics.timestep;
  const events = new RAPIER.EventQueue(true);

  // Reused objects so step()/stats() do not allocate per call.
  const gravity = { x: 0, y: 0, z: 0 };
  const result: PhysicsStats = { bodies: 0, activeBodies: 0, joints: 0, colliders: 0, stepMs: 0 };
  let activeCount = 0;
  const countActive = (body: RAPIER.RigidBody): void => {
    // pooled destruction bodies wait disabled; they are not active
    if (body.isDynamic() && body.isEnabled() && !body.isSleeping()) activeCount++;
  };
  let stepMs = 0;

  return {
    RAPIER,
    world,

    step(): void {
      // Re-read gravity each step so the debug panel can change it live.
      gravity.y = -config.physics.gravity * config.physics.gravityScale;
      world.gravity = gravity;
      const t0 = performance.now();
      world.step(events);
      stepMs = performance.now() - t0;
    },

    stats(): PhysicsStats {
      activeCount = 0;
      world.bodies.forEach(countActive);
      result.bodies = world.bodies.len();
      result.activeBodies = activeCount;
      result.joints = world.impulseJoints.len();
      result.colliders = world.colliders.len();
      result.stepMs = stepMs;
      return result;
    },

    removeStaticCollider(collider: RAPIER.Collider): void {
      const parent = collider.parent();
      if (parent) world.removeRigidBody(parent);
      else world.removeCollider(collider, false);
    },

    drainContactForces(cb): void {
      events.drainContactForceEvents((e) => {
        const f = e.totalForce();
        cb(e.collider1(), e.collider2(), f.x, f.y, f.z, e.totalForceMagnitude());
      });
      events.clear();
    },

    addStaticBox(center, halfExtents, yaw = 0): RAPIER.Collider {
      const half = yaw * 0.5;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(center.x, center.y, center.z)
          .setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }),
      );
      return world.createCollider(
        RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z),
        body,
      );
    },
  };
}
