# Monster Brawl: destruction tech demo plan

Owner: @Tommy · Created 2 Nov 2026 · Last revised 3 Nov 2026

This is the design document. It says **what** to build and **in what order**.
For the current state of the code, open faults and how to pick up the work, read [`handoff.md`](handoff.md).

## Status

| Phase | State |
| --- | --- |
| 1 · Foundations | Built and live on GitHub Pages. **Gate not yet signed off** (awaiting a phone test). |
| Graphics pass (pulled forward from Phase 5) | Built at the owner's request and live. A polish round is outstanding; see `handoff.md`. |
| 2 · Destruction core | Not started. **Next after the Phase 1 gate.** |
| 3 · Scale and performance | Not started |
| 4 · Moves and game feel | Not started |
| 5 · Effects, audio and polish | Not started (except the graphics pass) |

## Vision and goals

The demo proves one thing: smashing a city as a giant monster in a browser can feel as weighty and satisfying as the PS2 classic, with modern visuals.
It has one monster, one town and no opponent yet.

**Destruction-first pillars**

1. **Everything big breaks.** Every building, bridge, tower and vehicle can be damaged, broken apart and brought down.
2. **Damage is local, then structural.** A punch takes out the chunk it hits. Remove enough support and the floors above fall.
3. **Debris matters.** Rubble stays, piles up, can be picked up and thrown, and blocks paths.
4. **Real physics, not scripts.** Buildings fall because gravity overloads their joints, not because an animation plays. Leaning, pancaking and toppling all come from the simulation.
5. **It runs on a phone.** Phones run the same physics rules with coarser pieces. A mid-range phone holds 30 fps and a PC holds 60.

**In scope:**
- one original monster
- a British town centre at night, about 400 m × 400 m, with 25 to 40 destructible buildings, vehicles and street props
- punch, stomp, grab, throw and charge moves
- dust, fire, glass, sparks and screen shake

**Out of scope (later builds):** a second monster or AI opponent, police or army units, multiplayer, menus, story, multiple cities and power-ups.

**Originality:** the monster, city, name and audio are all new. Nothing is copied from the original game's characters, levels or branding.

## Tech stack and performance budget

The game uses Three.js for rendering, Rapier for physics and Vite for builds, and is published as a single web link.

| Layer | Choice | Why |
| --- | --- | --- |
| Rendering | Three.js `WebGPURenderer` with TSL node materials; automatic WebGL 2 fallback | Modern lighting and post-processing; works on iPhone Safari and desktop Chrome |
| Physics | Rapier (Rust compiled to WebAssembly) | Fast rigid bodies, can sleep thousands of idle chunks, deterministic |
| Fracture | Pre-fractured shards linked by breakable physics joints; extra runtime fracture on PC | Real-time fracturing is too slow on phones; pre-cut pieces look the same |
| Effects | GPU particles (instanced), decals, volumetric-style dust sprites | Thousands of particles for little CPU cost |
| Audio | Web Audio API with layered, pitch-varied samples | Every impact sounds different |
| Build | Vite + TypeScript | Quick reloads while tuning; small output |
| Assets | Procedural buildings and materials in code first; glTF models later | Gets to playable fast without an artist |
| Hosting | GitHub Pages, deployed on every push to `main` (itch.io later) | Open on phone or PC instantly |

### Performance budget per quality tier

`src/core/quality.ts` implements these tiers and picks one automatically. The URL option `?quality=` overrides it.

| Tier | Target | Active physics chunks | Particles | Shadows | Post-processing | Real lights | Rain drops |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ultra (PC) | 60 fps | 1,500 | 20,000 | 4 cascades × 2,048 px, whole city | Bloom, GTAO, SSR, SMAA, filmic grade | 48 | 24,000 |
| High (PC) | 60 fps | 800 | 10,000 | 3 cascades × 2,048 px, whole city | As Ultra, AO/SSR at half resolution | 24 | 12,000 |
| Medium (phone) | 30–60 fps | 300 | 3,000 | 1,024 px, monster only | Bloom, FXAA, filmic grade | 8 | 4,000 |
| Low (phone) | 30 fps | 150 | 1,000 | None (blob shadows later) | None | 4 | 1,500 |

