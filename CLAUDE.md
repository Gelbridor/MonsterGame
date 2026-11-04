# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Monster Brawl is a browser giant-monster city-destruction tech demo: Vite + TypeScript, Three.js r187 `WebGPURenderer` with TSL node materials (WebGL 2 fallback), Rapier 0.21 physics at a fixed 60 Hz. Live at https://gelbridor.github.io/MonsterGame/.

Which doc holds what (don't duplicate between them):

- **`CLAUDE.md`** (this file): stable orientation. Commands, architecture, conventions, working method.
- **`handoff.md`**: volatile state. What is on `main`, gate status, Phase 2 design notes, known faults, next steps. Read it before starting work; update it when you finish a chunk of work.
- **`plan.md`**: the owner's design. Its **Milestones** table defines each phase and its gate.

## Commands

```bash
npm install
npm run dev                          # http://localhost:5173 (`-- --host` serves the LAN; phones get WebGL 2, since WebGPU needs https)
npm run typecheck                    # tsc --noEmit, strict with noUnusedLocals/noUnusedParameters
npm run build                        # type-check + production build into dist/
node scripts/run-harness.cjs <test>  # headless destruction harness (see below)
```

There is no unit-test suite or linter. The checks are: type-check, the destruction harness, and screenshots.

**URL options:** `?webgl` / `?webgpu` force the backend; `?quality=low|medium|high|ultra` forces a tier (and disables dynamic resolution and auto step-down); `?quality=auto` clears a stored step-down; `?tonemap=agx` for tone-mapping A/B checks.

**Dev viewers** (served by `npm run dev`): `/src/destruction/viewer.html` (mock tower, fracture and piece rendering) and `/src/monster/viewer.html` (Basalt in isolation).

### Destruction harness

`node scripts/run-harness.cjs <test>` bundles `scripts/destruction-harness.ts` with rolldown into `scripts/.out/` and runs it in Node: the real `createDestruction`, real Rapier and the real town specs, with the null renderer from `src/destruction/debug-render.ts`. `LEVEL=low|medium|high|ultra` picks the tier.

- `t1` terrace punch; `t2` tower collapse (`MODES=cols,side,all,punch`, `EVERY=0.5`, `TRACE=1`); `t3` all buildings woken for 60 s (stability); `t4` cost per tier during a collapse; `t5` solve cost; `t6` replay a punch (`PUNCH=x,y,z`, `LONG=1`, `PROF=1` for Rapier timers); `t7` wake/break step costs; `t8` three punches (warm-up vs steady state); `t9` fracture shard counts.
- Timings are only meaningful on an otherwise idle machine; don't run several harnesses or headless browsers at once when measuring.

### Visual checks (screenshots)

```bash
node scripts/shot.cjs "http://localhost:5173/?webgl&quality=low" out.png --size 800x450 --wait 20000 --eval "..."
```

- Options are in the file header: `--size`, `--phone` (iPhone 13), `--wait`, `--keys "KeyW:1500,ArrowLeft:600"`, `--eval "<js>"` (`mb` is `window.mb`). Only console warnings/errors are forwarded, so log with `console.warn`.
- Headless Chromium has **no GPU** (SwiftShader): always pass `?webgl`. It runs at 1–5 fps and an ultra frame can take minutes, so trust CPU timings and draw-call counts, not fps. Medium at 960×540 sometimes crashes the page; use 800×450.
- Handy evals: `mb.config.weather.rain=0` (dry ground), `mb.basalt.object.visible=false` (unblocked city view), `mb.config.camera.distance` / `pitch` (framing), `mb.punchAt(x, y, z)` (debug punch). To time destruction in the browser, wrap `mb.destruction.fixedUpdate` / `syncVisual` with `performance.now()`.
- Judge the **default gameplay camera** first: the player sees it almost all the time. Save screenshots to the scratchpad; keep reference shots worth preserving in `docs/screenshots/`.

## Architecture

- **Contracts:** `src/core/types.ts` (`QualityPreset`, `RenderContext`, `Physics`, `Input`, `Town`, `Monster`, `FollowCamera`, `DebugUI`, `FrameStats`) and `src/destruction/types.ts` (`BuildingGraph`, `DestructionRenderer`, `DamageEvent`, `Destruction`). Modules talk through these; when parallelising work, change the contracts first.
- **Tunables:** every tunable number lives in `src/config.ts`. The debug panel (`src/debug/panel.ts`, lil-gui; backtick, gamepad Back, or three-finger tap) builds itself from `config` and edits it live, so read `config` at the point of use rather than caching values. Add slider ranges for new keys in the panel's `META` table.
- **Quality:** `src/core/quality.ts` defines Low/Medium/High/Ultra (budgets in `plan.md`). `probeGpu()` + `classifyGpu()` pick tier and backend from the GPU (integrated/software GPUs get WebGL 2). Priority: `?quality=` URL, then the stored auto step-down (`localStorage` `mb.qualityAuto`), then the GPU heuristic. Dynamic render resolution and an automatic one-tier step-down run at runtime. Gate every new expensive feature on a preset field; phones and integrated GPUs must stay viable.
- **Main loop** (`src/main.ts`, `src/core/loop.ts`). Each fixed tick: input → `basalt.fixedUpdate` → punch → `physics.step` → `destruction.fixedUpdate`. Each frame: interpolate Basalt → camera → weather → `destruction.syncVisual` → render → stats. `window.mb` exposes `config`, `ctx`, `physics`, `basalt`, `town`, `destruction`, `punchAt`, `rain`, `splashes`, `cones`.
- **Rendering** (`src/render/`): `renderer.ts` picks the backend and reloads onto WebGL 2 if the WebGPU device is lost; `post.ts` is the RenderPipeline (MRT, bloom, GTAO, SSR with soft knee, SMAA/FXAA, filmic grade). Ultra uses SMAA, not TRAA, because rain writes no velocity (TRAA needs rain drawn after the resolve). `effects/weather-common.ts` is the lamp registry (`setWeatherLamps`) shared by rain, splashes and light cones; `effects/rain-ripples.ts` is the TSL puddle normal used by city materials. `effects/dev-preview.ts` is a dev harness, not imported by the game.
- **City** (`src/city/`): `town-layout.ts` turns layout data into `BuildingSpec`s, visuals and colliders. `buildTown` returns `specs`, `buildingRanges` (triangle ranges per building) and `mergedParts`, which the destruction renderer uses to take over one building's triangles. `materials.ts` is a TSL material library driven by live wetness/rain uniforms. `dressing.ts` places lamps with real `PointLight`s, capped by `quality.maxDynamicLights`.
- **Destruction sim** (`src/destruction/`): `index.ts` (step, contact events, damage), `building-gen.ts` (floors × bays piece/bond graph per tier), `joints.ts` (groups as compound Rapier bodies, bonds, crushing, `designBonds`), `stress.ts` (PCG structural stress solver with a per-step time budget), `materials.ts`, `sleep.ts` (wake, body pool, shards, rubble baking, chunk cap). Rapier does all motion; the stress solver decides which bonds break. See `handoff.md` for the solver design.
- **Destruction visuals:** `piece-render.ts` (clips a woken building's town triangles against piece planes and hides only the pieces that move or break), `fracture.ts` (deterministic Voronoi box fracture), `piece-materials.ts`. `debug-render.ts` is the harness's null renderer and uses its own box fracture, so the harness can miss real fracture bugs.
- **Basalt** (`src/monster/`): `basalt.ts` is the kinematic character controller; **don't change its movement behaviour**. Model, geometry, rock/lava material and procedural animation (walk/run/idle with foot planting) are in `basalt-model.ts`, `basalt-geom.ts`, `rock-material.ts`, `basalt-anim.ts`. Footstep events come from `onFootstep` / `drainFootsteps()`.
- **Input** (`src/core/input.ts`): keyboard, gamepad, touch. A new keyboard key must be added to `GAME_KEYS` or its presses are dropped.
- `src/audio/` is planned for Phase 5 and is empty.

## Conventions

- Units are real-world: 1 unit = 1 m, kg, 9.81 m/s². Basalt is 30 m tall. Angle 0 faces −Z; positive is counter-clockwise from above.
- Every push to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`). The owner merges PRs on GitHub, so fetch before working on `main`.
- One commit per passed gate on `main`. Commit messages end with a `Co-Authored-By:` line. No model names in code, docs or commits.
- No history rewrites (force-push and amend are blocked by the safety classifier); fix mistakes with follow-up commits.
- If git has no identity configured, commit with `git -c user.name=Claude -c user.email=noreply@anthropic.com`.
- Owner's performance reference machine: ThinkPad T480 (Intel UHD 620), which is GPU (fragment) bound. Its measured numbers are in `handoff.md`.

## Working method

The owner wants small tasks given to subagents, each reviewed before merging:

- Write the shared contracts (types, config fields, stub hooks) first, so parallel agents can build against them.
- Give each agent its own git worktree under `.claude/worktrees/` (git-ignored), its own files and its own dev-server port, and require it to iterate on screenshots in the scratchpad. On the owner's Windows machine, agent worktree isolation is refused: create worktrees by hand and junction `node_modules` with `mklink /J`.
- View **every** screenshot before merging, including ones the agent says it didn't check, and reply with concrete, prioritised fixes. After merging, run a whole-scene check across tiers and `--phone`: cross-module faults (bloom on lava, double-counted reflections, rain under TRAA, keys not registered, shard-count blow-ups) only show up in-game.
- Never `git add -A` from the repo root while worktrees exist under `.claude/`.
- Background agents sometimes re-send their final report; stop them with `TaskStop` once handled.
- If Playwright is missing after a fresh `npm install` (not in cloud sessions, where it is pre-installed): `npm install --no-save playwright && npx playwright install chromium`.
