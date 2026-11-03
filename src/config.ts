// Every tunable number in one place. The debug panel edits this object live,
// so modules must read values from `config` each time they use them rather
// than copying them once at start-up (unless noted as "restart required").
//
// Units are real-world: 1 unit = 1 m, masses in kg, time in seconds.

export const config = {
  physics: {
    /** Fixed physics step (s). 60 Hz. Restart required. */
    timestep: 1 / 60,
    /** Max fixed steps per rendered frame before we drop time (spiral-of-death guard). */
    maxStepsPerFrame: 5,
    /** Gravity (m/s², positive number, applied downwards). */
    gravity: 9.81,
    /** Multiplier on gravity, for tuning. */
    gravityScale: 1,
  },

  world: {
    /** Ground plane edge length (m). Restart required. */
    groundSize: 400,
    /** Random seed for the blockout town. Restart required. */
    seed: 1987,
  },

  monster: {
    /** Basalt total height (m), capsule tip to tip. Restart required. */
    height: 30,
    /** Capsule radius (m). Restart required. */
    radius: 5,
    /** Body mass (kg), used later for impacts. ~ a 30 m rock beast. */
    mass: 4.0e6,
    /** Walking speed (m/s). */
    walkSpeed: 7,
    /** Running speed (m/s). */
    runSpeed: 16,
    /** How fast speed changes (m/s²). Low = heavy. */
    acceleration: 14,
    /** How fast speed drops with no input (m/s²). */
    deceleration: 20,
    /** Max turn rate (rad/s). Low = slow to turn. */
    turnSpeed: 2.2,
    /** Max step height the character controller climbs (m). */
    stepHeight: 1.5,
  },

  camera: {
    /** Vertical field of view (degrees). */
    fov: 55,
    /** Distance from the look-at point (m). Plan: ~45 m behind and above. */
    distance: 45,
    /** Default pitch (radians, positive = looking down). */
    pitch: 0.42,
    minPitch: -0.1,
    maxPitch: 1.2,
    /** Height on the monster the camera looks at (m above feet). */
    lookAtHeight: 22,
    /** Position smoothing (higher = snappier). */
    followSharpness: 6,
    /** Look sensitivity for mouse / touch drag (rad per pixel). */
    lookSensitivity: 0.005,
    /** Gamepad right-stick look speed (rad/s at full deflection). */
    stickLookSpeed: 2.6,
    /** Auto-swing the camera behind Basalt while moving (0 = off). */
    autoFollowStrength: 1.2,
    near: 0.5,
    far: 2000,
  },

  render: {
    /** Cap on devicePixelRatio. Overridden by the quality preset at start-up. */
    maxPixelRatio: 2,
    /** Render-resolution scale (0.5..1) on top of the pixel ratio. Moved at run time by dynamic resolution. */
    renderScale: 1,
    /** Fog density for the night haze. */
    fogDensity: 0.0028,
    /** Tone mapping exposure. */
    exposure: 1.0,
    /** Moon light intensity. */
    moonIntensity: 2.2,
    /** Sky / ambient fill intensity. */
    ambientIntensity: 1.0,
    /** Environment-map reflection strength on PBR materials. */
    envIntensity: 1.0,
    bloomStrength: 0.9,
    bloomRadius: 0.55,
    bloomThreshold: 0.85,
    aoIntensity: 1.0,
    aoRadius: 4.0,
    ssrStrength: 0.8,
    filmGrain: 0.06,
    vignette: 0.35,
    chromaticAberration: 0.0015,
    saturation: 1.05,
    contrast: 1.05,
  },

  weather: {
    /** Rain amount 0..1 (0 = dry). Rain is on by default per the plan. */
    rain: 1.0,
    /** Wind push on rain (m/s, x and z). */
    windX: 2.0,
    windZ: 1.0,
    /** How wet the streets look 0..1 (puddles, reflections). */
    wetness: 0.85,
  },

  destruction: {
    /** Health multiplier on every piece. */
    healthScale: 1,
    /** Multiplier on every bond's force and moment limit (lower = collapses sooner). */
    bondStrengthScale: 1,
    /** Distance (m) from a damage shape within which a sleeping building wakes. */
    wakeRadius: 12,
    /** Seconds a debris shard stays physical before it may sleep and be merged into rubble. */
    debrisLifetime: 5,
    /** Shards per fractured piece (min/max; the quality tier scales this down). */
    shardsMin: 4,
    shardsMax: 12,
    /** Debug punch: damage, radius (m) and impulse (N*s). */
    punchDamage: 200,
    punchRadius: 4,
    punchImpulse: 2.0e6,
    /** Debug punch centre: metres in front of Basalt's feet (along its facing) and height above them. */
    punchReach: 12,
    punchHeight: 8,
    /**
     * Structural stress solver budget per physics step, in CG iterations x (bonds + pieces), shared
     * by all awake buildings (~0.1 us each on a desktop CPU, so 20,000 is about 2 ms). The quality
     * tier scales it (preset.solverWorkScale). Unfinished solves resume next step.
     */
    solverWorkPerStep: 20000,
    /**
     * Mean force while a member is crushed, as a fraction of its peak capacity (post-peak softening:
     * buckled, hinged members carry little). Sets how much energy a crush absorbs from a falling mass.
     */
    crushWork: 0.15,
  },

  input: {
    /** Stick / joystick dead zone (0..1). */
    deadZone: 0.15,
    /** Virtual joystick radius on touch screens (CSS px). */
    touchStickRadius: 60,
  },

  quality: {
    /** Lower the quality tier automatically (one step, then reload) when the frame rate stays too low. */
    autoStepDown: true,
    /** Seconds after the loop starts to ignore (shader compiles, first-frame hitches). */
    startupIgnoreS: 3,
    /** Length (s) of the rolling window of frame times that is judged. */
    windowS: 4,
    /** Which percentile of frame time in the window is judged (0.8 = the slowest 20% of frames are ignored as spikes). */
    percentile: 0.8,
    /** Minimum seconds between two automatic step-downs. */
    cooldownS: 20,
    /** Step down from Ultra / High when the judged frame rate is below this. */
    minFpsHigh: 50,
    /** Dynamic resolution: lower render scale before lowering the tier. */
    dynamicRes: true,
    /** Seconds between dynamic-resolution decisions (judged on the last interval's frames). */
    scaleIntervalS: 2,
    /** Render scale lowered by this much when too slow. */
    scaleDown: 0.1,
    /** Render scale raised by this much when comfortably fast. */
    scaleUp: 0.05,
    /** Lowest render scale; only when at this floor and still slow does the tier step down. */
    scaleMin: 0.5,
    /** Raise the scale only when fps exceeds target x this factor (keep it above 1 so it cannot flap). */
    raiseFactor: 1.15,
    /** Render scale to start with on integrated / previously stepped-down machines. */
    startScaleWeak: 0.75,
    /** Low tier fps target (dynamic resolution only; there is no lower tier). */
    minFpsLow: 24,
    /** Step down from Medium when the judged frame rate is below this. */
    minFpsMedium: 28,
    /** Seconds the "Quality lowered" toast stays after the reload. */
    toastS: 3,
  },

  debug: {
    /** Show the stats overlay (fps, bodies, joints, draw calls). */
    showStats: true,
    /** Draw physics collider wireframes. */
    showColliders: false,
  },
};

export type Config = typeof config;