Idle debris is put to sleep and, after a delay, merged into one static rubble mesh. That keeps a fully wrecked city cheap to draw.

## Destruction system

Each building is a graph of breakable pieces linked by joints.
A hit damages pieces, broken pieces fall away, and a support check each step decides what else falls with them.

**The damage-to-collapse loop**

1. **Hit:** an attack, thrown object or falling mass creates a damage shape with a damage value and impulse.
2. **Damage:** pieces inside the shape lose health according to distance. Hurt pieces show cracks.
3. **Detach:** a piece at 0 health detaches. Its shards become live bodies and fly off with the impulse.
4. **Wake:** the building wakes from one static body into its full jointed form.
5. **Stress:** every physics step reads the load on each joint. Joints over their material strength break.
6. **Collapse:** unsupported sections fall under gravity, pancaking, leaning or toppling.
7. **Impact on landing:** falling mass hits with real momentum and becomes a new hit (step 1) for whatever it lands on.
8. **Settle:** debris that comes to rest sleeps and is merged into static rubble.

The loop back from step 7 to step 1 is what turns one punch into a district-wide collapse.
Step 8 keeps a fully wrecked city cheap to draw.

### 1. How a building is built

- **Floors × bays grid.** A building is generated as a grid, for example 12 floors × 4 × 4 bays. Each cell holds a few pieces: a floor slab, corner columns, wall panels and windows.
- **Pre-fractured pieces.** Each wall panel and slab is pre-split into 4 to 12 Voronoi shards, created once when the level loads. While intact, the shards render as one merged mesh, so an untouched building costs about 1 draw call.
- **Support graph.** Every piece knows what holds it up (the column or slab below it) and what it holds up. The ground floor's columns connect to the ground.
- **Materials** decide health, mass and effects:

| Material | Health | Breaks into | Effects |
| --- | --- | --- | --- |
| Concrete | High | Large chunks + rebar | Grey dust, sparks |
| Brick | Medium | Small blocks | Orange dust |
| Glass | Very low | Hundreds of shards | Glitter particles, tinkle |
| Steel frame | Very high | Bends, then snaps | Sparks, groan |
| Wood / signage | Low | Splinters | Small fire chance |

### 2. Taking damage

- **Damage shapes.** Each attack has one: a sphere for punches, a ring for stomps, a capsule for a charge or a thrown car. Each carries a damage value and an impulse.
- **Detaching.** Pieces inside the shape lose health according to distance. A piece at 0 health **detaches**: its shards become live Rapier bodies and fly off with the impulse.
- **Visible wear.** Pieces that are hurt but not broken get **crack decals** and darker textures, so damage builds up visibly over time.
- **Glass.** Glass breaks in a radius around any hit, even a small one. A whole façade can shatter in one shockwave.

### 3. Structural collapse

Collapse is fully simulated. Nothing is scripted or animated.

- **Breakable joints.** Every piece is a real Rapier rigid body with true mass. It is held to its neighbours by fixed joints, and each joint has a strength set by its material.
- **Stress decides failure.** Every physics step reads the force and twisting load on each joint. When the load exceeds the joint's strength, the joint breaks.
- **Load is real weight.** A ground-floor column carries the actual mass of every floor above it. Knock out its neighbours and the remaining columns overload and give way by themselves.
- **Steel yields before it snaps.** Steel frames use spring-limited joints that bend under load, so towers creak and lean for real before they go.
- **Emergent collapse.** Pancaking, toppling, one-sided leaning and walls peeling away all come from gravity, mass and joint strength. No collapse animation is played.
- **Momentum damage.** Falling mass hits with real momentum (mass × speed). A falling tower block can knock down the terrace next to it with no special-case code.
- **Sleeping buildings.** An untouched building is one static body. When anything hits within range, it wakes into its full jointed form. This keeps 30+ buildings affordable.
- **Detail by device.** PC Ultra uses about 400 to 800 joints per building, and phones use about 80 to 150 with the same rules. PC adds runtime fracture, so big shards split again on high-energy impacts.
- **Stable simulation.** A fixed 60 Hz physics step with sub-steps for heavy stacks stops tall buildings jittering or exploding.

