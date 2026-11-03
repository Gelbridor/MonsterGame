// Quality presets and auto-detection. Numbers come from the plan's
// performance budget table.

import { config } from '../config';
import type { QualityLevel, QualityPreset } from './types';

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  ultra: {
    level: 'ultra',
    pixelRatio: 2,
    shadowMapSize: 2048,
    shadowsOnCity: true,
    antialias: true,
    maxActiveChunks: 1500,
    solverWorkScale: 1.25,
    maxParticles: 20000,
    cascadedShadows: true,
    post: { enabled: true, bloom: true, ao: true, ssr: true, aa: 'smaa', filmic: true, effectScale: 1 },
    maxDynamicLights: 48,
    rainDrops: 24000,
    materialDetail: 2,
    geometryDetail: 2,
  },
  high: {
    level: 'high',
    pixelRatio: 1.5,
    shadowMapSize: 2048,
    shadowsOnCity: true,
    antialias: true,
    maxActiveChunks: 800,
    solverWorkScale: 1,
    maxParticles: 10000,
    cascadedShadows: true,
    post: { enabled: true, bloom: true, ao: true, ssr: true, aa: 'smaa', filmic: true, effectScale: 0.5 },
    maxDynamicLights: 24,
    rainDrops: 12000,
    materialDetail: 2,
    geometryDetail: 2,
  },
  // Phone tier: monster-only shadows, no MSAA.
  medium: {
    level: 'medium',
    pixelRatio: 1.5,
    shadowMapSize: 1024,
    shadowsOnCity: false,
    antialias: false,
    maxActiveChunks: 300,
    solverWorkScale: 0.5,
    maxParticles: 3000,
    cascadedShadows: false,
    post: { enabled: true, bloom: true, ao: false, ssr: false, aa: 'fxaa', filmic: true, effectScale: 0.5 },
    maxDynamicLights: 8,
    rainDrops: 4000,
    materialDetail: 1,
    geometryDetail: 1,
  },
  // Weak phones: no shadow maps at all (blob shadows come later).
  low: {
    level: 'low',
    pixelRatio: 1,
    shadowMapSize: 0,
    shadowsOnCity: false,
    antialias: false,
    maxActiveChunks: 150,
    solverWorkScale: 0.35,
    maxParticles: 1000,
    cascadedShadows: false,
    post: { enabled: false, bloom: false, ao: false, ssr: false, aa: 'none', filmic: false, effectScale: 0.5 },
    maxDynamicLights: 4,
    rainDrops: 1500,
    materialDetail: 1,
    geometryDetail: 0,
  },
};

const LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

/** Look up a preset by level. */
export function getQualityPreset(level: QualityLevel): QualityPreset {
  return QUALITY_PRESETS[level];
}

/** True for phones / tablets: coarse primary pointer, mobile UA, or multi-touch on a small screen. */
function isMobileLike(): boolean {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const mobileUA = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const smallTouch = navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) <= 900;
  return coarse || mobileUA || smallTouch;
}

// ------------------------------------------------------------------ GPU identity

export type GpuClass = 'software' | 'mobile' | 'weak' | 'integrated' | 'discrete' | 'highend' | 'unknown';

export interface QualitySelection {
  level: QualityLevel;
  /** Short human-readable reason, shown in the stats overlay. */
  reason: string;
  /** GPU identity string ('' when unknown). */
  gpu: string;
  /** Starting render-resolution scale. */
  renderScale: number;
  /** Start on WebGL 2 instead of WebGPU (integrated GPUs). */
  preferWebGL: boolean;
  /** Why the backend was chosen ('' when left to auto). */
  backendReason: string;
  /** True when the URL forced the level (no automatic step-down). */
  forced: boolean;
}

const KEY_AUTO = 'mb.qualityAuto';
const KEY_AUTO_AT = 'mb.qualityAutoAt';
const KEY_TOAST = 'mb.qualityToast';

