# Monster Brawl — Destruction Tech Demo Plan

Nov 2, 2026 · @Tommy

## Vision and goals

The demo proves one thing: smashing a city as a giant monster in a browser can feel as weighty and satisfying as the PS2 classic, with modern visuals. One monster, one city block, no opponent yet.

**Destruction-first pillars**

1. **Everything big breaks.** Every building, bridge, tower and vehicle can be damaged, broken apart and brought down.
2. **Damage is local, then structural.** A punch takes out the chunk it hits. Remove enough support and the floors above fall.
3. **Debris matters.** Rubble stays, piles up, can be picked up and thrown, and blocks paths.
4. **Real physics, not scripts.** Buildings fall because gravity overloads their joints, not because an animation plays. Leaning, pancaking and toppling all come from the simulation.
5. **It runs on a phone.** Phones run the same physics rules with coarser pieces. A mid-range phone holds 30 fps and a PC holds 60.

**In scope for the demo:** one original monster, about a 400 m × 400 m British town centre at night, 25 to 40 destructible buildings, vehicles and street props, punch/stomp/grab/throw/charge moves, dust, fire, glass, sparks and screen shake.

**Out of scope (later builds):** a second monster or AI opponent, police or army units, multiplayer, menus, story, multiple cities, power-ups.

**Originality:** the monster, city, name and audio are all new. Nothing is copied from the original game's characters, levels or branding. The working title is *Monster Brawl* until you pick a name.

## Tech stack and performance budget

The game uses Three.js for rendering, Rapier for physics, and Vite for builds, and is published as a single web link.

| Layer | Choice | Why |
| --- | --- | --- |
| Rendering | Three.js, WebGPU renderer with WebGL 2 fallback | Modern lighting and post-processing; works on iPhone Safari and desktop Chrome |
| Physics | Rapier (Rust compiled to WebAssembly) | Fast rigid bodies, can sleep thousands of idle chunks, deterministic |
| Fracture | Pre-fractured shards linked by breakable physics joints; extra runtime fracture on PC | Real-time fracturing is too slow on phones; pre-cut pieces look the same |
| Effects | GPU particles (instanced), decals, volumetric-style dust sprites | Thousands of particles for little CPU cost |
| Audio | Web Audio API with layered, pitch-varied samples | Every impact sounds different |
| Build | Vite + TypeScript | Quick reloads while tuning; small output |
| Assets | Procedural buildings in code first; glTF models later | Gets to playable fast without an artist |
| Hosting | Published artifact link (later: GitHub Pages or itch.io) | Open on phone or PC instantly |

**Performance budget (per frame)**

| Target | Frame rate | Active physics chunks | Particles | Shadow quality |
| --- | --- | --- | --- | --- |
| PC (Ultra) | 60 fps | 1,500 | 20,000 | 2,048 px cascaded |
| PC (High) | 60 fps | 800 | 10,000 | 2,048 px |
| Phone (Medium) | 30 to 60 fps | 300 | 3,000 | 1,024 px, monster only |
| Phone (Low) | 30 fps | 150 | 1,000 | Blob shadows |

Idle debris is put to sleep and, after a delay, merged into one static rubble mesh. That keeps a fully wrecked city cheap to draw.

## Destruction system

Each building is a graph of breakable pieces linked by joints. A hit damages pieces, broken pieces fall away, and a support check each frame decides what else falls with them.

&#91;embedded content: damage-to-collapse loop · 8 steps\]

The loop back from “Impact on landing” is what turns one punch into a district-wide collapse. Debris that comes to rest is merged so a fully wrecked city stays cheap to draw.

### 1. How a building is built

- **Floors × bays grid.** A building is generated as a grid: for example 12 floors × 4 × 4 bays. Each cell holds a few pieces: a floor slab, corner columns, wall panels and windows.
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

- Each attack has a **damage shape** (a sphere for punches, a ring for stomps, a capsule for a charge or a thrown car) with a damage value and an impulse.
- Pieces inside the shape lose health according to distance. A piece at 0 health **detaches**: its shards become live Rapier bodies and fly off with the impulse.
- Pieces that are hurt but not broken get **crack decals** and darker textures, so damage builds up visibly over time.
- Glass breaks in a radius around any hit, even a small one. A whole façade can shatter in one shockwave.

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

