# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Monster Brawl is a browser giant-monster city-destruction tech demo (Vite + TypeScript, Three.js r187 `WebGPURenderer` with TSL node materials, Rapier 0.21 physics). Read these before starting work:

- **`plan.md`** is the design. Its **Milestones** table defines each phase and its gate.
- **`handoff.md`** is the current state: which branches hold unreviewed WIP, known visual faults, and the ordered next steps. Update it when you finish a chunk of work.

## Commands

```bash
npm install
npm run dev              # http://localhost:5173 (add `-- --host` to serve on the LAN for phones; they get WebGL 2, since WebGPU needs https)
npm run typecheck        # tsc --noEmit
npm run build            # type-check + production build into dist/
```

There is no test suite or linter; `npm run typecheck` (strict, with `noUnusedLocals`/`noUnusedParameters`) is the automated check. Correctness of visual work is checked with screenshots.

URL options: `?webgl` forces the WebGL 2 backend; `?quality=low|medium|high|ultra` overrides the auto-detected preset.

### Visual checks (screenshots)

```bash
node scripts/shot.cjs "http://localhost:5173/?webgl&quality=ultra" out.png --size 960x540 --wait 15000
```

- Options are documented in the file header: `--phone`, `--keys "KeyW:1500,ArrowLeft:600"`, `--eval "<js>"` (where `mb` is `window.mb`).
- Headless Chromium here has **no GPU**: WebGPU is broken, so **always pass `?webgl`**. Software WebGL runs at ~1–5 fps and an ultra frame can take minutes; use 960x540 and ignore its fps numbers.
- Handy evals: `mb.config.weather.rain=0` (dry ground), `mb.basalt.object.visible=false` (unblocked city view), `mb.config.camera.distance` / `pitch` (framing).
- Judge the **default gameplay camera** first. Put screenshots in the scratchpad; keep reference shots worth preserving in `docs/screenshots/`.

## Architecture

- **`src/core/types.ts`** holds the contracts between modules (`QualityPreset`, `RenderContext`, `Physics`, `Input`, `Town`, `Monster`, `FollowCamera`, `DebugUI`). Modules talk to each other through these.
- **`src/config.ts`** holds every tunable number. `src/debug/panel.ts` (lil-gui, toggled with backtick) builds itself from `config` and edits it live, so modules must read `config` at the point of use rather than caching values. Add slider ranges for new keys in the panel's `META` table.
- **`src/core/quality.ts`** defines the Low/Medium/High/Ultra presets (budgets in `plan.md`). Gate every new expensive feature on a preset field; phones must stay viable.
- **`src/main.ts`** wires everything. Each fixed 60 Hz tick (`src/core/loop.ts`): input → `basalt.fixedUpdate` → `physics.step`. Each render frame: interpolate Basalt → follow camera → rain/splashes/cones → shadow focus → render → stats. `window.mb` exposes `config`, `ctx`, `physics`, `basalt`, `town`, `rain`, `splashes`, `cones` for debugging.
- **Rendering** (`src/render/`): `renderer.ts` picks WebGPU and falls back to WebGL 2 (including a reload onto WebGL 2 if the WebGPU device is lost); `post.ts` is the RenderPipeline (MRT, bloom, GTAO, SSR, SMAA/FXAA, grade). Ultra uses SMAA, not TRAA, because rain writes no velocity. `effects/weather-common.ts` holds the lamp registry (`setWeatherLamps`) shared by rain, splashes and light cones; `effects/rain-ripples.ts` provides the TSL puddle normal used by city materials. `effects/dev-preview.ts` is a dev harness, not imported by the game.
- **City** (`src/city/`): `town-layout.ts` turns layout data into visuals and colliders. `buildTown` returns `specs`, `buildingRanges` (triangle ranges per building) and `mergedParts`, so one building's merged visuals can be hidden and swapped for a fracturable version (the Phase 2 hook). `materials.ts` is a TSL material library driven by live wetness/rain uniforms. `dressing.ts` places lamps with real `PointLight`s, capped by `quality.maxDynamicLights`.
- **Basalt** (`src/monster/`): `basalt.ts` is the kinematic character controller (don't change movement behaviour); model, geometry, rock/lava material and procedural animation (walk/run/idle with foot planting) are split across `basalt-model.ts`, `basalt-geom.ts`, `rock-material.ts`, `basalt-anim.ts`. Footstep events come from `onFootstep` / `drainFootsteps()`.
- `src/destruction/` and `src/audio/` are planned (Phases 2 and 5) and currently empty.

## Conventions

- Units are real-world: 1 unit = 1 m, kg, 9.81 m/s². Basalt is 30 m tall. Angle 0 faces −Z; positive is counter-clockwise from above.
- Every push to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`), live at https://gelbridor.github.io/MonsterGame/. The owner merges PRs on GitHub, so fetch before working on `main`.
- One commit per passed gate on `main`. No model names in code, docs or commits.
- Fix mistakes with follow-up commits, not force-pushes or amends.
- Agent worktrees live under `.claude/worktrees/` (git-ignored). Never `git add -A` from the repo root while they exist.
- The owner's visual bar is strict: view every screenshot before merging visual work, then do a whole-scene check across quality tiers (and `--phone`), since cross-module problems (bloom on lava, double-counted reflections, rain under TRAA) only show up there.
