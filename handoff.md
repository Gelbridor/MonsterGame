# Monster Brawl: handoff

State of the work as of 4 Nov 2026, written so another agent can pick it up cold.

This file holds the **current state** only. For commands, architecture and conventions see [`CLAUDE.md`](CLAUDE.md); for the design and phase gates see [`plan.md`](plan.md).

## Where things are

**`main` is live** at https://gelbridor.github.io/MonsterGame/. It holds:

- Phase 1 Foundations and the graphics pass, plus both polish rounds (Basalt lava contrast, visible head, planted feet; city wet ground without frost, smooth kerb/dip puddles, footprint-filtered setts, GTAO normals from depth, SSR soft knee that removed the pale "ice" puddles).
- **Phase 2 destruction, work in progress** (see below): structural stress solver, debug punch, piece renderer, stats rows and panel sliders.
- **GPU-aware auto quality**: tier and backend picked from the GPU, dynamic render resolution, automatic one-tier step-down.

Every branch listed by `git branch` is merged into `main`, including `p2-vis-perf` (renderer `prepareBuilding` is now cheap and time-sliced at 3 ms per frame from wake; renderer share of a destruction call is a few ms).

Leftover worktrees under `.claude/worktrees/` on the owner's machine (p2-sim, p2-vis, p2-wire, perf-q, city-r2, two old `agent-*`) are all merged and can be removed with `git worktree remove`.

**Gate status:** the Phase 1 gate has not been formally signed off by the owner, although the owner now plays the live build on a ThinkPad T480. The Phase 2 gate passes in the harness and in headless Chromium (see "Phase 2 status") and **waits for the owner's phone test**; the work is on branch `phase2-gate`, not yet on `main`.

## Owner's test machine (important for performance work)

ThinkPad T480: Intel UHD 620 integrated GPU, 4 cores / 8 threads. Measured by the owner on the live build:
- Medium on WebGPU about 7 fps; Low on WebGPU about 24 fps (1 % low 12, frame about 50 ms); Low on WebGL 30–40 fps. Physics was under 1 ms per step, so the game is **GPU (fragment) bound** on this machine.
- After the fixes in this session the owner reports punching is "better". Auto quality should now pick WebGL, Low, render scale 0.75 on this GPU.

## Phase 2 status

