# Monster Brawl: handoff

State of the work as of 3 Nov 2026, written so another agent can pick it up cold.

- **Design:** read [`plan.md`](plan.md) first. Its **Milestones** table defines each phase and its gate.
- **Look:** see the reference screenshots in [`docs/screenshots/`](docs/screenshots/).

## Where things are

| Branch | State | What it holds |
| --- | --- | --- |
| `main` | **Live** at https://gelbridor.github.io/MonsterGame/ (`6236594`) | Phase 1 Foundations **plus the graphics pass** (merged via PR #1), including the known faults below. **The Phase 1 gate is not signed off yet.** |
| `graphics-pass` | Merged into `main` | The branch the graphics pass was built on. Nothing new on it; start new work from `main`. |
| `wip/city-polish` | **Unreviewed** WIP (`9a2c0ed`) | An interrupted fix for the wet-ground faults (`src/city/materials.ts`, plus a `scripts/shots-batch.sh` helper). It type-checks and merges cleanly onto `main`. It has never been screenshot-reviewed. |
| `wip/basalt-polish` | **Unreviewed** WIP (`fdbc85c`) | An interrupted fix for Basalt's over-hot lava and hidden head (`basalt-model.ts`, `rock-material.ts`), plus a dev viewer (`src/monster/viewer.html` / `viewer.ts`). It type-checks and merges cleanly onto `main`. It has never been screenshot-reviewed. |

**History:**
- Phase 1 was built and deployed.
- The owner then asked for graphics "as high quality as possible, be strict", so a graphics pass was pulled forward from Phase 5, ahead of Phase 2.
- Destruction (Phase 2) has **not** been started.

The owner briefly saw the old Phase 1 build after the graphics merge. That was the Pages deploy finishing and the browser cache; the graphics build deployed successfully. The owner has not yet confirmed what they see.

## Next steps, in order

1. **Finish the graphics polish** on a new branch from `main`, e.g. `graphics-polish`.
   - Review `wip/city-polish` and `wip/basalt-polish` against the known faults below, then finish and merge them.
   - Don't merge either branch without viewing its screenshots.
2. **Run a whole-scene check:**
   - Cover ultra, high, medium and low, plus `--phone`, from the default gameplay camera.
   - Confirm the rain is subtle on ultra and high; that was only verified on medium.
   - Compare against `docs/screenshots/`.
3. **Merge into `main`**, which deploys to Pages. Ask the owner to test on their phone and PC.
4. **Get Phase 1 gate sign-off** from the owner. Ask them to confirm the reconstructed Phase 2–5 roadmap in `plan.md` (the original diagram was lost).
5. **Start Phase 2 (destruction core)** from `plan.md`. Destruction comes first now; don't add more visual polish before it.

## Known faults on `main` (the owner's bar is strict)

- **City wet ground** (see `docs/screenshots/graphics-ultra-dry.jpg`):
  - **White "snow/frost" patches** on roads, pavement edges and roofs. The likely cause is the city material's own fake sky reflection double-counting with the real env map and SSR, plus unclamped puddle specular. Wet tarmac must read **dark**, with bright reflections only of lamps, windows and signs.
  - **Market-square puddles** are giant dark "camouflage" blobs with dithered, pixelated edges. Target about 15–25 % coverage, concentrated at kerbs and dips, with smooth anti-aliased edges.
  - **Cobbles and flagstones** alias into "TV static" at 20–60 m. Filter them by pixel footprint (`fwidth`), as the brick shader already does.
- **Basalt under bloom:**
  - **Glow:** the whole body glows yellow. Only the chest core, eyes/mouth and joint collars should be white-hot. Limb cracks should be orange-red, thinner and about 35–50 % dimmer, and roughly half the rock should show no cracks from the gameplay camera.
  - **Head:** hidden from the gameplay camera (behind and above).
  - **Feet:** planted feet have never been proven slide-free in motion.
- **Anti-aliasing:** ultra uses SMAA, not TRAA, because rain writes no velocity and TRAA smeared the frame. To get TRAA back, draw rain after the TRAA resolve (an overlay pass in `src/render/post.ts`).
- **Optional:** Basalt's lava doesn't light the rain. To add it, re-register Basalt's chest position in `setWeatherLamps` each frame, without per-frame allocation.
- **Verification gap:** everything was verified only on software WebGL 2 (see Testing). **WebGPU rendering, real frame rates and real devices are untested.**

## How it's built

Vite + TypeScript, Three.js r187 `WebGPURenderer` with TSL node materials (automatic WebGL 2 fallback, including a reload onto WebGL 2 if the WebGPU device is lost), and Rapier 0.21 physics with a fixed 60 Hz step.

- **`src/core/types.ts`** holds the contracts between modules: `QualityPreset`, `RenderContext`, `Physics`, `Input`, `Town`, `Monster`, `FollowCamera` and `DebugUI`.
- **`src/config.ts`** holds every tunable number. The debug panel (`src/debug/panel.ts`) auto-builds from it and edits it live, so modules read `config` when they use a value. Add slider ranges for new keys in the panel's `META` table.
- **`src/core/quality.ts`** defines the Low / Medium / High / Ultra tiers (see the budget table in `plan.md`). They are auto-detected, and `?quality=` overrides. Gate every new expensive feature on a preset field; phones must stay viable.
- **`src/main.ts`** wires everything together.
  - Each fixed tick: input → `basalt.fixedUpdate` → `physics.step`.
  - Each frame: interpolate Basalt → follow camera → rain/splashes/cones update → shadow focus → render → stats.
  - `window.mb` exposes `config`, `ctx`, `physics`, `basalt`, `town`, `rain`, `splashes` and `cones` for debugging.
