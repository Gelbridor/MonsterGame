# Reference screenshots

All of these were captured with `scripts/shot.cjs` in headless Chromium using **software WebGL 2** (no GPU), so expect softer edges and lower frame rates than on a real device. The stats overlay's fps is meaningless here.

**These predate the two graphics polish rounds and Phase 2.** The wet-ground and lava faults they show have since been fixed; use them for mood and before/after comparison, and replace them when new reference shots are taken.

| File | What it shows |
| --- | --- |
| `phase1-blockout.jpg` | The Phase 1 blockout (box town, capsule Basalt), for before/after comparison. |
| `graphics-ultra-dry.jpg` | The first graphics pass on Ultra with rain off (`mb.config.weather.rain = 0`). It shows the faults the polish rounds fixed: white "snow" patches on the roads (left) and camouflage-blob puddles on the square, with Basalt's lava too hot under bloom. |
| `graphics-medium-rain.jpg` | Medium tier with rain after the rain polish: rain is subtle and mostly visible where lamps light it. The since-fixed wet-ground faults are also visible here. |
| `lighting-street-reference.jpg` | A street-level view from the lighting work. Its sky, fog layering and window bloom are the target mood. Its lamps are temporary test lights and its roads were forced smooth, so judge the atmosphere, not the ground. |
| `p2-gate-tower-collapse-low.jpg` | Phase 2 gate check, Low tier: the tower block 2 s after its ground floor was punched out all round, falling and breaking up. The overlay shows the destruction cost (`Destr`) next to physics. |
| `p2-gate-tower-rubble-low.jpg` | The same tower about 14 s later: fully down, every piece baked into a static rubble heap (153 rubble colliders, no live bodies). |
| `p2-gate-tower-collapse-phone.jpg` | The same collapse with iPhone 13 emulation and auto quality (Low at 0.8× render scale, touch controls). |