### 4. Debris and rubble

- **Lifetime.** Shards stay physical for 3 to 8 seconds, then **sleep**. Sleeping shards near each other are **merged into one static rubble mesh** with a simple collider.
- **Piles.** Rubble piles keep their height, so streets fill up and the city stays visibly wrecked.
- **Throwable chunks.** Large chunks (slab pieces, columns) can be **grabbed and thrown** like cars.
- **Object pooling.** Shard bodies and particle emitters come from fixed pools that never allocate during play. When a pool runs out, the oldest debris is merged early. This is how the frame rate stays steady.

### 5. Effects that sell it

| Effect | Trigger | Technique |
| --- | --- | --- |
| Dust burst | Every detach | Soft camera-facing sprites, lit by the scene |
| Dust wave | Cluster hits the ground | Ring of expanding sprites rolling down the street |
| Lingering haze | After big collapses | Fog volume that thins over 20 s |
| Fire | Fuel tanks, cars, wood | Animated flame sprites + flickering point light |
| Sparks | Steel or electrical hits | Additive streaks with gravity |
| Glass shower | Window break | Instanced shards that reflect light |
| Power cuts | Substation or pylon destroyed | Nearby window lights switch off block by block |
| Ground cracks | Heavy stomp | Projected decal + small camera shake |

### 6. Vehicles and props

- **Crumpling.** Cars, buses, tanks and lamp posts are rigid bodies that crumple with a few damage-state meshes and squash a little on impact.
- **Explosions.** Cars **explode** after taking enough damage and set off a small damage sphere, which can trigger chain explosions in a car park.

### 7. Tuning controls

The debug panel opens with the backtick key, a gamepad's Back/Select, or a three-finger tap on a phone.
It edits `src/config.ts` live, and "Copy config JSON" exports tuned values.
From Phase 2 it must also expose:
- building health
- column load limit
- joint strength per material
- debris lifetime
- chunk count
- effect density

It already exposes gravity scale, movement, camera, render and weather values.

## City and environment

The arena is a fictional northern English town centre on a rainy night, about 400 m square, bordered by a canal and a Victorian railway viaduct.
The monster is 30 m tall, so brick terraces reach its knees and a 1960s tower block reaches its chest.

**Building types** (all procedurally generated, so each block looks different):

| Type | Height | Count | How it fails under simulation |
| --- | --- | --- | --- |
| Victorian brick terraces + corner shops | 2 to 4 floors | 14 to 18 | Weak mortar joints: walls crumble into bricks, chimneys topple, slate roofs slide off |
| 1960s concrete tower block | 14 to 20 floors | 3 to 4 | Panel joints fail in turn, so floors pancake down |
| Victorian town hall with clock tower | 3 floors + 50 m tower | 1 | Showpiece: the stone tower leans and falls across the market square |
| Glass office block | 8 to 12 floors | 4 to 6 | Glass shatters, steel frame bends, then snaps |
| Multi-storey car park | 5 floors | 1 | Slabs drop onto parked cars, setting off chain explosions |
| Railway viaduct | Brick arches | 1 | Arches fail one by one; a parked train can fall off |
| Church with spire | 1 + spire | 1 | Spire snaps at its base and shatters |
| Gasholder + substation | n/a | 1 each | Gas fireball; power cuts across nearby streets |

**Props:**
- red double-decker buses, black cabs, about 60 cars, and a train on the viaduct
- red phone boxes, post boxes, bus shelters, lamp posts, traffic lights, pub signs and trees

Every prop is a physics object from Phase 3. The graphics pass added these as static, instanced dressing first.