/** Identify the GPU: WebGPU adapter info first, then the WebGL unmasked renderer. Never throws. */
export async function probeGpu(): Promise<string> {
  const params = new URLSearchParams(window.location.search);
  const forcedGL = params.has('webgl') || params.get('backend') === 'webgl';
  const gpuApi = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (gpuApi && !forcedGL) {
    try {
      const adapter = (await gpuApi.requestAdapter()) as
        | { info?: { vendor?: string; architecture?: string; description?: string; device?: string }; isFallbackAdapter?: boolean }
        | null;
      const info = adapter?.info;
      const parts = [info?.vendor, info?.architecture, info?.description, info?.device].filter(Boolean);
      if (adapter?.isFallbackAdapter) parts.push('software fallback');
      if (parts.length > 0) {
        // The WebGL string is often more descriptive (full marketing name); append it when available.
        const gl = probeWebGLRenderer();
        const joined = parts.join(' ');
        return gl && !joined.toLowerCase().includes(gl.toLowerCase()) ? `${gl} / ${joined}` : joined;
      }
    } catch {
      // fall through to WebGL
    }
  }
  return probeWebGLRenderer();
}

function probeWebGLRenderer(): string {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const s = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return s;
  } catch {
    return '';
  }
}

/** Classify a GPU identity string. Pure, so it can be tested in a console. */
export function classifyGpu(raw: string): GpuClass {
  const g = raw.toLowerCase().replace(/\((r|tm)\)/g, '');
  if (!g) return 'unknown';
  if (/swiftshader|llvmpipe|softpipe|lavapipe|microsoft basic|basic render|software fallback|software rasteri/.test(g)) return 'software';
  if (/mali|adreno|powervr|videocore|immortalis|xclipse/.test(g)) return 'mobile';
  if (/nvidia|geforce|quadro|\brtx\b|\bgtx\b/.test(g)) {
    if (/\bmx\s?\d{3}\b/.test(g)) return 'integrated';
    if (/\brtx\b|ampere|\bada\b|lovelace|turing|blackwell/.test(g)) return 'highend';
    return 'discrete';
  }
  if (/intel/.test(g)) {
    // Arc A/B-series (and xe-hpg) are discrete; everything else, including "Arc Graphics" iGPUs, is integrated.
    if (/\barc\b.*\b[ab]\d{3}\b|xe-hpg|xe2-hpg|battlemage|alchemist/.test(g)) return /\b[ab]7\d\d\b|\bb5\d\d\b/.test(g) ? 'highend' : 'discrete';
    // Newer Intel iGPUs (Iris Xe, Arc Graphics, Xe-LP/LPG) are medium class; UHD / HD / Gen 9-11 are weak.
    if (/iris xe|arc.*graphics|xe-lpg?|xe2-lpg|gen-12/.test(g)) return 'integrated';
    return 'weak';
  }
  if (/apple/.test(g)) return /\b(pro|max|ultra)\b/.test(g) ? 'discrete' : 'integrated';
  if (/amd|radeon|ati\b|gcn|rdna/.test(g)) {
    const rx = /\brx\s*(\d{3,4})/.exec(g);
    if (rx) return rx[1].length === 4 && Number(rx[1]) >= 6000 ? 'highend' : 'discrete';
    if (/radeon pro (w|v)|\bvega (56|64)\b|radeon vii/.test(g)) return 'discrete';
    if (/radeon\s*\(?(tm)?\)?\s*graphics|vega|\b\d{3}m\b|gcn-5|integrated/.test(g)) return 'integrated';
    return 'unknown';
  }
  return 'unknown';
}

function readAuto(): QualityLevel | null {
  try {
    const v = localStorage.getItem(KEY_AUTO);
    return v && (LEVELS as readonly string[]).includes(v) ? (v as QualityLevel) : null;
  } catch {
    return null;
  }
}

/** Forget the stored automatic step-down. Takes effect after a reload. */
export function resetAutoQuality(): void {
  try {
    localStorage.removeItem(KEY_AUTO);
    localStorage.removeItem(KEY_AUTO_AT);
  } catch {
    // storage blocked
  }
}

let selection: QualitySelection = { level: 'high', reason: 'default', gpu: '', renderScale: 1, preferWebGL: false, backendReason: '', forced: false };
export function getQualitySelection(): QualitySelection {
  return selection;
}

/**
 * Pick a quality level (async: the GPU identity is).
 *  1. `?quality=low|medium|high|ultra` always wins and disables auto step-down.
 *     `?quality=auto` clears the stored step-down and uses the heuristic.
 *  2. A level stored by the runtime step-down (`mb.qualityAuto`).
 *  3. Heuristic. Software renderer: low. Mobile: medium, or low when weak (<= 4 cores / <= 3 GB).
 *     Desktop: weak integrated (Intel UHD/HD) low at 0.75x scale, other integrated medium; clearly discrete high-end GPU with >= 8 cores ultra;
 *     everything else (discrete, unknown) high.
 */