- Shards stay physical for 3 to 8 seconds, then **sleep**. Sleeping shards near each other are **merged into one static rubble mesh** with a simple collider.
- Rubble piles keep their height, so streets fill up and the city stays visibly wrecked.
- Large chunks (slab pieces, columns) can be **grabbed and thrown** like cars.
- **Object pooling:** shard bodies and particle emitters come from fixed pools that never allocate during play. When a pool runs out, the oldest debris is merged early. This is how the frame rate stays steady.

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

- Cars, buses, tanks and lamp posts are rigid bodies that crumple with a few damage-state meshes and squash a little on impact.
- Cars **explode** after taking enough damage and set off a small damage sphere, which can trigger chain explosions in a car park.

### 7. Tuning controls

A debug panel (press backtick, or tap with three fingers on a phone) exposes building health, column load limit, debris lifetime, chunk count, joint strength per material, gravity scale and effect density. These values can be tuned live while playing.

## City and environment

The arena is a fictional northern English town centre on a rainy night, about 400 m square, bordered by a canal and a Victorian railway viaduct. The monster is 30 m tall, so brick terraces reach its knees and a 1960s tower block reaches its chest.

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

**Props:** red double-decker buses, black cabs, about 60 cars, a train on the viaduct, red phone boxes, post boxes, bus shelters, lamp posts, traffic lights, pub signs and trees. Every prop is a physics object.

**Lighting and mood:** rain is on by default. Orange sodium and white LED street lights reflect off wet tarmac and cobbles, with warm pub windows and shop signs. As the town burns, fires and Basalt's lava cracks become the main light sources.

## Monster and controls

The first monster is **Basalt**, a hulking lava-cored rock beast, about 30 m tall. Its glowing cracks give off light, and its heavy, slow-to-turn movement suits a destruction showcase. Two alternative concepts are listed in the open questions below.

**Model:** built first from simple shapes and procedural rock material, with a bone rig and procedural animation (stepping, leaning, arm swings). Hand-made models and motion-captured animation can come later.

**Move set**

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

**Destruction meter:** destroying things fills the special-move bar and adds to a score shown as £ of damage, like an insurance bill. This gives the demo a reason to keep smashing.

**Camera:** third-person, about 45 m behind and above. It pulls back during collapses so you see the whole fall, and briefly slows to 30% speed when a skyscraper goes over (on by default; can be turned off in settings).

**Input:** keyboard and mouse, any standard gamepad (Gamepad API), and touch controls with a virtual stick and four large buttons.

## Graphics and game feel

The visual target is a stylised, cinematic night look: think modern kaiju film rather than photorealism. A stylised look hides the limits of browser rendering and stays sharp on phones.

**Rendering features**

- Physically based materials (concrete, glass, metal, wet tarmac) with an environment map for reflections
- Cascaded shadows from the moon; point lights from fires and the monster's lava cracks
- Post-processing: bloom (neon, fire, lava), tone mapping, ambient occlusion, depth haze, light film grain, motion blur on big hits (Ultra only)
- Lit window interiors drawn as a cheap fake depth effect, so towers look occupied without real geometry
- Instancing for windows, cars, debris and particles, so thousands of objects cost a few draw calls

**Game feel ("juice")** — these matter more than polygon count:

| Technique | Used on |
| --- | --- |
| Hit-stop (40 to 80 ms freeze) | Heavy punches, throws landing |
| Screen shake scaled to distance and size | Stomps, collapses, explosions |
| Slow motion (0.3× for 1.5 s) | Skyscraper topples, chain reactions |
| Controller rumble | Every impact (gamepad and phone vibration) |
| Camera kick toward the impact | Punches, charge |
| Low-pass audio thump then rumble | Big collapses |

**Audio:** layered impacts (crack + crumble + debris rain), glass tinkle, metal groans before a collapse, distant sirens, car alarms that start after nearby hits, and a roar. Sounds come from free licensed libraries or are synthesised. Music is a looping percussion track that gets more intense as the destruction meter rises.

## Milestones

Destruction comes first. Phases 2 and 3 make buildings fall and keep the frame rate steady before any time goes into moves or visual polish.

&#91;embedded content: build roadmap · 5 phases, 4 gates\]

Each phase ends with a playable link. You test the gate on your own phone or PC, and the next phase starts only when it passes.

