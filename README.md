# Monster Brawl

A browser giant-monster destruction tech demo. Play it at https://gelbridor.github.io/MonsterGame/.

**Status:** Phase 1 (Foundations) and a graphics pass are done; Phase 2 (destruction core) is in progress and live as a test build.

- Design and phase gates: [`plan.md`](plan.md)
- Current state, known faults and next steps: [`handoff.md`](handoff.md)
- Commands, architecture and conventions for development: [`CLAUDE.md`](CLAUDE.md)

## Run it

```bash
npm install
npm run dev            # http://localhost:5173
npm run dev -- --host  # also serves on your LAN, for phones on the same Wi-Fi
npm run build          # type-check + production build into dist/
```

Every push to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`).

## Controls

| Action | Keyboard / mouse | Gamepad | Touch |
| --- | --- | --- | --- |
| Move | WASD | Left stick / D-pad | Left-side floating stick |
| Run | Shift | RT, RB or L3 | Push the stick to its edge |
| Look | Arrow keys, or drag with mouse | Right stick | Drag on the right side |
| Punch (debug) | J | X | Punch button |
| Debug panel | ` (backtick) | Back / Select | Three-finger tap |

Stomp, Grab and Special are placeholders until Phase 4.

## URL options

- `?webgl` / `?webgpu` force the rendering backend. By default it is picked from the GPU: integrated GPUs get WebGL 2.
- `?quality=low|medium|high|ultra` forces a quality tier; `?quality=auto` clears a stored automatic step-down.

Every tunable value lives in `src/config.ts`. The debug panel edits it live, and "Copy config JSON" exports tuned values.
