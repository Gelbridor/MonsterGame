// Procedural animation for Basalt: world-planted feet with 2-bone leg IK, a pelvis
// that rides on the legs (so bob and sway fall out of the leg geometry), counter-
// swinging arms driven by the feet, spring-lagged head and tail, breathing idle,
// and speed-based blends. No clips, no skinning.
//
// Two-stage update so nothing pops at 60 Hz physics vs. variable render rate:
//   step(dt, ...)   fixed step: gait state machine + springs -> `cur` pose
//   apply(alpha, .) per frame: lerp(prev, cur) -> bone transforms + leg IK against
//                   the interpolated root, so planted feet never move in the world.
//
// Conventions: model space = the root group (feet at origin, faces -Z, +X right).
// Bones hang along -Y (limbs) or +Z (tail). Positive rotation about X moves +Y
// towards +Z (so negative = lean forward); positive about Y turns left (CCW);
// positive about Z tips +Y towards -X.

import * as THREE from 'three/webgpu';
import { ANKLE_HEIGHT, BONE_REST, SHIN_LEN, THIGH_LEN, type BasaltRig } from './basalt-model';

export interface FootstepEvent {
  foot: 'left' | 'right';
  /** World position of the planted foot (ground contact, y = ground). */
  position: THREE.Vector3;
  /** 0..1: ~0.3 for an idle shuffle, ~0.6 walking, 1 at a full run. */
  strength: number;
  /** Ground speed when it landed (m/s). */
  speed: number;
  /** Time since the animator started (s). */
  time: number;
}

export interface GaitInput {
  /** Root (feet) world position after the physics step. */
  position: THREE.Vector3;
  /** Heading (rad), 0 = facing -Z. */
  heading: number;
  /** Horizontal velocity (m/s). */
  velocity: THREE.Vector3;
  /** Signed angle from heading to the direction the player wants to face (rad); 0 with no input. */
  turnGap: number;
  walkSpeed: number;
  runSpeed: number;
  turnSpeed: number;
  grounded: boolean;
}

