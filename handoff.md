# Monster Brawl: handoff

State of the work as of 3 Nov 2026, written so another agent can pick it up cold.
Read `plan.md` first: it is the design, and every phase and gate comes from it.

## Where things are

| Branch | State | What it holds |
| --- | --- | --- |
| `main` | Live on GitHub Pages (`646cd1e`) | Phase 1 Foundations **plus the graphics pass** (merged via PR #1), including the known faults below. **The Phase 1 gate has not been signed off by the user yet.** |
| `graphics-pass` | Same code as `main` | The branch the graphics upgrade was built on; every part was reviewed from screenshots. Continue polish here or on a fresh branch from `main`. |
| `wip/city-polish` | **Unreviewed** WIP (`9a2c0ed`) | An interrupted fix for the city's wet-ground faults (`src/city/materials.ts`). Type-checks; never screenshot-reviewed. |
| `wip/basalt-polish` | **Unreviewed** WIP (`fdbc85c`) | An interrupted fix for Basalt's over-hot lava and hidden head (`basalt-model.ts`, `rock-material.ts`), plus a dev viewer (`src/monster/viewer.*`). Type-checks; never screenshot-reviewed. |

Out of scope by user direction: after Phase 1 the user asked for graphics "as high quality as possible, be strict",
so the graphics pass jumped ahead of the plan's phase order. Destruction (Phase 2) has not been started.

## Immediate next steps

1. **Finish the graphics polish.**
   - Review `wip/city-polish` and `wip/basalt-polish` against the known faults below. Finish them, then merge into `graphics-pass`. Don't merge either blind.
2. **Final whole-scene check on `graphics-pass`.**
   - Cover ultra, high, medium and low, plus `--phone`.
   - Confirm that rain on ultra and high reads as subtle; this was only verified on medium.
3. **Merge the polish into `main`** (`graphics-pass` itself is already merged via PR #1).
   - That triggers the GitHub Pages deploy, so the user can test on a phone.
4. **Get the user's Phase 1 gate sign-off** (phone test), then start Phase 2 (destruction) from `plan.md`.
   - Destruction comes first per the plan; don't add more polish before it.

## Known faults in `graphics-pass` (the bar the user set is strict)

- **City wet ground**
  - White "snow/frost" patches on roads, pavement edges and roofs. The likely cause is the city material's own fake sky reflection double-counting with the real env map and SSR, plus unclamped puddle specular. Wet tarmac must read DARK, with bright reflections only of lamps, windows and signs.
  - Market-square puddles are giant dark "camouflage" blobs with dithered, pixelated edges. Target about 15–25 % coverage, concentrated at kerbs and dips, with smooth anti-aliased edges.
  - Cobbles and flagstones alias into "TV static" at 20–60 m. Filter them by pixel footprint (`fwidth`), as the brick shader already does.
- **Basalt under bloom**
  - The whole body glows yellow, so there is no contrast between hot and cold areas. Only the chest core, eyes/mouth and joint collars should be white-hot. Limb cracks should be orange-red, thinner and about 35–50 % dimmer, and roughly half the rock should show no cracks from the gameplay camera.
  - The head is hidden from the gameplay camera (behind and above).
  - Planted feet have never been proven slide-free in motion.
- **Anti-aliasing:** ultra uses SMAA, not TRAA, because rain writes no velocity and TRAA smeared the frame. To get TRAA back, draw rain after the TRAA resolve (an overlay pass in `src/render/post.ts`).
- **Lava light on rain (optional):** Basalt's lava does not light the rain. To add it, re-register Basalt's chest position in `setWeatherLamps` each frame, avoiding per-frame allocation.
- **Verification gap:** everything was verified only on software WebGL 2 (see Testing). **WebGPU rendering, real frame rates and real devices are all untested.**

## How it's built

Vite + TypeScript, Three.js r187 `WebGPURenderer` with TSL node materials (automatic WebGL 2 fallback), and Rapier 0.21 physics with a fixed 60 Hz step.

- **Shared contracts:** `src/core/types.ts` holds the interfaces between modules (`QualityPreset`, `RenderContext`, `Physics`, `Input`, `Town`, `Monster`, `FollowCamera`, `DebugUI`).
- **Tunables:** `src/config.ts` holds every tunable number. The debug panel edits it live, so modules read `config` at use time.
- **Quality presets:** `src/core/quality.ts` defines Low / Medium / High / Ultra, auto-detected; override with `?quality=`. Every graphics feature is gated by the preset (`post.*`, `cascadedShadows`, `maxDynamicLights`, `rainDrops`, `materialDetail`, `geometryDetail`). Phones must stay viable: pillar 5 of the plan.
- **Wiring:** `src/main.ts` connects everything. Per fixed tick: input → `basalt.fixedUpdate` → `physics.step`. Per frame: interpolate Basalt, follow camera, rain/splashes/cones update, render, stats.
- **Units:** real-world. 1 unit = 1 m, kg, 9.81 m/s². Basalt is 30 m tall.
- **Angle convention:** 0 = facing −Z, positive = counter-clockwise seen from above.

| Area | Files |
| --- | --- |
| Renderer, sky, env, post | `src/render/renderer.ts`, `sky.ts`, `environment.ts`, `post.ts` |
| Rain, splashes, light cones, puddle ripples | `src/render/effects/*` (`dev-preview.ts` is a dev-only harness, not imported by the game) |
| City | `src/city/town-layout.ts` (layout data → visuals + colliders), `buildings.ts`, `landmarks.ts`, `materials.ts` (TSL library), `dressing.ts` (lamps, street furniture, real point lights), `mesh-builder.ts`, `signage.ts` |
| Basalt | `src/monster/basalt.ts` (physics: kinematic character controller; don't change behaviour), `basalt-model.ts`, `basalt-geom.ts`, `basalt-anim.ts` (procedural walk / run / idle with foot planting; exposes footstep events), `rock-material.ts` |
| Camera, input, debug | `src/camera/follow-camera.ts`, `src/core/input.ts` (keyboard, gamepad, touch), `src/debug/panel.ts` (lil-gui + stats overlay) |
| Physics | `src/physics/world.ts` |

**Phase 2 hooks already in place:**
- **Buildings:** they are generated per `BuildingSpec`, and `buildTown` returns `specs`, `buildingRanges` and `mergedParts`, so one building's visuals can be swapped for a fracturable version. Colliders are the same simple boxes as Phase 1.
- **Footsteps:** Basalt exposes `onFootstep` / `drainFootsteps()` for shake and dust.
- **Lamps:** the town exposes `lampPositions`, `lampColors` and `lights`.

## Testing

- **Run it:**
  - `npm install`, then `npm run dev` (add `-- --host` for phones on the same Wi-Fi).
  - `npm run build` type-checks and builds.
  - URL options: `?webgl` forces WebGL 2; `?quality=low|medium|high|ultra`.
- **Visual checks:** `node scripts/shot.cjs "<url>?webgl&quality=ultra" out.png --size 960x540 --wait 15000`. Read the file header for `--keys`, `--eval` (`mb` = `window.mb`, which exposes config, ctx, physics, basalt, town and the rain effects) and `--phone`.
  - The headless Chromium here has **no GPU**: WebGPU is broken (always pass `?webgl`), and software WebGL runs at about 1–5 fps.
  - Ultra frames can take minutes, and the screenshot timeout is 240 s. Use 960x540.
  - Judge the **default gameplay camera** first, since the player sees it 95 % of the time.
- **Phone testing:**
  - Via GitHub Pages, every push to `main` deploys (`.github/workflows/pages.yml`).
  - Pages is enabled and deploying successfully from `main`.
  - Over plain `http://` on the LAN, phones get WebGL 2, not WebGPU.

## Working method that was used

The user asked for the work to be split into tasks for Sonnet subagents, each reviewed before merging. It went like this:

- I wrote the shared contracts (types, config, stub hooks) first, so parallel agents could build against them.
- Each agent worked in its own git worktree, owned specific files only, and ran a dev server on its own port.
- Each had to iterate on screenshots and save them to the scratchpad. The reviewer viewed every screenshot before merging, and rejected and re-briefed agents with prioritised, concrete fixes.
- After merging, a whole-scene check caught the cross-module problems (rain under TRAA, bloom on lava, double-counted reflections).

**Gotchas:**
- Agent worktrees live under `.claude/` (now in `.gitignore`), so never `git add -A` from the repo root while worktrees exist.
- Symlinked `node_modules` in worktrees is ignored by the `node_modules` (no trailing slash) rule.
- The auto-mode safety classifier blocks force-pushes and amends, so fix mistakes with follow-up commits.

**Conventions:**
- One commit per passed gate on `main`.
- Commit messages end with a `Co-Authored-By:` line.
- No model names in code or docs.
