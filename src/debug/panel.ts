// Debug UI: a lil-gui tuning panel auto-built from the config object, plus a
// small always-on stats overlay.
//
// The panel walks `cfg` generically: every top-level group becomes a folder
// and every numeric / boolean leaf becomes a controller that edits `cfg` in
// place. The Phase 2+ tunables from the plan (building health, column load
// limit, debris lifetime, chunk count, joint strength per material, effect
// density) do not exist yet; as soon as they are added to config.ts they will
// show up here automatically (add an entry to META below for a nice range,
// otherwise they get a plain number box).
//
// FPS smoothing is done here: main.ts passes instantaneous 1/frameDt as
// `fps` and `frameMs`; we ignore `fps` and average `frameMs` over the last
// ~1 s (and report the worst frame in that window as the "low").

import GUI from 'lil-gui';
import type { Controller } from 'lil-gui';
import type { Config } from '../config';
import type { DebugUI, FrameStats } from '../core/types';
import { resetAutoQuality } from '../core/quality';

// ------------------------------------------------------------------ metadata

interface Meta {
  min?: number;
  max?: number;
  step?: number;
}

/** Slider ranges per config path. Keys without min/max (or without an entry) get a plain number box. */
const META: Record<string, Meta> = {
  'physics.timestep': { step: 0.0001 }, // box: restart required
  'physics.maxStepsPerFrame': { min: 1, max: 20, step: 1 },
  'physics.gravity': { min: 0, max: 30, step: 0.01 },
  'physics.gravityScale': { min: 0, max: 3, step: 0.01 },

  'world.groundSize': { step: 10 }, // box
  'world.seed': { step: 1 }, // box

  'monster.height': { step: 0.5 }, // box
  'monster.radius': { step: 0.1 }, // box
  'monster.mass': { min: 0, step: 1e5 }, // plain number box
  'monster.walkSpeed': { min: 0, max: 40, step: 0.1 },
  'monster.runSpeed': { min: 0, max: 60, step: 0.1 },
  'monster.acceleration': { min: 0, max: 100, step: 0.1 },
  'monster.deceleration': { min: 0, max: 100, step: 0.1 },
  'monster.turnSpeed': { min: 0, max: 10, step: 0.05 },
  'monster.stepHeight': { min: 0, max: 10, step: 0.1 },

  'destruction.healthScale': { min: 0.1, max: 10, step: 0.05 },
  'destruction.bondStrengthScale': { min: 0.05, max: 10, step: 0.05 },
  'destruction.wakeRadius': { min: 0, max: 60, step: 0.5 },
  'destruction.debrisLifetime': { min: 0.5, max: 30, step: 0.5 },
  'destruction.shardsMin': { min: 1, max: 20, step: 1 },
  'destruction.shardsMax': { min: 1, max: 40, step: 1 },
  'destruction.punchDamage': { min: 1, max: 2000, step: 1 },
  'destruction.punchRadius': { min: 0.5, max: 20, step: 0.1 },
  'destruction.punchImpulse': { min: 0, max: 2e7, step: 1e4 },
  'destruction.punchReach': { min: 0, max: 40, step: 0.5 },
  'destruction.punchHeight': { min: 0, max: 30, step: 0.5 },
  'destruction.solverMsPerStep': { min: 0, max: 8, step: 0.1 },
  'destruction.crushWork': { min: 0, max: 1, step: 0.01 },

  'camera.fov': { min: 20, max: 110, step: 1 },
  'camera.distance': { min: 10, max: 200, step: 1 },
  'camera.pitch': { min: -0.5, max: 1.5, step: 0.01 },
  'camera.minPitch': { min: -1.2, max: 1.2, step: 0.01 },
  'camera.maxPitch': { min: -1.2, max: 1.5, step: 0.01 },
  'camera.lookAtHeight': { min: 0, max: 60, step: 0.5 },
  'camera.followSharpness': { min: 0.5, max: 30, step: 0.1 },
  'camera.lookSensitivity': { min: 0.0005, max: 0.02, step: 0.0001 },
  'camera.stickLookSpeed': { min: 0.5, max: 8, step: 0.05 },
  'camera.autoFollowStrength': { min: 0, max: 5, step: 0.05 },
  'camera.near': { min: 0.05, max: 10, step: 0.05 },
  'camera.far': { min: 200, max: 10000, step: 50 },

  'render.maxPixelRatio': { min: 0.5, max: 3, step: 0.05 },
  'render.fogDensity': { min: 0, max: 0.02, step: 0.0001 },
  'render.exposure': { min: 0.1, max: 4, step: 0.01 },
  'render.moonIntensity': { min: 0, max: 10, step: 0.05 },
  'render.ambientIntensity': { min: 0, max: 4, step: 0.01 },
  'render.envIntensity': { min: 0, max: 4, step: 0.01 },
  'render.bloomStrength': { min: 0, max: 3, step: 0.01 },
  'render.bloomRadius': { min: 0, max: 1, step: 0.01 },
  'render.bloomThreshold': { min: 0, max: 4, step: 0.01 },
  'render.aoIntensity': { min: 0, max: 3, step: 0.01 },
  'render.aoRadius': { min: 0.25, max: 16, step: 0.05 },
  'render.ssrStrength': { min: 0, max: 1, step: 0.01 },
  'render.ssrKneeLow': { min: 0, max: 1, step: 0.01 },
  'render.ssrKneeHigh': { min: 0, max: 2, step: 0.01 },
  'render.filmGrain': { min: 0, max: 0.3, step: 0.005 },
  'render.vignette': { min: 0, max: 1, step: 0.01 },
  'render.chromaticAberration': { min: 0, max: 0.01, step: 0.0001 },
  'render.saturation': { min: 0, max: 2, step: 0.01 },
  'render.contrast': { min: 0.5, max: 1.5, step: 0.01 },

  'weather.rain': { min: 0, max: 1, step: 0.01 },
  'weather.windX': { min: -15, max: 15, step: 0.1 },
  'weather.windZ': { min: -15, max: 15, step: 0.1 },
  'weather.wetness': { min: 0, max: 1, step: 0.01 },

  'quality.startupIgnoreS': { min: 0, max: 20, step: 0.5 },
  'quality.windowS': { min: 1, max: 15, step: 0.5 },
  'quality.percentile': { min: 0.5, max: 0.99, step: 0.01 },
  'render.renderScale': { min: 0.5, max: 1, step: 0.05 },
  'quality.scaleIntervalS': { min: 0.5, max: 10, step: 0.5 },
  'quality.scaleDown': { min: 0.02, max: 0.3, step: 0.01 },
  'quality.scaleUp': { min: 0.02, max: 0.3, step: 0.01 },
  'quality.scaleMin': { min: 0.3, max: 1, step: 0.05 },
  'quality.raiseFactor': { min: 1.02, max: 1.6, step: 0.01 },
  'quality.startScaleWeak': { min: 0.5, max: 1, step: 0.05 },
  'quality.minFpsLow': { min: 10, max: 60, step: 1 },
  'quality.cooldownS': { min: 5, max: 120, step: 1 },
  'quality.minFpsHigh': { min: 10, max: 120, step: 1 },
  'quality.minFpsMedium': { min: 10, max: 120, step: 1 },
  'quality.toastS': { min: 1, max: 10, step: 0.5 },

  'input.deadZone': { min: 0, max: 0.6, step: 0.01 },
  'input.touchStickRadius': { min: 30, max: 140, step: 1 },
};

