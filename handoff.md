# Monster Brawl: handoff

State of the work as of 3 Nov 2026 (evening), written so another agent can pick it up cold.

- **Design:** read [`plan.md`](plan.md) first. Its **Milestones** table defines each phase and its gate.
- **Look:** see the reference screenshots in [`docs/screenshots/`](docs/screenshots/).

## Where things are

**`main` (`e15e5b4`) is live** at https://gelbridor.github.io/MonsterGame/. It holds:

- Phase 1 Foundations and the graphics pass, plus both polish rounds (Basalt lava contrast, visible head, planted feet; city wet ground without frost, smooth kerb/dip puddles, footprint-filtered setts, GTAO normals from depth, SSR soft knee that removed the pale "ice" puddles).
- **Phase 2 destruction, work in progress** (see below): structural stress solver, debug punch, piece renderer, stats rows and panel sliders.
- **GPU-aware auto quality**: tier and backend picked from the GPU, dynamic render resolution, automatic one-tier step-down.

Every other branch listed by `git branch` is merged into `main` **except `p2-vis-perf`** (worktree `.claude/worktrees/p2-perf`). A Sonnet agent was working on it when the session ended: it moves the renderer's one-off `prepareBuilding` triangle clipping (the first-punch hitch) ahead of time or spreads it over frames. **Review its result before merging**: its last known commit was `8281d05` ("Merge main"). If it is unfinished, finish the task described under "Next steps" yourself.

Leftover worktrees under `.claude/worktrees/` (p2-sim, p2-vis, p2-wire, perf-q, city-r2, two old `agent-*`) are all merged and can be removed with `git worktree remove`.

**Gate status:** the Phase 1 gate has not been formally signed off by the owner, although the owner now plays the live build on a ThinkPad T480. The Phase 2 gate is not yet passed (see "Phase 2 status").

## Owner's test machine (important for performance work)

ThinkPad T480: Intel UHD 620 integrated GPU, 4 cores / 8 threads. Measured by the owner on the live build:
- Medium on WebGPU about 7 fps; Low on WebGPU about 24 fps (1 % low 12, frame about 50 ms); Low on WebGL 30–40 fps. Physics was under 1 ms per step, so the game is **GPU (fragment) bound** on this machine.
- After the fixes in this session the owner reports punching is "better". Auto quality should now pick WebGL, Low, render scale 0.75 on this GPU.

## Phase 2 status