## Risks and decisions

The biggest risk is phone performance when many buildings fall at once. Debris pooling and rubble merging are built in phase 2, before the art is polished, for that reason. Fully simulated collapses cost more, so phones use coarser pieces that follow the same rules.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Too many live physics bodies during a chain collapse | Frame rate drops to single digits | Hard cap on active chunks, early rubble merge, cluster-first falling |
| WebGPU missing on some phones | Black screen or crash | Automatic WebGL 2 fallback, tested on iPhone and Android |
| Collapse looks floaty or fake | Destruction feels cheap | Use true scale (30 m monster, real masses), correct gravity, heavy dust and slow motion. Never slow the physics itself |
| Procedural buildings look samey | City feels like a test level | Varied façade kits, signage, rooftop clutter, colour variation |
| Touch controls feel clumsy | Hard to play on phone | Large buttons, auto-aim for grab and throw, playtest on your phone |
| Scope creep into a full game | Demo never ships | Fix demo scope (section 1); log new ideas for later builds |

**Decisions made**

- [x] Monster: Basalt, the lava rock beast
- [x] Destruction: as realistic as possible, fully simulated physics
- [x] Devices: phone and PC equally
- [x] Setting: British town centre
- [x] Slow-motion collapse moments: on by default, can be turned off in settings
- [x] Police or army units: none in the demo; added in a later build
- [x] Working title: *Monster Brawl* for now

## Handoff to Claude Code

Export this doc as Markdown, save it in a new folder as `PLAN.md`, and give Claude Code the starter prompt below. It builds one phase at a time and stops at each gate for you to test.

**Project layout**

```text
monster-brawl/
  PLAN.md                  this document
  index.html
  package.json
  vite.config.ts
  src/
    main.ts                start-up: renderer, physics, game loop
    config.ts              every tunable number in one place
    core/
      loop.ts              fixed 60 Hz physics step, variable-rate rendering
      input.ts             keyboard, gamepad, touch
      quality.ts           Low / Medium / High / Ultra presets, auto-detect
    render/
      renderer.ts          WebGPU with WebGL 2 fallback, post-processing
      effects/             dust, fire, sparks, glass, crack decals
    physics/
      world.ts             Rapier set-up, body and particle pools
    destruction/
      building-gen.ts      floors x bays building generator
      fracture.ts          Voronoi pre-fracture of panels and slabs
      joints.ts            breakable joints, per-step stress check
      materials.ts         strength, mass and effects per material
      sleep.ts             wake/sleep buildings, rubble merging
    city/
      town-layout.ts       British town centre layout
      props.ts             buses, cabs, cars, phone boxes, lamp posts
    monster/
      basalt.ts            rig and procedural animation
      moves.ts             damage shapes for each attack
    camera/
      follow-camera.ts     follow, pull-back on collapses, slow motion
    audio/                 layered impact sounds, music intensity
    debug/
      panel.ts             live tuning panel and stats overlay
  public/                  textures, sounds, models
```

**Dependencies:** `three`, `@dimforge/rapier3d-compat`, `lil-gui`, `vite`, `typescript`.

**Conventions**

- Units are real-world: 1 unit = 1 m, masses in kg, gravity 9.81 m/s². Basalt is 30 m tall.
- Every tunable value lives in `src/config.ts`, and the debug panel edits it live.
- A stats overlay (fps, active bodies, live joints, draw calls) is on from Phase 1.
- Test on your phone with `npm run dev -- --host` on home Wi-Fi, or a GitHub Pages build.
- Make one git commit per passed gate.

**Starter prompt (Phase 1)**

```text
Read PLAN.md in this repo. It is the design for Monster Brawl, a browser
giant-monster destruction demo. Build Phase 1 (Foundations) only:

- Vite + TypeScript project using the layout in the Handoff section
- Three.js WebGPU renderer with automatic WebGL 2 fallback
- Rapier physics with a fixed 60 Hz step
- A blockout British town of box buildings on a 400 m ground plane
- Basalt as a 30 m capsule with walk and run, a follow camera,
  and keyboard, gamepad and touch controls
- The debug panel and stats overlay

Stop at the Phase 1 gate and tell me how to test it on my phone.
```

**Later phases:** `Build Phase N from PLAN.md. Meet its gate, show me the stats overlay numbers, then stop.`
