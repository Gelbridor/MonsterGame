# Monster Brawl

A browser giant-monster destruction tech demo. Design: [`plan.md`](plan.md).

**Status:** Phase 1 (Foundations) plus a graphics pass. No destruction yet. Current state and next steps: [`handoff.md`](handoff.md).

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
| Debug panel | ` (backtick) | Back / Select | Three-finger tap |

The four touch buttons (Punch, Stomp, Grab, Special) are placeholders until Phase 4.

## URL options

- `?webgl` forces the WebGL 2 backend (WebGPU is the default where available).
- `?quality=low|medium|high|ultra` overrides the auto-detected quality preset.

## Layout

See the Handoff section of `plan.md`. Every tunable value lives in `src/config.ts`;
the debug panel edits it live, and "Copy config JSON" exports tuned values.