- **Units:** 1 unit = 1 m, kg, 9.81 m/s². Basalt is 30 m tall.
- **Angle convention:** 0 = facing −Z, positive = counter-clockwise from above.

| Area | Files |
| --- | --- |
| Renderer, sky, env, post | `src/render/renderer.ts`, `sky.ts`, `environment.ts` (PMREM env + fog), `post.ts` (RenderPipeline: MRT, bloom, GTAO, SSR, SMAA/FXAA, filmic grade) |
| Weather | `src/render/effects/rain.ts`, `splashes.ts`, `light-cones.ts`, `rain-ripples.ts` (TSL puddle normal used by city materials), `weather-common.ts` (lamp registry: `setWeatherLamps`). `dev-preview.ts` is a dev-only harness, not imported by the game. |
| City | `src/city/town-layout.ts` (layout data → visuals + colliders), `buildings.ts`, `landmarks.ts`, `materials.ts` (TSL material library with live wetness/rain uniforms), `dressing.ts` (lamps with real point lights, street furniture), `mesh-builder.ts` (geometry batching), `signage.ts` (sign atlas) |
| Basalt | `src/monster/basalt.ts` (kinematic character controller; **don't change movement behaviour**), `basalt-model.ts`, `basalt-geom.ts`, `basalt-anim.ts` (procedural walk / run / idle with foot planting), `rock-material.ts` |
| Camera, input, debug | `src/camera/follow-camera.ts`, `src/core/input.ts` (keyboard, gamepad, touch), `src/debug/panel.ts` |
| Physics | `src/physics/world.ts` |

**Hooks ready for Phase 2:**
- **Buildings:** generated per `BuildingSpec`. `buildTown` returns `specs`, `buildingRanges` (triangle ranges per building) and `mergedParts`, so a single building's merged visuals can be hidden and replaced by a fracturable version. Colliders are still one simple box per building part, as in Phase 1.
- **Footsteps:** Basalt exposes `onFootstep` / `drainFootsteps()` (foot, world position, strength) for screen shake and dust.
- **Lamps:** the town exposes `lampPositions`, `lampColors` and `lights` (real `PointLight`s, capped by `quality.maxDynamicLights`).
- **Empty folders:** `src/destruction/` and `src/audio/` exist but are empty. Git doesn't track empty folders.

## Testing

- **Run it:**
  - `npm install`, then `npm run dev`. Add `-- --host` for phones on the same Wi-Fi; those get WebGL 2, because WebGPU needs https.
  - `npm run build` type-checks and builds.
  - URL options: `?webgl` forces WebGL 2; `?quality=low|medium|high|ultra`.
- **Visual checks:** `node scripts/shot.cjs "http://localhost:<port>/?webgl&quality=ultra" out.png --size 960x540 --wait 15000`.
  - The file header documents `--keys` (hold keys), `--eval` (JS with `mb` = `window.mb`) and `--phone`.
  - Useful tricks:
    - `--eval "mb.config.weather.rain=0"` gives dry ground.
    - `mb.basalt.object.visible=false` gives an unblocked city close-up.
    - Adjusting `mb.config.camera.distance` / `pitch` changes the framing.
  - **This headless Chromium has no GPU.** WebGPU is broken, so always pass `?webgl`. Software WebGL runs at about 1–5 fps, and an ultra frame can take minutes (the screenshot timeout is 240 s). Use 960x540, and don't trust its fps numbers.
  - Judge the **default gameplay camera** first: the player sees it almost all the time.
  - The scratchpad doesn't survive between sessions, so keep important reference shots in `docs/screenshots/`.
- **Deploying:** every push to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`). Pages is enabled.

## Working method that was used

The owner asked for work to be split into tasks for Sonnet subagents, each reviewed before merging. That worked well:

- Write the shared contracts (types, config fields, stub hooks) first, so parallel agents can build against them.
- Give each agent its own git worktree, its own files and its own dev-server port, and require it to iterate on screenshots saved to the scratchpad.
- View **every** screenshot before merging, including the ones an agent says it didn't check. Reject with prioritised, concrete fixes.
- After merging, do a whole-scene check. That is where the cross-module problems showed up: rain under TRAA, bloom on lava, double-counted reflections.

**Gotchas:**
- **Worktrees:** agent worktrees live under `.claude/` (in `.gitignore`), so never `git add -A` from the repo root while they exist.
- **Symlinked `node_modules`:** the `node_modules` rule (no trailing slash) ignores it in worktrees.
- **No history rewrites:** the auto-mode safety classifier blocks force-pushes and amends, so fix mistakes with follow-up commits.
- **Pull requests:** the owner merges PRs on GitHub, so `origin/main` can move. Fetch before working on `main`.

**Conventions:**
- One commit per passed gate on `main`.
- Commit messages end with a `Co-Authored-By:` line.
- No model names in code or docs.