**Gate** (plan.md):
- A punch takes out the piece it hits ✅ (harness t1: 10 pieces of the terrace's front wall, 2 more fall after it; nothing else).
- Removing supports makes the floors above fall under gravity alone ✅. Harness t2 (High, 14 s): `all` (every ground support removed) brings the tower's mass centre from 22 m to 5.5 m in about 8 s; `punch` (the ground floor punched out all round, as a player would) 22 m to 6 m; `side` (one half of the ground supports) 23 m to 13 m and still going.
- A full collapse of one tower block holds the tier frame rate on a phone: **CPU side ✅, GPU side for the owner to confirm.** In headless Chromium, Low tier, punching the tower's ground floor all round brings it fully down (37/37 pieces, 0 bonds) within about 5 s and every piece is rubble by 13 s. Per 60 Hz step: physics 0.8–1.4 ms average (p99 5–7 ms), destruction 0.14–0.38 ms average (p99 2–6 ms, 3–8 of 840 steps over 4 ms, worst 6–15 ms); chunks peak 126–148 of the 150 cap; draw calls 27. Medium: same collapse, physics 1.3 ms + destruction 0.24 ms average, chunks peak 183/300. iPhone 13 emulation picks Low at 0.8× render scale. Headless Chromium has no GPU, so frame rate must be read on the owner's phone (the overlay now shows `Destr` ms, average and per-frame peak, next to physics).

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
- **Held loads** (added 4 Nov): a loose body's solve holds its load (apparent gravity, contact loads and contact pins) and is resumed on the next steps until it converges; a harder landing replaces the held load. Fixed groups hold the peak contact load on each piece the same way (`Building.extHold`). Before this, a landing's 45 g solve got about 10 iterations, did not converge and was thrown away, so a dropped tower landed intact. The solver keeps its factored preconditioner while the same group's topology is unchanged (`StressSolver.setKey`).
- Contact direction: whether a contact supports or loads a piece comes from the contact force's direction (the centres only pick its sign); centre-to-centre directions were horizontal for a column standing on a wide slab.
- Loose shards crush: a building piece pressing on a shard with more than 0.25 × strength × volume^(2/3) pulverises it (`SHARD_CRUSH_STRENGTH`, collision group `CG_CRUSHED`). Before this, a punched tower stood on the pile of its own ground-floor shards.
- A crushed body keeps its momentum only while none of its pieces is within 0.15 m of the ground.
- Load time (added 4 Nov): `destruction.prepare()` generates every building's graph and designs its bonds at load (nearest to the spawn first, loading text shows progress), and `warmUpDestruction()` (`src/destruction/warmup.ts`) runs the whole destruction path once in a throwaway Rapier world (about 300 ms in Chromium). Rapier's wasm compiles lazily, function by function: the first punch used to pay 70–90 ms inside `physics.step()` for that alone, plus about 20 ms of graph generation. Now a punch call costs about 1 ms.
- Budgets: the solver has a **time** budget per step (`config.destruction.solverMsPerStep` 1.5 × `quality.solverWorkScale`; it measures its own speed on every step that solves, and its work units now include the coarse level's factor and solves). The coarse level has at least 6 pieces per aggregate (a Low-tier terrace went from 14 aggregates to 5, solve 0.64 ms to 0.24 ms). Landing bodies get an extra allowance. Shards spawn at most 24 per step; shard colliders are 90 % size so they start apart; neighbours within the wake radius that the hit did not touch wake one per step.
- Punch: J / gamepad X / touch Punch, 200 damage (concrete 140 and stone 150 now break in one hit; steel 400 does not), centre `punchReach` 12 m ahead at `punchHeight` 8 m. `mb.punchAt(x, y, z)` in the console.
- Visuals (`piece-render.ts`): a woken building keeps its detailed town triangles. On first hand-over its triangles are clipped against the piece-box planes into a private copy, and only a piece's own triangles are hidden when it moves, breaks or is baked. Damage alone does not hand over. Back faces render as a dim interior; interior slabs/columns appear once a building has a hole. Pieces and shards take their building's town variant and tint.

**Known faults and open work, in priority order:**
1. **Owner's phone test of the Phase 2 gate** (frame rate during a full tower collapse on real hardware). Then the Phase 1 and Phase 2 sign-off, and confirmation of the reconstructed roadmap in `plan.md`.
2. **Occasional destruction spikes of 5–15 ms** at Low in headless Chromium (a few steps per collapse, mostly in the stress solve). They vary run to run with the same work, so part is GC/JIT noise; a firmer fix is a hard cap on solve time inside PCG (check the clock every few iterations) instead of a work estimate.
3. **Renderer hitch on a building's first preparation:** one `prepareGen` slice took 13–22 ms in Chromium (it should stop at 3 ms; deadline checks are 64 triangles apart, and the slow slice moved between runs, so GC or JIT is likely). The warm-up uses the null renderer, so `piece-render.ts` is still cold on the first wake.
4. **Collapses are slower than real life:** at High the punched tower takes about 10 s to come fully down, the `side` case more than 14 s; at Low, `punch` takes about 6 s but `all` stalls at mid-height for about 6 s before it finishes at about 12 s. Loose bodies are solved every 4th step unless loaded, and each landing's crush keeps only part of the momentum.
5. **Low tier still heavy on the UHD 620**: the city's procedural materials run full detail per pixel on Low. Give Low cheaper material variants (`src/city/materials.ts`, gate on `quality.materialDetail`).
6. **City look**: the plaza's left carriageway puddle is still a pale bluish sheet on high/ultra; on Low the plaza puddles are large dark blobs. Woken tower pieces render very dark on Low (no lit windows), see `docs/screenshots/p2-gate-tower-collapse-low.jpg`.
7. Small: broken pieces are flat colour (no town mottling); no punch animation or effects yet (Phase 4/5). Ultra had one 25 ms destruction step in harness t4.

Fixed on 4 Nov: first-punch hitch (wasm warm-up, graphs at load), slow and stalled collapses (held loads, contact direction, crushable shards), harness blind spot (the null renderer now uses the real Voronoi `fractureBox` with the game's per-tier shard limits), the overlay's active-body count (disabled pooled bodies no longer count).

## Next steps, in order

1. Owner tests the Phase 2 gate on a phone (see the session's test instructions: GitHub Pages after merging `phase2-gate`, or `npm run dev -- --host` on home Wi-Fi). If it passes, merge to `main` as the Phase 2 gate commit and start Phase 3.
2. Hard time cap inside PCG (fault 2); warm up `piece-render.ts` too (fault 3).
3. Cheaper Low-tier materials for integrated GPUs; ask the owner for fps on the T480 afterwards.

## Reference

Commands, the destruction harness tests, screenshot checks, architecture and the working method are in [`CLAUDE.md`](CLAUDE.md).