**Lighting and mood:**
- Rain is on by default.
- Orange sodium and white LED street lights reflect off wet tarmac and cobbles.
- Pub windows and shop signs are warm.
- As the town burns, fires and Basalt's lava cracks become the main light sources.

## Monster and controls

The first monster is **Basalt**, a hulking lava-cored rock beast about 30 m tall. Its glowing cracks give off light.
Its heavy, slow-to-turn movement suits a destruction showcase.

**Model:** a hunched rock golem built procedurally from basalt-column bundles and rock chunks on a bone rig, with a procedural rock-and-lava material.
It has procedural animation (foot-planted walk and run, leaning, arm swings, idle breathing). Hand-made models and motion-captured animation can come later.

**Move set** (Phase 4)

| Move | Keyboard / pad | Phone | What it does to the city |
| --- | --- | --- | --- |
| Walk / run | WASD / left stick | Left thumb joystick | Feet crush cars and small props; running through low buildings bulldozes them |
| Light punch combo | J / X | Tap Punch | 3-hit combo, small damage sphere, chips walls |
| Heavy punch | K / Y | Hold Punch | Charged, big impulse, punches clean through a floor |
| Stomp | L / B | Tap Stomp | Ground-pound ring: shatters glass, flips cars, cracks roads |
| Grab | Space / A | Tap Grab | Picks up a car, bus, black cab, debris chunk or a building's top section |
| Throw | Space again (aim with camera) | Tap Grab again | Thrown object becomes a damage capsule and fractures whatever it hits |
| Shoulder charge | Shift / RB | Swipe forward | Runs through buildings, cutting a tunnel through the lower floors |
| Climb | Walk into a tall building | Same | Climbs up; damages the façade as it goes and can bring the top down |
| Special: Magma Burst | Q / LT+RT | Special button (fills from destruction) | Huge radial blast, the biggest collapse trigger in the demo |
| Roar | R / D-pad | Roar button | Camera push-in, shakes nearby windows loose |

Phase 1 binds Shift, RT and RB to **run**. Shoulder charge takes Shift and RB in Phase 4, so give run a new binding then: a double-tap, or L3 and RT on a pad.

**Destruction meter:** destroying things fills the special-move bar and adds to a score shown as £ of damage, like an insurance bill.
This gives the demo a reason to keep smashing.

**Camera:** third-person, about 45 m behind and above (pulled back further on portrait phone screens).
It pulls back during collapses so you see the whole fall, and briefly slows to 30 % speed when a skyscraper goes over. Slow motion is on by default and can be turned off in settings.

**Input:** keyboard and mouse, any standard gamepad (Gamepad API), and touch controls with a virtual stick and four large buttons.

## Graphics and game feel

The visual target is a stylised, cinematic night look, like a modern kaiju film rather than photorealism.
A stylised look hides the limits of browser rendering and stays sharp on phones.
The graphics pass has implemented most of the rendering list below. What remains is the polish round in `handoff.md`.

**Rendering features**

- Physically based, procedural materials (brick, sandstone, concrete, slate, glass, wet tarmac, cobbles) with an environment map for reflections
- Cascaded shadows from the moon; point lights from street lamps, fires and the monster's lava cracks
- A night sky with moonlit cloud and town-glow at the horizon; distance and height fog
- Post-processing: bloom (neon, fire, lava), tone mapping, ambient occlusion, screen-space reflections on wet streets, light film grain and colour grade
  - Still to do: motion blur on big hits (Ultra only)
- Lit window interiors drawn as a cheap fake depth effect, so towers look occupied without real geometry
- Rain lit by street lamps, splashes and puddle ripples, and soft light cones under lamps
- Instancing and geometry merging for windows, street furniture, debris and particles, so thousands of objects cost a few draw calls

**Game feel ("juice")** (Phase 4). These matter more than polygon count:

| Technique | Used on |
| --- | --- |
| Hit-stop (40 to 80 ms freeze) | Heavy punches, throws landing |
| Screen shake scaled to distance and size | Stomps, collapses, explosions, Basalt's footsteps |
| Slow motion (0.3× for 1.5 s) | Skyscraper topples, chain reactions |
| Controller rumble | Every impact (gamepad and phone vibration) |
| Camera kick toward the impact | Punches, charge |
| Low-pass audio thump then rumble | Big collapses |

**Audio** (Phase 5):
- Layered impacts (crack + crumble + debris rain), glass tinkle, metal groans before a collapse, distant sirens, car alarms that start after nearby hits, and a roar.
- Sounds come from free licensed libraries or are synthesised.
- Music is a looping percussion track that gets more intense as the destruction meter rises.

## Milestones

Destruction comes first. Phases 2 and 3 make buildings fall and keep the frame rate steady before any time goes into moves or more visual polish.
Each phase ends with a playable link on GitHub Pages. The owner tests the gate on their own phone and PC, and the next phase starts only when the gate passes.

> The original roadmap diagram (5 phases, 4 gates) was lost when the plan was exported.
> The phases below are reconstructed from the rest of this document. The owner should confirm them before Phase 2 starts.

| Phase | Builds | Gate (tested by the owner) |
| --- | --- | --- |
| **1 · Foundations** ✅ built | Vite + TS project, WebGPU renderer with WebGL 2 fallback, Rapier at a fixed 60 Hz, blockout town on a 400 m ground, Basalt with walk/run, follow camera, keyboard/gamepad/touch controls, debug panel and stats overlay | It runs on the owner's phone and PC; controls feel right; the stats overlay shows fps, bodies, joints and draw calls |
| **2 · Destruction core** | Floors × bays building generator, Voronoi pre-fracture, breakable joints with per-step stress checks, materials, wake/sleep buildings, debris pools and rubble merging, plus a test damage sphere (debug punch). Destruction tunables in the debug panel | A punch takes out the piece it hits; removing supports makes the floors above fall under gravity alone; a full collapse of one tower block holds the tier frame rate on a phone |
| **3 · Scale and performance** | The whole town destructible (25–40 buildings), momentum damage and chain collapses, cluster-first falling, hard chunk caps per tier, vehicles and props as physics objects, car explosions | A district-wide chain collapse holds 30 fps on a mid-range phone and 60 fps on PC; the town stays visibly wrecked afterwards |
| **4 · Moves and game feel** | Full move set (punch combo, heavy punch, stomp, grab, throw, charge, climb, Magma Burst, roar), destruction meter and £ score, hit-stop, screen shake, slow motion, camera pull-back, rumble | Every move feels weighty on keyboard, gamepad and touch; smashing is satisfying |
| **5 · Effects, audio and polish** | Dust, fire, sparks, glass, power cuts, ground cracks, audio and music, settings (slow motion on/off, quality), and finishing the graphics polish | Ships as the demo link |

## Risks and decisions

The biggest risk is phone performance when many buildings fall at once.
Debris pooling and rubble merging are built in Phase 2, before more polish, for that reason. Fully simulated collapses cost more, so phones use coarser pieces that follow the same rules.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Too many live physics bodies during a chain collapse | Frame rate drops to single digits | Hard cap on active chunks, early rubble merge, cluster-first falling |
| WebGPU missing or failing on some phones | Black screen or crash | Automatic WebGL 2 fallback, including a reload onto WebGL 2 if the WebGPU device is lost after start-up; test on iPhone and Android |
| Collapse looks floaty or fake | Destruction feels cheap | Use true scale (30 m monster, real masses), correct gravity, heavy dust and slow motion. Never slow the physics itself |
| Procedural buildings look samey | City feels like a test level | Varied façade kits, signage, rooftop clutter, colour variation |
| Touch controls feel clumsy | Hard to play on phone | Large buttons, auto-aim for grab and throw, playtest on the owner's phone |
| Graphics cost on phones | Phones miss 30 fps | Every effect is gated by the quality tier; Low has no post-processing |
| Scope creep into a full game | Demo never ships | Fix demo scope (see Vision); log new ideas for later builds |

**Decisions made**