export async function pickQuality(): Promise<QualitySelection> {
  let q: string | null = null;
  try {
    q = new URLSearchParams(window.location.search).get('quality');
  } catch {
    // bad URL
  }
  const gpu = await probeGpu().catch(() => '');
  const cls = classifyGpu(gpu);
  const params = new URLSearchParams(window.location.search);
  // Integrated / low-power / software GPUs run faster on WebGL 2 than on WebGPU (measured on Intel UHD 620).
  // Apple M-series are exempt (Metal-backed WebGPU is fine). An explicit ?webgl / ?webgpu wins.
  const lowPower = cls === 'weak' || cls === 'mobile' || cls === 'software' || (cls === 'integrated' && !/apple/i.test(gpu));
  const explicit = params.has('webgl') || params.has('webgpu') || params.get('backend') !== null;
  const preferWebGL = lowPower && !explicit;
  const backendReason = explicit ? 'URL flag' : preferWebGL ? `${cls === 'software' ? 'software' : 'integrated'} GPU: WebGL 2` : '';
  const out = (level: QualityLevel, reason: string, forced = false, renderScale = 1): QualitySelection =>
    (selection = { level, reason, gpu, renderScale, preferWebGL, backendReason, forced });

  if (q && (LEVELS as readonly string[]).includes(q)) return out(q as QualityLevel, 'URL override', true);
  if (q === 'auto') resetAutoQuality();
  else {
    const stored = readAuto();
    if (stored) return out(stored, 'auto step-down (slow frames)', false, config.quality.startScaleWeak);
  }

  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

  if (cls === 'software') return out('low', 'software renderer');
  if (isMobileLike()) {
    if (cores <= 4 || (memory !== undefined && memory <= 3)) return out('low', `mobile, weak (${cores} cores)`);
    return out('medium', 'mobile');
  }
  if (cls === 'weak') return out('low', 'weak integrated GPU', false, config.quality.startScaleWeak);
  if (cls === 'integrated' || cls === 'mobile') return out('medium', 'integrated GPU');
  if (cls === 'highend' && cores >= 8) return out('ultra', `high-end GPU, ${cores} cores`);
  if (cls === 'highend') return out('high', `high-end GPU, only ${cores} cores`);
  if (cls === 'discrete') return out('high', 'discrete GPU');
  return out('high', 'GPU unknown, default');
}

// ------------------------------------------------------------------ runtime step-down

/** Show the toast left by a previous auto step-down, for config.quality.toastS seconds. */
export function showStoredToast(): void {
  let msg: string | null = null;
  try {
    msg = localStorage.getItem(KEY_TOAST);
    localStorage.removeItem(KEY_TOAST);
  } catch {
    return;
  }
  if (!msg) return;
  const el = document.createElement('div');
  el.textContent = msg;
  el.setAttribute('role', 'status');
  el.style.cssText =
    'position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);transform:translateX(-50%);' +
    'z-index:10001;padding:8px 14px;border-radius:6px;font:13px/1.3 system-ui,sans-serif;color:#e8eef5;' +
    'background:rgba(8,10,14,.78);pointer-events:none;transition:opacity .5s;opacity:1;max-width:90vw;text-align:center';
  document.body.appendChild(el);
  const ms = Math.max(1, config.quality.toastS) * 1000;
  setTimeout(() => (el.style.opacity = '0'), ms);
  setTimeout(() => el.remove(), ms + 600);
}

export interface AdaptiveQuality {
  /** Call every rendered frame with the raw frame time in seconds. */
  frame(frameDt: number): void;
}

/**
 * Adaptive quality, cheapest lever first:
 *  1. Dynamic resolution: every scaleIntervalS, judge the p80 frame time of that interval against the
 *     tier's fps target; too slow lowers config.render.renderScale by scaleDown (floor scaleMin), comfortably
 *     fast (fps > target x raiseFactor) raises it by scaleUp (cap 1). Disabled when the URL forces a tier.
 *  2. Only when the scale is at the floor and a full windowS is still too slow: step the tier down by one
 *     (store + reload). Never steps up, never when forced, cooldownS between steps.
 */