/** Config paths whose JSDoc says "Restart required". */
const RESTART_REQUIRED = new Set<string>([
  'physics.timestep',
  'world.groundSize',
  'world.seed',
  'monster.height',
  'monster.radius',
]);

/** Folders left open on first show. */
const OPEN_FOLDERS = new Set<string>(['render', 'weather', 'debug']);

const RESTART_MARK = ' ⟳';

function prettify(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ------------------------------------------------------------------ styles

const STYLE_ID = 'mb-debug-style';

const CSS = `
.lil-gui.lil-root.mb-gui {
  --width: min(320px, 90vw);
  --font-size: 12px;
  --widget-height: 22px;
  --name-width: 48%;
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 6px);
  right: calc(env(safe-area-inset-right, 0px) + 6px);
  width: min(320px, 90vw);
  max-width: 90vw;
  max-height: 70vh;
  max-height: 70dvh;
  z-index: 10000;
  touch-action: pan-y;
}
.lil-gui.lil-root.mb-gui > .lil-children { overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
@media (max-width: 560px) {
  /* Narrow screens: the panel is nearly full width, so sit below the stats overlay instead of covering it. */
  .lil-gui.lil-root.mb-gui.mb-with-stats {
    top: calc(env(safe-area-inset-top, 0px) + 186px);
    max-height: calc(100vh - 200px);
    max-height: calc(100dvh - 200px);
  }
}
@media (pointer: coarse) {
  .lil-gui.lil-root.mb-gui { --widget-height: 30px; --font-size: 14px; --padding: 6px; --spacing: 6px; }
}
.mb-stats {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 6px);
  left: calc(env(safe-area-inset-left, 0px) + 6px);
  z-index: 9999;
  margin: 0;
  padding: 5px 8px;
  font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #dfe6ee;
  background: rgba(8, 10, 14, 0.62);
  border-radius: 4px;
  white-space: pre;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
@media (pointer: coarse) { .mb-stats { font-size: 12px; } }
.mb-stats .g { color: #6fe08a; }
.mb-stats .a { color: #ffc24a; }
.mb-stats .r { color: #ff5d5d; }
.mb-stats .d { color: #8896a6; }
`;

// ------------------------------------------------------------------ helpers

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function esc(t: string): string {
  return t.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** Trim vendor noise and ANGLE wrapping so the GPU name fits the overlay. */
function shortGpu(g: string): string {
  let name = g.split(' / ')[0];
  const angle = /^ANGLE \((.*)\)$/.exec(name);
  if (angle) {
    const fields = angle[1].split(', ');
    name = fields.length > 1 ? fields[1] : fields[0];
    const vk = /^Vulkan [\d.]+ \((.*)\)$/.exec(name);
    if (vk) name = vk[1];
  }
  name = name.replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/\((R|TM)\)/gi, '').replace(/\s+/g, ' ').trim();
  return name.length > 34 ? name.slice(0, 33) + '…' : name;
}

function showNote(text: string): void {
  console.info('[debug] ' + text);
}

function fmtCount(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) return;
  } catch {
    /* ignore */
  }
  console.log('[debug] config JSON (clipboard unavailable):\n' + text);
}