**Gate** (plan.md): a punch takes out the piece it hits ✅; removing supports makes the floors above fall under gravity alone ✅ (harness test 2, `all` mode: the tower's mass centre falls from 23 m to 7 m in about 2 s); a full tower collapse holds the tier frame rate on a phone ❌ not measured on real hardware.

**Design (owner-approved): structural stress solver alongside Rapier.**
- Rapier does all motion. Connected pieces form one compound rigid body per group: fixed while it has a ground path, dynamic once it loses it. Groups split by connected components when bonds break.
- `src/destruction/stress.ts`: each piece is a rigid 6-DOF node. Bonds are axial, shear, bending and twist springs at the contact patch (k = E·A/L etc.); bonds touching non-structural cladding are soft (×0.03). Solve K x = f (true weights, a landing body's apparent gravity g − a, measured contact forces) with PCG: 6×6 block-Jacobi plus a coarse level of rigid aggregates (storey bands × horizontal bins, ≤ 24, assembled exactly from the bonds that cross them). Warm-started and rescaled to the new load. Utilisation = compression/cap + tension/(cap·tfrac) + shear/(cap·sfrac) + moment/mcap; bonds ≥ max(1, 0.9·max) break each solve.
- `joints.ts` `designBonds`: one accurate solve of the intact building; bonds are strengthened so the intact building uses 35 % of each bond (safety factor about 2.9).
- Collapse physics added this session (all found with the harness):
  - Compressive failure (compression ≥ 50 % of the utilisation) **crushes** the lighter of the two pieces into pulverised shards that do not collide with building pieces (`CG_CRUSHED`). The falling body keeps its pre-contact momentum minus the crushing work (`config.destruction.crushWork`, 0.15 of peak).
  - Loose bodies: contacts from below are supports (pinned), contacts from above are loads.
  - Single loose pieces crush against material strength × section.
  - Debris carrying a building piece is never baked to rubble; the chunk cap never bakes moving groups; resting groups larger than 6 pieces stay live.
  - Impact damage uses specific energy of the piece itself (`IMPACT_J_PER_KG_HEALTH`).
- Budgets: the solver has a **time** budget per step (`config.destruction.solverMsPerStep` 1.5 × `quality.solverWorkScale`; it measures its own speed). Landing bodies get an extra allowance. Shards spawn at most 24 per step; shard colliders are 90 % size so they start apart; neighbours within the wake radius that the hit did not touch wake one per step.
- Punch: J / gamepad X / touch Punch, 200 damage (concrete 140 and stone 150 now break in one hit; steel 400 does not), centre `punchReach` 12 m ahead at `punchHeight` 8 m. `mb.punchAt(x, y, z)` in the console.
- Visuals (`piece-render.ts`): a woken building keeps its detailed town triangles. On first hand-over its triangles are clipped against the piece-box planes into a private copy, and only a piece's own triangles are hidden when it moves, breaks or is baked. Damage alone does not hand over. Back faces render as a dim interior; interior slabs/columns appear once a building has a hole. Pieces and shards take their building's town variant and tint.

**Known faults and open work, in priority order:**
1. **First-punch hitch**: in the browser at Low the first punch on a building costs about 200 ms in the call and 40–150 ms in a few following steps (renderer `prepareBuilding` clipping). Being fixed on `p2-vis-perf`.
2. **Slow collapses**: when a tower is punched around its base, or loses one side, it sags over 10+ s instead of falling (resting loose bodies' solves converge slowly within the budget). The `all` case collapses properly.
3. **Real-hardware cost unmeasured**: harness timings were mostly taken with several headless browsers loading the CPU. Re-run `node scripts/run-harness.cjs t4` (and t5, t8) on an idle machine; check the owner's laptop numbers.
4. **Low tier still heavy on the UHD 620**: the city's procedural materials run full detail per pixel on Low. Give Low cheaper material variants (`src/city/materials.ts`, gate on `quality.materialDetail`).
5. **City look**: the plaza's left carriageway puddle is still a pale bluish sheet on high/ultra; on Low the plaza puddles are large dark blobs.
6. **Harness blind spot**: the harness's null renderer uses its own box fracture, so it missed a fracture bug that made 400 shards per long wall. Make `debug-render.ts` use the real `fractureBox` from `fracture.ts`.
7. Small: the overlay's "active bodies" counts disabled pooled bodies; broken pieces are flat colour (no town mottling); no punch animation or effects yet (Phase 4/5).

## Next steps, in order

1. Review and merge `p2-vis-perf` (or finish it): no single destruction call over about 4 ms at Low in headless Chromium.
2. Fix the slow collapses (item 2 above), then run the Phase 2 gate checks: harness tests 1–4 per tier on an idle machine, and a full tower collapse in the browser.
3. Cheaper Low-tier materials for integrated GPUs; ask the owner for fps on the T480 afterwards.
4. Ask the owner to sign off Phase 1 and Phase 2 gates, and to confirm the reconstructed Phase 2–5 roadmap in `plan.md`.

## How it's built

Vite + TypeScript, Three.js r187 `WebGPURenderer` with TSL node materials (automatic WebGL 2 fallback, including a reload onto WebGL 2 if the WebGPU device is lost), and Rapier 0.21 physics with a fixed 60 Hz step.

- **`src/core/types.ts`** holds the contracts between modules (`QualityPreset`, `RenderContext`, `Physics`, `Input`, `Town`, `Monster`, `FollowCamera`, `DebugUI`, `FrameStats`). **`src/destruction/types.ts`** holds the destruction contracts (`BuildingGraph`, `DestructionRenderer`, `DamageEvent`, `Destruction`).
- **`src/config.ts`** holds every tunable number. The debug panel (`src/debug/panel.ts`, backtick key) auto-builds from it; add slider ranges in its `META` table.
- **`src/core/quality.ts`**: Low / Medium / High / Ultra tiers. `probeGpu()` + `classifyGpu()` pick tier and backend from the GPU (integrated/software → WebGL 2). Priority: `?quality=` URL, then the stored auto step-down (`localStorage` `mb.qualityAuto`), then the GPU heuristic. `?quality=auto` or the panel's "Reset auto quality" clears it. A URL-forced tier disables dynamic resolution and step-down. `?webgl` / `?webgpu` force the backend.
- **`src/main.ts`** wires everything. Each fixed tick: input → `basalt.fixedUpdate` → punch → `physics.step` → `destruction.fixedUpdate`. Each frame: interpolate Basalt → camera → weather → `destruction.syncVisual` → render → stats. `window.mb` exposes `config`, `ctx`, `physics`, `basalt`, `town`, `destruction`, `punchAt`, `rain`, `splashes`, `cones`.
- **Units:** 1 unit = 1 m, kg, 9.81 m/s². Basalt is 30 m tall. **Angles:** 0 = facing −Z, positive = counter-clockwise from above.

| Area | Files |
| --- | --- |
| Renderer, sky, env, post | `src/render/renderer.ts`, `sky.ts`, `environment.ts`, `post.ts` (MRT, bloom, GTAO, SSR with soft knee, SMAA/FXAA, filmic grade) |
| Weather | `src/render/effects/rain.ts`, `splashes.ts`, `light-cones.ts`, `rain-ripples.ts`, `weather-common.ts` |
| City | `src/city/town-layout.ts`, `buildings.ts`, `landmarks.ts`, `materials.ts`, `dressing.ts`, `mesh-builder.ts`, `signage.ts` |
| Basalt | `src/monster/basalt.ts` (**don't change movement behaviour**), `basalt-model.ts`, `basalt-geom.ts`, `basalt-anim.ts`, `rock-material.ts` |
| Destruction sim | `src/destruction/index.ts` (step, contact events, damage), `stress.ts` (solver), `joints.ts` (groups, bonds, crushing, design), `building-gen.ts` (floors × bays graph per tier), `materials.ts`, `sleep.ts` (wake, body pool, shards, rubble, cap) |
| Destruction visuals | `src/destruction/piece-render.ts`, `fracture.ts` (Voronoi cells), `piece-materials.ts`, `debug-render.ts` (null renderer for the harness), viewer `src/destruction/viewer.html` |
| Camera, input, debug, physics | `src/camera/follow-camera.ts`, `src/core/input.ts` (keys must be listed in `GAME_KEYS`), `src/debug/panel.ts`, `src/physics/world.ts` |

## Testing

- **Run it:** `npm install`, then `npm run dev` (`-- --host` for phones on the same Wi-Fi; those get WebGL 2). `npm run build` type-checks and builds.
- **Destruction harness (headless, real Rapier, null renderer):** `node scripts/run-harness.cjs <test>`; `LEVEL=low|medium|high|ultra` picks the tier.
  - `t1` terrace punch; `t2` tower collapse (`MODES=cols,side,all,punch`, `EVERY=0.5`, `TRACE=1`); `t3` all buildings woken for 60 s (stability); `t4` cost per tier during a collapse; `t5` solve cost; `t6` replay a punch (`PUNCH=x,y,z`, `LONG=1`, `PROF=1` for Rapier timers); `t7` wake/break step costs; `t8` three punches (warm-up vs steady state); `t9` fracture shard counts.
- **Visual checks:** `node scripts/shot.cjs "http://localhost:<port>/?webgl&quality=low" out.png --size 800x450 --wait 20000 --eval "..."`. Only console warnings/errors are forwarded, so log with `console.warn`. To time destruction in the browser, wrap `mb.destruction.fixedUpdate` / `syncVisual` with `performance.now()` in `--eval`.
  - This headless Chromium has **no GPU** (SwiftShader). Always use WebGL; it runs at 1–5 fps, so trust CPU timings and draw-call counts, not fps. Medium at 960×540 sometimes crashes the page; use 800×450.
  - Judge the **default gameplay camera** first. The scratchpad does not survive sessions; keep reference shots in `docs/screenshots/`.
- **Deploying:** every push to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`); `gh run watch` follows it.

## Working method

The owner asked for small tasks to go to Sonnet sub-agents, each reviewed before merging. That worked:
- Give each agent its own worktree (create by hand under `.claude/worktrees/`, junction `node_modules` with `mklink /J`; agent worktree isolation is refused on this machine), its own files and dev-server port, and require screenshots in the scratchpad.
- View **every** screenshot before merging and send back concrete, prioritised fixes. This session's in-game checks caught faults the agents' own viewer shots missed (diagonal holes, see-through buildings, pale damaged pieces, the J key not registered, the 400-shard walls).
- Background agents sometimes re-send their final report repeatedly; stop them with `TaskStop` once handled.

**Gotchas:**
- Git has no identity configured: commit with `git -c user.name=Claude -c user.email=noreply@anthropic.com`. Commit messages end with a `Co-Authored-By:` line.
- Playwright: `npm install --no-save playwright` and `npx playwright install chromium` after a fresh `npm install`.
- Never `git add -A` from the repo root while worktrees exist under `.claude/`. No history rewrites (force-push and amend are blocked); fix with follow-up commits. The owner may merge PRs on GitHub, so fetch before working on `main`.
- No model names in code or docs.