export function createAdaptiveQuality(level: QualityLevel, forced: boolean): AdaptiveQuality {
  const samples: { t: number; ms: number }[] = [];
  const startedAt = performance.now();
  let stepped = false;
  let lastDecision = 0;
  let floorSince = 0;
  let visibleAt = 0;
  document.addEventListener('visibilitychange', () => {
    visibleAt = performance.now();
  });
  const idx = LEVELS.indexOf(level);
  const pct = (arr: number[], p: number): number => {
    const sorted = arr.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  };

  return {
    frame(frameDt: number) {
      const qc = config.quality;
      if (stepped || forced || (!qc.autoStepDown && !qc.dynamicRes)) return;
      const now = performance.now();
      // Tab hidden / just resumed: drop the window and start over. (Frame time alone cannot tell a resume
      // from a very slow GPU: the loop clamps both to 250 ms.)
      if (document.hidden || now - visibleAt < 1000) {
        samples.length = 0;
        lastDecision = now;
        floorSince = 0;
        return;
      }
      if (now - startedAt < qc.startupIgnoreS * 1000) {
        lastDecision = now;
        return;
      }
      samples.push({ t: now, ms: frameDt * 1000 });
      const keepMs = Math.max(qc.windowS, qc.scaleIntervalS) * 1000;
      while (samples.length > 0 && now - samples[0].t > keepMs) samples.shift();

      const target = level === 'low' ? qc.minFpsLow : level === 'medium' ? qc.minFpsMedium : qc.minFpsHigh;
      const scale = config.render.renderScale;

      // ---- lever 1: render scale
      if (qc.dynamicRes && now - lastDecision >= qc.scaleIntervalS * 1000) {
        lastDecision = now;
        // Very slow frames (< 1.5 fps) leave fewer than 3 samples per interval: judge the last 3 then.
        const inInterval = samples.filter((s) => now - s.t <= qc.scaleIntervalS * 1000);
        const recent = (inInterval.length >= 3 ? inInterval : samples.slice(-3)).map((s) => s.ms);
        if (recent.length >= 2) {
          const fps = 1000 / pct(recent, qc.percentile);
          if (fps < target && scale > qc.scaleMin + 1e-6) {
            config.render.renderScale = Math.max(qc.scaleMin, Math.round((scale - qc.scaleDown) * 100) / 100);
            samples.length = 0; // judge the new scale on fresh frames
            return;
          }
          if (fps > target * qc.raiseFactor && scale < 1 - 1e-6) {
            config.render.renderScale = Math.min(1, Math.round((scale + qc.scaleUp) * 100) / 100);
            samples.length = 0;
            return;
          }
        }
      }

      // ---- lever 2: tier step-down, only from the scale floor (or when dynamic resolution is off)
      if (!qc.autoStepDown || idx <= 0) return;
      const atFloor = !qc.dynamicRes || scale <= qc.scaleMin + 1e-6;
      if (!atFloor) {
        floorSince = 0;
        return;
      }
      if (floorSince === 0) floorSince = now;
      const windowMs = qc.windowS * 1000;
      if (now - floorSince < windowMs || samples.length < 4 || now - samples[0].t < windowMs * 0.9) return;

      let lastAt = 0;
      try {
        lastAt = Number(localStorage.getItem(KEY_AUTO_AT)) || 0;
      } catch {
        // ignore
      }
      if (Date.now() - lastAt < qc.cooldownS * 1000) return;

      const p = pct(samples.map((s) => s.ms), qc.percentile);
      if (1000 / p >= target) return;

      const next = LEVELS[idx - 1];
      stepped = true;
      try {
        localStorage.setItem(KEY_AUTO, next);
        localStorage.setItem(KEY_AUTO_AT, String(Date.now()));
        localStorage.setItem(KEY_TOAST, `Quality lowered to ${next[0].toUpperCase()}${next.slice(1)} for smoother play`);
      } catch {
        return; // cannot persist: a reload would loop back to the same tier
      }
      console.warn(`[quality] ${level} ran at ${(1000 / p).toFixed(0)} fps (p${Math.round(qc.percentile * 100)}) at scale ${scale}, stepping down to ${next}`);
      window.location.reload();
    },
  };
}

/**
 * Synchronous quality pick without GPU knowledge (used by viewers and as a default argument).
 * The game itself uses pickQuality(); once that has run, this returns its result.
 */
export function detectQuality(): QualityLevel {
  if (selection.reason !== 'default') return selection.level;
  try {
    const q = new URLSearchParams(window.location.search).get('quality');
    if (q && (LEVELS as readonly string[]).includes(q)) return q as QualityLevel;
  } catch {
    // bad URL
  }
  const stored = readAuto();
  if (stored) return stored;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (isMobileLike()) return cores <= 4 || (memory !== undefined && memory <= 3) ? 'low' : 'medium';
  return 'high';
}
