# Monster Brawl: handoff

State of the work as of 3 Nov 2026 (evening), written so another agent can pick it up cold.

This file holds the **current state** only. For commands, architecture and conventions see [`CLAUDE.md`](CLAUDE.md); for the design and phase gates see [`plan.md`](plan.md).

## Where things are

**`main` is live** at https://gelbridor.github.io/MonsterGame/. It holds:

- Phase 1 Foundations and the graphics pass, plus both polish rounds (Basalt lava contrast, visible head, planted feet; city wet ground without frost, smooth kerb/dip puddles, footprint-filtered setts, GTAO normals from depth, SSR soft knee that removed the pale "ice" puddles).
- **Phase 2 destruction, work in progress** (see below): structural stress solver, debug punch, piece renderer, stats rows and panel sliders.
- **GPU-aware auto quality**: tier and backend picked from the GPU, dynamic render resolution, automatic one-tier step-down.

Every branch listed by `git branch` is merged into `main`, including `p2-vis-perf` (renderer `prepareBuilding` is now cheap and time-sliced at 3 ms per frame from wake; renderer share of a destruction call is a few ms).

Leftover worktrees under `.claude/worktrees/` on the owner's machine (p2-sim, p2-vis, p2-wire, perf-q, city-r2, two old `agent-*`) are all merged and can be removed with `git worktree remove`.

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
1. **First-punch hitch, sim side**: the renderer part is fixed, but in the browser at Low a punch still costs about 75–105 ms in the call (the sim's own wake: `generateBuilding` + `designBonds` cold solve + colliders), and `destruction.fixedUpdate` still spikes 40–250 ms in the first seconds with the renderer share under 0.1 ms (the stress solver or the lazy neighbour wakes). Fix: generate and design every building's graph ahead of time (at load, in idle-time slices, nearest first), so a wake only creates bodies; and check the solver's time budget on the first steps (its speed estimate starts at 3e-4 ms per work unit).
2. **Slow collapses**: when a tower is punched around its base, or loses one side, it sags over 10+ s instead of falling (resting loose bodies' solves converge slowly within the budget). The `all` case collapses properly.
3. **Real-hardware cost unmeasured**: harness timings were mostly taken with several headless browsers loading the CPU. Re-run `node scripts/run-harness.cjs t4` (and t5, t8) on an idle machine; check the owner's laptop numbers.
4. **Low tier still heavy on the UHD 620**: the city's procedural materials run full detail per pixel on Low. Give Low cheaper material variants (`src/city/materials.ts`, gate on `quality.materialDetail`).
5. **City look**: the plaza's left carriageway puddle is still a pale bluish sheet on high/ultra; on Low the plaza puddles are large dark blobs.
6. **Harness blind spot**: the harness's null renderer uses its own box fracture, so it missed a fracture bug that made 400 shards per long wall. Make `debug-render.ts` use the real `fractureBox` from `fracture.ts`.
7. Small: the overlay's "active bodies" counts disabled pooled bodies; broken pieces are flat colour (no town mottling); no punch animation or effects yet (Phase 4/5).

## Next steps, in order

1. Remove the sim-side punch spikes (fault 1): no single destruction call over about 4 ms at Low in headless Chromium.
2. Fix the slow collapses (item 2 above), then run the Phase 2 gate checks: harness tests 1–4 per tier on an idle machine, and a full tower collapse in the browser.
3. Cheaper Low-tier materials for integrated GPUs; ask the owner for fps on the T480 afterwards.
4. Ask the owner to sign off Phase 1 and Phase 2 gates, and to confirm the reconstructed Phase 2–5 roadmap in `plan.md`.

## Reference

Commands, the destruction harness tests, screenshot checks, architecture and the working method are in [`CLAUDE.md`](CLAUDE.md).