// ------------------------------------------------------------------ main

export function createDebugUI(cfg: Config, opts?: { onRestartRequired?: (key: string) => void }): DebugUI {
  const onRestart = opts?.onRestartRequired;
  const defaults = deepCopy(cfg) as unknown as Rec;

  // ---- styles
  const styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  // ---- tuning panel
  const gui = new GUI({ title: 'Tuning' });
  gui.domElement.classList.add('mb-gui');
  gui.hide();
  let visible = false;

  gui.add({ close: () => ui.toggle() }, 'close').name('Close');
  gui.add({ reset: () => resetToDefaults() }, 'reset').name('Reset to defaults');
  gui
    .add({ reset: () => { resetAutoQuality(); showNote('Auto quality cleared, reload to re-detect'); } }, 'reset')
    .name('Reset auto quality');
  gui.add({ copy: () => void copyText(JSON.stringify(cfg, null, 2)) }, 'copy').name('Copy config JSON');

  function build(parent: GUI, obj: Rec, path: string[]): void {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const full = [...path, key].join('.');
      if (isRec(val)) {
        const folder = parent.addFolder(prettify(key));
        if (!OPEN_FOLDERS.has(full)) folder.close();
        build(folder, val, [...path, key]);
        continue;
      }
      if (typeof val !== 'number' && typeof val !== 'boolean') continue;
      const c: Controller = parent.add(obj, key);
      if (typeof val === 'number') {
        const m = META[full];
        if (m?.min !== undefined) c.min(m.min);
        if (m?.max !== undefined) c.max(m.max);
        if (m?.step !== undefined) c.step(m.step);
      }
      const restart = RESTART_REQUIRED.has(full);
      c.name(prettify(key) + (restart ? RESTART_MARK : ''));
      if (restart) {
        c.domElement.title = 'Restart required: takes effect after the world is rebuilt';
        c.onChange(() => onRestart?.(full));
      }
    }
  }
  build(gui, cfg as unknown as Rec, []);

  function restore(live: Rec, snap: Rec, path: string[]): void {
    for (const key of Object.keys(snap)) {
      const s = snap[key];
      const full = [...path, key].join('.');
      if (isRec(s) && isRec(live[key])) {
        restore(live[key] as Rec, s, [...path, key]);
      } else if (live[key] !== s) {
        live[key] = s;
        if (RESTART_REQUIRED.has(full)) onRestart?.(full);
      }
    }
  }

  function resetToDefaults(): void {
    restore(cfg as unknown as Rec, defaults, []);
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  // ---- stats overlay
  const statsEl = document.createElement('pre');
  statsEl.className = 'mb-stats';
  statsEl.setAttribute('aria-hidden', 'true');
  document.body.appendChild(statsEl);
  let statsShown = true;

  function applyStatsVisibility(): void {
    const want = cfg.debug.showStats;
    if (want !== statsShown) {
      statsShown = want;
      statsEl.style.display = want ? '' : 'none';
      gui.domElement.classList.toggle('mb-with-stats', want);
    }
  }
  gui.domElement.classList.add('mb-with-stats');
  applyStatsVisibility();

  // Ring buffer of recent frame times (ms) for the ~1 s moving average / low.
  const RING = 256;
  const frameTimes = new Float32Array(RING);
  let ringHead = 0; // next write index
  let ringCount = 0;
  // Accumulators for the current refresh interval.
  let physSum = 0;
  let physN = 0;
  let lastRefresh = -Infinity;
  const REFRESH_MS = 250; // ~4 Hz DOM writes

  function fpsClass(fps: number): string {
    return fps >= 55 ? 'g' : fps >= 28 ? 'a' : 'r';
  }

  function updateStats(s: FrameStats): void {
    const ms = s.frameMs > 0 ? s.frameMs : s.fps > 0 ? 1000 / s.fps : 0;
    if (ms > 0) {
      frameTimes[ringHead] = ms;
      ringHead = (ringHead + 1) % RING;
      if (ringCount < RING) ringCount++;
    }
    physSum += s.physicsMs;
    physN++;

    const now = performance.now();
    if (now - lastRefresh < REFRESH_MS) return;
    lastRefresh = now;

    const avgPhys = physN > 0 ? physSum / physN : 0;
    physSum = 0;
    physN = 0;

    applyStatsVisibility();
    if (!statsShown) return;

    // Average and worst frame over the most recent ~1000 ms of samples.
    let sum = 0;
    let worst = 0;
    let n = 0;
    for (let i = 1; i <= ringCount && sum < 1000; i++) {
      const t = frameTimes[(ringHead - i + RING) % RING];
      sum += t;
      if (t > worst) worst = t;
      n++;
    }
    const avgMs = n > 0 ? sum / n : ms;
    const fps = avgMs > 0 ? 1000 / avgMs : 0;
    const lowFps = worst > 0 ? 1000 / worst : 0;

    statsEl.innerHTML =
      `FPS     <span class="${fpsClass(fps)}">${fps.toFixed(0)}</span>` +
      ` <span class="d">low</span> <span class="${fpsClass(lowFps)}">${lowFps.toFixed(0)}</span>\n` +
      `Frame   ${avgMs.toFixed(1)} ms\n` +
      `Physics ${avgPhys.toFixed(2)} ms x${s.physicsSteps}\n` +
      `Bodies  ${s.activeBodies}/${s.bodies}\n` +
      `Joints  ${s.joints}\n` +
      `Chunks  ${s.activeChunks} <span class="d">bonds</span> ${s.liveBonds}\n` +
      `Bldgs   ${s.awakeBuildings} awake <span class="d">rubble</span> ${s.rubbleBodies}\n` +
      `Collid  ${s.colliders}\n` +
      `Draws   ${s.drawCalls}\n` +
      `Tris    ${fmtCount(s.triangles)}\n` +
      `${s.backend.toUpperCase()} <span class="d">|</span> ${s.quality}${s.renderScale !== undefined && s.renderScale < 0.995 ? ` @${s.renderScale.toFixed(2)}x` : ''} <span class="d">|</span> ${s.inputDevice}\n` +
      (s.gpu ? `GPU     ${esc(shortGpu(s.gpu))}\n` : '') +
      (s.backendReason ? `<span class="d">api</span>     ${esc(s.backendReason)}
` : '') +
      (s.qualityReason ? `<span class="d">why</span>     ${esc(s.qualityReason)}\n` : '') +
      `Speed   ${s.monsterSpeed.toFixed(1)} m/s`;
  }

  const ui: DebugUI = {
    toggle() {
      visible = !visible;
      if (visible) gui.show();
      else gui.hide();
    },
    updateStats,
    dispose() {
      gui.destroy();
      statsEl.remove();
      styleEl.remove();
    },
  };
  return ui;
}