const TWO_PI = Math.PI * 2;
const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function wrapAngle(a: number): number {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

interface Spring {
  x: number;
  v: number;
}
function spring(s: Spring, target: number, omega: number, zeta: number, dt: number): void {
  const a = omega * omega * (target - s.x) - 2 * zeta * omega * s.v;
  s.v += a * dt;
  s.x += s.v * dt;
}

// ------------------------------------------------------------------ pose

const POSE_KEYS = [
  'pelvisX', 'pelvisY', 'pelvisZ', 'pelvisPitch', 'pelvisYaw', 'pelvisRoll',
  'spineX', 'spineY', 'spineZ',
  'chestX', 'chestY', 'chestZ', 'breath',
  'neckX', 'neckY', 'headX', 'headY', 'headZ', 'jaw',
  'shRx', 'shRy', 'shRz', 'shLx', 'shLy', 'shLz',
  'uaRx', 'uaRz', 'uaLx', 'uaLz', 'faRx', 'faLx', 'faRz', 'faLz', 'haRx', 'haLx',
  't1y', 't1x', 't2y', 't2x', 't3y', 't3x', 't4y', 't4x',
  'fRx', 'fRy', 'fRz', 'fRyaw', 'fRpitch', 'fLx', 'fLy', 'fLz', 'fLyaw', 'fLpitch',
  'pulse', 'heat',
] as const;
type PoseKey = (typeof POSE_KEYS)[number];
type Pose = Record<PoseKey, number>;

function makePose(): Pose {
  const p = {} as Pose;
  for (const k of POSE_KEYS) p[k] = 0;
  return p;
}

// ------------------------------------------------------------------ feet

/** Neutral ankle position in model space. */
const FOOT_X = 3.7;
const FOOT_Z = 1.0;
/** Hip joint offset from the pelvis origin (m). */
const HIP_X = BONE_REST.thighR.offset[0];
const HIP_Y = BONE_REST.thighR.offset[1];
const HIP_Z = BONE_REST.thighR.offset[2];
const LEG_LEN = THIGH_LEN + SHIN_LEN;
/** Fraction of full leg length used when standing: keeps the knees bent (crouched, heavy). */
const STAND_REACH = 0.845;
const PELVIS_Z = BONE_REST.pelvis.offset[2];

interface Foot {
  side: 1 | -1;
  pos: THREE.Vector3; // world ankle ground-point (y = ground), incl. swing path
  yaw: number; // world yaw
  pitch: number;
  lift: number;
  swinging: boolean;
  t: number;
  dur: number;
  from: THREE.Vector3;
  fromYaw: number;
  to: THREE.Vector3;
  toYaw: number;
  load: number;
  liftH: number;
}

function makeFoot(side: 1 | -1): Foot {
  return {
    side,
    pos: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    lift: 0,
    swinging: false,
    t: 0,
    dur: 0.6,
    from: new THREE.Vector3(),
    fromYaw: 0,
    to: new THREE.Vector3(),
    toYaw: 0,
    load: 1,
    liftH: 2,
  };
}

// ------------------------------------------------------------------ animator

export class BasaltAnimator {
  /** Called when a foot lands. Assign any function; set to null to disable. */
  onFootstep: ((e: FootstepEvent) => void) | null = null;
  /** Footsteps since the last `drainFootsteps()`. */
  private events: FootstepEvent[] = [];

  private cur = makePose();
  private prev = makePose();
  private out = makePose();

  private feet: [Foot, Foot] = [makeFoot(1), makeFoot(-1)];
  private time = 0;
  private initialised = false;

  // springs
  private pelvisY: Spring = { x: 9.7 + 0.9, v: 0 };
  private pelvisX: Spring = { x: 0, v: 0 };
  private headYaw: Spring = { x: 0, v: 0 };
  private headPitch: Spring = { x: 0, v: 0 };
  private headRoll: Spring = { x: 0, v: 0 };
  private chestYaw: Spring = { x: 0, v: 0 };
  private jaw: Spring = { x: 0, v: 0 };
  private roll: Spring = { x: 0, v: 0 };
  private pitch: Spring = { x: 0, v: 0 };
  private turn: Spring = { x: 0, v: 0 };
  private tailYaw: Spring[] = [0, 1, 2, 3].map(() => ({ x: 0, v: 0 }));
  private tailPitch: Spring[] = [0, 1, 2, 3].map(() => ({ x: 0, v: 0 }));
  private armKick: Spring = { x: 0, v: 0 };

  private breathPhase = 0;
  private heartPhase = 0;
  private lookTimer = 2;
  private lookYaw = 0;
  private lookPitch = 0;
  private shiftTimer = 4;
  private shiftTarget = 0;
  private smoothSpeed = 0;
  private lastHeading = 0;

  // temps
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpC = new THREE.Vector3();
  private tmpD = new THREE.Vector3();
  private qp = new THREE.Quaternion();
  private qpInv = new THREE.Quaternion();
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private mat = new THREE.Matrix4();
  private eul = new THREE.Euler();

  constructor(private readonly rig: BasaltRig) {
    // Wire the pose from the rest pose so the first frame is sane.
    this.cur.pelvisY = 10.6;
    this.cur.pelvisZ = PELVIS_Z;
    this.prev = { ...this.cur };
  }

  /** Remove and return footsteps since the last call (alternative to the callback). */
  drainFootsteps(): FootstepEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ------------------------------------------------------------ fixed step

  step(dt: number, g: GaitInput): void {
    this.time += dt;
    const P = g.position;
    const h = g.heading;
    const vel = g.velocity;
    const v = Math.hypot(vel.x, vel.z);

    if (!this.initialised) {
      this.initialised = true;
      this.lastHeading = h;
      for (const f of this.feet) {
        this.neutralTarget(f, P, h, 0, f.pos);
        f.yaw = h + f.side * 0.1;
      }
    }

    this.prev = { ...this.cur };
    const cur = this.cur;

    const walkAmt = smooth(0.15, 3.5, v);
    const runAmt = smooth(g.walkSpeed + 0.5, g.runSpeed - 1.0, v);
    this.smoothSpeed += (v - this.smoothSpeed) * (1 - Math.exp(-6 * dt));

    const omega = wrapAngle(h - this.lastHeading) / dt;
    this.lastHeading = h;
    spring(this.turn, omega, 9, 1, dt);
    const turnNorm = clamp(this.turn.x / g.turnSpeed, -1.2, 1.2);

    // ---- footing ----------------------------------------------------
    const S = 2.2 + 0.5 * v; // step length (m)
    const k = clamp(v / 1.2, 0, 1);
    const halfS = S * 0.5 * k;
    const thr = 0.55 * (1 - k);

    // Teleport / huge discontinuity: re-plant under the body.
    for (const f of this.feet) {
      if (Math.hypot(f.pos.x - P.x, f.pos.z - P.z) > 16) {
        this.neutralTarget(f, P, h, 0, f.pos);
        f.swinging = false;
      }
    }

    const sinH = Math.sin(h);
    const cosH = Math.cos(h);
    let bestIdx = -1;
    let bestDev = 0;
    const bs: number[] = [0, 0];
    this.feet.forEach((f, i) => {
      const dx = f.pos.x - P.x;
      const dz = f.pos.z - P.z;
      const mx = dx * cosH - dz * sinH;
      const mz = dx * sinH + dz * cosH;
      const b = mz - FOOT_Z;
      bs[i] = b;
      if (f.swinging) return;
      const lat = Math.abs(mx - f.side * FOOT_X);
      const devBack = b - (halfS + thr);
      const devFwd = -b - (halfS + thr + 1.6);
      const devLat = lat - 1.8;
      const dev = Math.max(devBack, devFwd, devLat);
      if (dev <= 0) return;
      const other = this.feet[1 - i];
      const ok = !other.swinging || other.t > lerp(0.86, 0.45, runAmt);
      if (ok && dev > bestDev) {
        bestIdx = i;
        bestDev = dev;
      }
    });
    if (bestIdx >= 0) {
      const f = this.feet[bestIdx];
      f.swinging = true;
      f.t = 0;
      f.from.copy(f.pos);
      f.fromYaw = f.yaw;
      f.dur = v < 1.2 ? 0.66 : clamp((S / Math.max(v, 0.01)) * lerp(0.8, 0.95, runAmt), 0.42, 0.85);
      f.liftH = lerp(1.5, 2.8, runAmt) * (0.55 + 0.45 * k);
    }

    const landed: Foot[] = [];
    for (const f of this.feet) {
      if (!f.swinging) continue;
      f.t += dt / f.dur;
      const trem = Math.max(0, (1 - Math.min(1, f.t)) * f.dur);
      const hp = h + this.turn.x * trem * 0.7;
      // Predicted body position at landing.
      this.tmpA.set(P.x + vel.x * trem, P.y, P.z + vel.z * trem);
      this.neutralTarget(f, this.tmpA, hp, halfS, f.to);
      f.toYaw = hp + f.side * 0.1;
      const u = clamp(f.t, 0, 1);
      const e = u * u * (3 - 2 * u);
      f.pos.x = lerp(f.from.x, f.to.x, e);
      f.pos.z = lerp(f.from.z, f.to.z, e);
      f.pos.y = lerp(f.from.y, f.to.y, e);
      f.yaw = f.fromYaw + wrapAngle(f.toYaw - f.fromYaw) * e;
      f.lift = f.liftH * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.85)), 1.15);
      // Toe pushes off, then toes lift for a heel-first landing.
      const push = -0.5 * Math.pow(Math.max(0, 1 - u / 0.28), 2);
      const reach = 0.38 * Math.sin(Math.PI * clamp((u - 0.28) / 0.72, 0, 1)) * (1 - smooth(0.9, 1, u));
      f.pitch = push + reach;
      f.load = u < 0.1 ? 1 - u / 0.1 : u > 0.82 ? (u - 0.82) / 0.18 : 0;
      if (f.t >= 1) landed.push(f);
    }
    for (const f of landed) {
      f.swinging = false;
      f.t = 0;
      f.pos.copy(f.to);
      f.yaw = f.toYaw;
      f.lift = 0;
      f.pitch = 0;
      f.load = 1;
      const strength = clamp(0.3 + 0.35 * walkAmt + 0.35 * runAmt, 0, 1);
      this.pelvisY.v -= 2.2 + 3.2 * strength;
      this.headPitch.v -= 0.9 * strength;
      this.armKick.v -= 0.6 * strength;
      const ev: FootstepEvent = {
        foot: f.side === 1 ? 'right' : 'left',
        position: f.pos.clone(),
        strength,
        speed: v,
        time: this.time,
      };
      this.events.push(ev);
      if (this.events.length > 64) this.events.shift();
      this.onFootstep?.(ev);
    }

    const [fr, fl] = this.feet;
    const loadSum = fr.load + fl.load;
    const loadDiff = loadSum > 0.01 ? (fr.load - fl.load) / Math.max(1, loadSum) : 0;

    // ---- gait phase signals from the feet ---------------------------------
    const norm = Math.max(halfS, 1.8);
    const nbR = clamp(bs[0] / norm, -1.3, 1.3);
    const nbL = clamp(bs[1] / norm, -1.3, 1.3);
    const nd = (nbL - nbR) * 0.5; // + when the right foot is ahead

    // ---- pelvis height from the planted legs ------------------------------
    const crouch = STAND_REACH - 0.05 * runAmt - 0.02 * walkAmt;
    const reach = LEG_LEN * crouch;
    const standHip = ANKLE_HEIGHT + reach;
    let target = standHip + 0.9;
    const px = this.pelvisX.x;
    for (const f of this.feet) {
      if (f.load < 0.45) continue;
      const dxw = f.pos.x - P.x;
      const dzw = f.pos.z - P.z;
      const ax = dxw * cosH - dzw * sinH;
      const az = dxw * sinH + dzw * cosH;
      const hx = px + f.side * HIP_X;
      const hz = PELVIS_Z + HIP_Z;
      const d2 = (hx - ax) * (hx - ax) + (hz - az) * (hz - az);
      const need = f.pos.y - P.y + f.lift + ANKLE_HEIGHT + Math.sqrt(Math.max(reach * reach - d2, 4));
      target = Math.min(target, need + 0.9);
    }
    spring(this.pelvisY, target, 10, 0.78, dt);

    // Lateral sway over the planted foot + idle weight shifts.
    this.shiftTimer -= dt;
    if (this.shiftTimer <= 0) {
      this.shiftTimer = 5 + Math.random() * 5;
      this.shiftTarget = Math.random() < 0.3 ? 0 : (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.35);
    }
    const idleAmt = 1 - walkAmt;
    spring(this.pelvisX, loadDiff * 0.95 * walkAmt + this.shiftTarget * idleAmt, 5, 0.9, dt);

    // ---- leans ---------------------------------------------------------------
    const leanTarget = 0.045 * walkAmt + 0.2 * runAmt;
    spring(this.pitch, leanTarget, 4, 0.9, dt);
    const rollTarget = clamp(0.006 * v * this.turn.x + 0.03 * this.turn.x, -0.2, 0.2);
    spring(this.roll, rollTarget, 5, 0.85, dt);
    const lean = this.pitch.x;

    // ---- breathing / lava pulse ---------------------------------------------
    this.breathPhase += dt * lerp(1 / 5.4, lerp(1 / 3.2, 1 / 1.7, runAmt), walkAmt);
    this.heartPhase += dt * lerp(0.7, 1.4, Math.max(walkAmt, runAmt));
    const breath = Math.sin(this.breathPhase * TWO_PI);
    const heart = Math.pow(Math.max(0, Math.sin(this.heartPhase * TWO_PI)), 10);
    cur.breath = breath;
    cur.pulse = 0.92 + 0.12 * (0.5 + 0.5 * breath) + 0.16 * heart + 0.18 * runAmt;
    cur.heat = clamp(0.5 * runAmt + 0.15 * walkAmt, 0, 1);

    // ---- head look ----------------------------------------------------------------
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = 3 + Math.random() * 4;
      this.lookYaw = Math.random() < 0.35 ? 0 : (Math.random() - 0.5) * 1.0;
      this.lookPitch = (Math.random() - 0.5) * 0.18;
    }
    const lookAmt = 1 - Math.max(walkAmt, Math.abs(g.turnGap) > 0.05 ? 1 : 0);
    const headYawTarget = clamp(g.turnGap * 0.7, -0.75, 0.75) + this.lookYaw * lookAmt;
    spring(this.headYaw, headYawTarget, 4.5, 0.85, dt);
    spring(this.chestYaw, clamp(g.turnGap * 0.25, -0.3, 0.3), 3, 0.9, dt);
    spring(this.headPitch, -0.05 + this.lookPitch * lookAmt - lean * 0.8 + 0.04 * breath, 5.5, 0.45, dt);
    spring(this.headRoll, -this.roll.x * 0.8, 5, 0.8, dt);
    spring(this.jaw, -0.03 - 0.02 * (0.5 + 0.5 * breath) - 0.1 * runAmt, 6, 0.8, dt);
    spring(this.armKick, 0, 7, 0.4, dt);

    // ---- write pose -----------------------------------------------------------------
    const pyaw = 0.15 * nd * walkAmt * (1 + 0.5 * runAmt);
    cur.pelvisX = this.pelvisX.x;
    cur.pelvisY = this.pelvisY.x;
    cur.pelvisZ = PELVIS_Z - 0.25 * runAmt;
    cur.pelvisPitch = -lean * 0.34;
    cur.pelvisYaw = pyaw;
    cur.pelvisRoll = loadDiff * 0.045 * walkAmt + this.roll.x * 0.4 + this.pelvisX.x * -0.02;

    cur.spineX = -lean * 0.3 + 0.012 * breath;
    cur.spineY = -pyaw * 0.5;
    cur.spineZ = -cur.pelvisRoll * 0.4 + this.roll.x * 0.2;
    cur.chestX = -lean * 0.36 - 0.012 * breath;
    cur.chestY = -pyaw * 0.9 + this.chestYaw.x;
    cur.chestZ = -cur.pelvisRoll * 0.4 + this.roll.x * 0.4;

    cur.neckX = -0.02 + lean * 0.2;
    cur.neckY = this.headYaw.x * 0.35;
    cur.headX = this.headPitch.x;
    cur.headY = this.headYaw.x * 0.65 + pyaw * 0.4;
    cur.headZ = this.headRoll.x;
    cur.jaw = this.jaw.x;

    // Arms: opposite the legs. Positive X rotation swings the hand forward (-Z).
    const ampArm = lerp(0.4, 0.82, runAmt) * walkAmt;
    const swingR = -nbL * ampArm + this.armKick.x * 0.15;
    const swingL = -nbR * ampArm + this.armKick.x * 0.15;
    const sag = 0.1 + 0.05 * breath; // idle: arms hang forward a touch
    cur.uaRx = sag + swingR + 0.1 * runAmt;
    cur.uaLx = sag + swingL + 0.1 * runAmt;
    const out = 0.2 + 0.03 * breath - 0.06 * runAmt;
    cur.uaRz = out;
    cur.uaLz = -out;
    const elbow = (sw: number) => 0.3 + 0.42 * Math.max(0, sw) + 0.55 * runAmt + 0.05 * (0.5 + 0.5 * breath);
    cur.faRx = elbow(swingR);
    cur.faLx = elbow(swingL);
    cur.faRz = 0;
    cur.faLz = 0;
    cur.haRx = 0.15 - 0.1 * swingR;
    cur.haLx = 0.15 - 0.1 * swingL;
    // Shoulder roll: the girdle rocks against the hips.
    cur.shRx = -swingR * 0.18;
    cur.shLx = -swingL * 0.18;
    cur.shRy = -pyaw * 0.4;
    cur.shLy = -pyaw * 0.4;
    cur.shRz = -0.03 * breath + this.roll.x * 0.25;
    cur.shLz = 0.03 * breath + this.roll.x * 0.25;

    // Tail: whip-like follow-through chain.
    const tailBase =
      -pyaw * 1.1 - 0.35 * turnNorm + 0.1 * (nbL - nbR) * walkAmt + 0.05 * Math.sin(this.time * 0.6);
    let follow = tailBase;
    for (let i = 0; i < 4; i++) {
      spring(this.tailYaw[i], follow, 6.5 - i * 1.0, 0.55, dt);
      follow = this.tailYaw[i].x;
      const pitchT = [0.1, 0.17, 0.2, 0.2][i] - 0.16 * runAmt + 0.04 * Math.sin(this.time * 0.8 + i) - 0.6 * this.pelvisY.v * 0.03;
      spring(this.tailPitch[i], pitchT, 5.5 - i * 0.5, 0.6, dt);
    }
    cur.t1y = this.tailYaw[0].x;
    cur.t2y = this.tailYaw[1].x * 0.9;
    cur.t3y = this.tailYaw[2].x * 0.9;
    cur.t4y = this.tailYaw[3].x * 0.9;
    cur.t1x = this.tailPitch[0].x;
    cur.t2x = this.tailPitch[1].x;
    cur.t3x = this.tailPitch[2].x;
    cur.t4x = this.tailPitch[3].x;

    // Feet (world space, interpolated later).
    cur.fRx = fr.pos.x;
    cur.fRy = fr.pos.y + fr.lift;
    cur.fRz = fr.pos.z;
    cur.fRyaw = fr.yaw;
    cur.fRpitch = fr.pitch;
    cur.fLx = fl.pos.x;
    cur.fLy = fl.pos.y + fl.lift;
    cur.fLz = fl.pos.z;
    cur.fLyaw = fl.yaw;
    cur.fLpitch = fl.pitch;
    // Foot yaw interpolates linearly: keep it continuous with the previous pose.
    this.prev.fRyaw = cur.fRyaw - wrapAngle(cur.fRyaw - this.prev.fRyaw);
    this.prev.fLyaw = cur.fLyaw - wrapAngle(cur.fLyaw - this.prev.fLyaw);

  }

  /** Where a foot should be for a body at `body` heading `hd`, `ahead` metres ahead of neutral. */
  private neutralTarget(f: Foot, body: THREE.Vector3, hd: number, ahead: number, out: THREE.Vector3): void {
    const s = Math.sin(hd);
    const c = Math.cos(hd);
    const mx = f.side * FOOT_X;
    const mz = FOOT_Z - ahead;
    out.set(body.x + c * mx + s * mz, body.y, body.z - s * mx + c * mz);
  }

  // ------------------------------------------------------------ per frame

  /** Pose the bones for the interpolated root (position, heading) and alpha between fixed steps. */
  apply(alpha: number, rootPos: THREE.Vector3, rootHeading: number): void {
    const a = this.prev;
    const b = this.cur;
    const o = this.out;
    for (const k of POSE_KEYS) o[k] = a[k] + (b[k] - a[k]) * alpha;

    const bones = this.rig.bones;
    const eul = this.eul;

    // Pelvis.
    bones.pelvis.position.set(o.pelvisX, o.pelvisY, o.pelvisZ);
    eul.set(o.pelvisPitch, o.pelvisYaw, o.pelvisRoll, 'YXZ');
    bones.pelvis.quaternion.setFromEuler(eul);
    this.qp.copy(bones.pelvis.quaternion);
    this.qpInv.copy(this.qp).invert();

    // Upper body.
    bones.spine.rotation.set(o.spineX, o.spineY, o.spineZ, 'YXZ');
    bones.chest.rotation.set(o.chestX, o.chestY, o.chestZ, 'YXZ');
    const br = 1 + 0.018 * o.breath;
    bones.chest.scale.set(1 + 0.012 * o.breath, br + 0.012 * o.breath, br);
    bones.neck.rotation.set(o.neckX, o.neckY, 0, 'YXZ');
    bones.head.rotation.set(o.headX, o.headY, o.headZ, 'YXZ');
    bones.jaw.rotation.set(o.jaw, 0, 0);

    bones.shoulderR.rotation.set(o.shRx, o.shRy, o.shRz, 'YXZ');
    bones.shoulderL.rotation.set(o.shLx, o.shLy, o.shLz, 'YXZ');
    bones.upperArmR.rotation.set(o.uaRx, 0, o.uaRz, 'YXZ');
    bones.upperArmL.rotation.set(o.uaLx, 0, o.uaLz, 'YXZ');
    bones.foreArmR.rotation.set(o.faRx, 0, o.faRz);
    bones.foreArmL.rotation.set(o.faLx, 0, o.faLz);
    bones.handR.rotation.set(o.haRx, 0, 0);
    bones.handL.rotation.set(o.haLx, 0, 0);

    bones.tail1.rotation.set(o.t1x, o.t1y, 0, 'YXZ');
    bones.tail2.rotation.set(o.t2x, o.t2y, 0, 'YXZ');
    bones.tail3.rotation.set(o.t3x, o.t3y, 0, 'YXZ');
    bones.tail4.rotation.set(o.t4x, o.t4y, 0, 'YXZ');

    // Legs: IK against the interpolated root.
    const sinH = Math.sin(rootHeading);
    const cosH = Math.cos(rootHeading);
    this.solveLeg(1, o.fRx, o.fRy, o.fRz, o.fRyaw, o.fRpitch, rootPos, rootHeading, sinH, cosH);
    this.solveLeg(-1, o.fLx, o.fLy, o.fLz, o.fLyaw, o.fLpitch, rootPos, rootHeading, sinH, cosH);
  }

  /** Current pose scalars the lights / material read. */
  get pulse(): number {
    return this.out.pulse;
  }
  get heat(): number {
    return this.out.heat;
  }

  private solveLeg(
    side: 1 | -1,
    wx: number,
    wy: number,
    wz: number,
    footYaw: number,
    footPitch: number,
    root: THREE.Vector3,
    heading: number,
    sinH: number,
    cosH: number,
  ): void {
    const bones = this.rig.bones;
    const thigh = side === 1 ? bones.thighR : bones.thighL;
    const shin = side === 1 ? bones.shinR : bones.shinL;
    const foot = side === 1 ? bones.footR : bones.footL;

    // Ankle in model space (heel-lift keeps toes / heel out of the ground).
    const cp = Math.cos(footPitch);
    const sp = Math.sin(footPitch);
    const minAnkle = ANKLE_HEIGHT * cp + (sp < 0 ? -sp * 4.9 : sp * 2.4);
    const groundY = wy; // already includes the lift on top of the ground height
    void groundY;
    const dx = wx - root.x;
    const dz = wz - root.z;
    const mx = dx * cosH - dz * sinH;
    const mz = dx * sinH + dz * cosH;
    // wy = ground + lift; ankle height above that is at least minAnkle.
    const my = wy - root.y + Math.max(ANKLE_HEIGHT, minAnkle);
    const ankle = this.tmpA.set(mx, my, mz);

    // Hip in model space.
    const hipLocal = this.tmpB.set(side * HIP_X, HIP_Y, HIP_Z).applyQuaternion(this.qp);
    const hip = hipLocal.add(bones.pelvis.position);
    // Hip -> ankle in the pelvis frame (thigh bone's parent has identity rest rotation).
    const toAnkle = this.tmpC.copy(ankle).sub(hip).applyQuaternion(this.qpInv);

    const L1 = THIGH_LEN;
    const L2 = SHIN_LEN;
    let d = toAnkle.length();
    const dir = toAnkle.multiplyScalar(1 / Math.max(d, 1e-5));
    d = clamp(d, Math.abs(L1 - L2) + 0.05, L1 + L2 - 0.02);
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const hgt = Math.sqrt(Math.max(L1 * L1 - a * a, 0));
    // Knee points forward and slightly outwards.
    const pole = this.tmpD.set(side * 0.2, 0.0, -1);
    pole.addScaledVector(dir, -pole.dot(dir)).normalize();
    const knee = new THREE.Vector3().copy(dir).multiplyScalar(a).addScaledVector(pole, hgt);
    const ankleP = new THREE.Vector3().copy(dir).multiplyScalar(d);
    // Bend axis shared by thigh and shin.
    const axisX = new THREE.Vector3().crossVectors(dir, pole).normalize();

    const basis = (yAxis: THREE.Vector3, q: THREE.Quaternion): void => {
      const x = axisX;
      const z = new THREE.Vector3().crossVectors(x, yAxis).normalize();
      const xo = new THREE.Vector3().crossVectors(yAxis, z).normalize();
      this.mat.makeBasis(xo, yAxis, z);
      q.setFromRotationMatrix(this.mat);
    };
    const yThigh = new THREE.Vector3().copy(knee).negate().normalize();
    const yShin = new THREE.Vector3().subVectors(ankleP, knee).negate().normalize();
    basis(yThigh, this.qa);
    thigh.quaternion.copy(this.qa);
    basis(yShin, this.qb);
    shin.quaternion.copy(this.qa).invert().multiply(this.qb);

    // Foot: world yaw / pitch -> pelvis frame -> shin frame.
    this.eul.set(footPitch, footYaw - heading, 0, 'YXZ');
    const qFootModel = new THREE.Quaternion().setFromEuler(this.eul);
    const qFootPelvis = new THREE.Quaternion().copy(this.qpInv).multiply(qFootModel);
    foot.quaternion.copy(this.qb).invert().multiply(qFootPelvis);
  }
}