- [x] Monster: Basalt, the lava rock beast
- [x] Destruction: as realistic as possible, fully simulated physics
- [x] Devices: phone and PC equally
- [x] Setting: British town centre
- [x] Slow-motion collapse moments: on by default, can be turned off in settings
- [x] Police or army units: none in the demo; added in a later build
- [x] Working title: *Monster Brawl* for now
- [x] Graphics: as high quality as possible, held to a strict visual bar, pulled forward ahead of Phase 2 (owner's request, 3 Nov 2026)
- [x] Ultra anti-aliasing: SMAA for now; TRAA needs rain drawn after the resolve
- [x] Hosting: GitHub Pages from `main`

**Open questions**

- [ ] Final name for the demo
- [ ] Confirm the reconstructed Phase 2–5 roadmap above
- [ ] Which phones to treat as the "mid-range" reference for the 30 fps target
- [ ] Audio source: free libraries, synthesised, or commissioned

## Building with Claude Code

### Project layout

```text
MonsterGame/
  plan.md                  this document
  handoff.md               current state, open faults, next steps
  index.html
  package.json, vite.config.ts, tsconfig.json
  .github/workflows/pages.yml   deploy to GitHub Pages on push to main
  scripts/shot.cjs         headless screenshot harness for visual checks
  docs/screenshots/        reference shots of the current look
  src/
    main.ts                start-up: renderer, physics, town, monster, weather, game loop
    config.ts              every tunable number in one place
    core/
      types.ts             shared contracts between modules
      loop.ts              fixed 60 Hz physics step, variable-rate rendering
      input.ts             keyboard, gamepad, touch
      quality.ts           Low / Medium / High / Ultra presets, auto-detect
    render/
      renderer.ts          WebGPU with WebGL 2 fallback, lights, shadows
      sky.ts, environment.ts, post.ts   night sky, env map + fog, post-processing
      effects/             rain, splashes, light cones, puddle ripples (later: dust, fire, sparks, glass, decals)
    physics/
      world.ts             Rapier set-up (later: body and particle pools)
    destruction/           Phase 2
      building-gen.ts      floors × bays building generator
      fracture.ts          Voronoi pre-fracture of panels and slabs
      joints.ts            breakable joints, per-step stress check
      materials.ts         strength, mass and effects per material
      sleep.ts             wake/sleep buildings, rubble merging
    city/
      town-layout.ts       British town layout → visuals + colliders
      buildings.ts, landmarks.ts, materials.ts, dressing.ts, signage.ts, mesh-builder.ts
      props.ts             Phase 3: buses, cabs, cars as physics objects
    monster/
      basalt.ts            physics body and character controller
      basalt-model.ts, basalt-geom.ts, rock-material.ts, basalt-anim.ts   model, material, procedural animation
      moves.ts             Phase 4: damage shapes for each attack
    camera/
      follow-camera.ts     follow (later: pull-back on collapses, slow motion)
    audio/                 Phase 5: layered impact sounds, music intensity
    debug/
      panel.ts             live tuning panel and stats overlay
  public/                  textures, sounds, models
```

**Dependencies:** `three`, `@dimforge/rapier3d-compat`, `lil-gui`, `vite`, `typescript` (with `@types/three`).

### Conventions

- **Units are real-world:** 1 unit = 1 m, masses in kg, gravity 9.81 m/s². Basalt is 30 m tall.
- **Tunables:** every tunable value lives in `src/config.ts`, and the debug panel edits it live.
- **Quality tiers:** every expensive feature is gated by a field on the quality preset.
- **Stats overlay:** fps, active bodies, live joints and draw calls are always shown.
- **Testing:** the owner tests on their phone via the GitHub Pages link, or with `npm run dev -- --host` on home Wi-Fi.
- **Commits:** one commit per passed gate on `main`.

### Prompt for each phase

```text
Read plan.md and handoff.md. Build Phase N from plan.md. Meet its gate,
show me the stats overlay numbers, then stop and tell me how to test it on my phone.
```
