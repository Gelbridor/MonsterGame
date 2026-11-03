# Reference screenshots

All of these were captured with `scripts/shot.cjs` in headless Chromium using **software WebGL 2** (no GPU), so expect softer edges and lower frame rates than on a real device. The stats overlay's fps is meaningless here.

| File | What it shows |
| --- | --- |
| `phase1-blockout.jpg` | The Phase 1 blockout (box town, capsule Basalt), for before/after comparison. |
| `graphics-ultra-dry.jpg` | The current graphics pass on Ultra with rain off (`mb.config.weather.rain = 0`). It shows the known faults: white "snow" patches on the roads (left) and camouflage-blob puddles on the square, with Basalt's lava too hot under bloom. |
| `graphics-medium-rain.jpg` | Medium tier with rain after the rain polish: rain is subtle and mostly visible where lamps light it. The wet-ground faults are also visible here. |
| `lighting-street-reference.jpg` | A street-level view from the lighting work. Its sky, fog layering and window bloom are the target mood. Its lamps are temporary test lights and its roads were forced smooth, so judge the atmosphere, not the ground. |
