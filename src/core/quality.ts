// Quality presets and auto-detection. Numbers come from the plan's
// performance budget table.

import type { QualityLevel, QualityPreset } from './types';

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  ultra: {
    level: 'ultra',
    pixelRatio: 2,
    shadowMapSize: 2048,
    shadowsOnCity: true,
    antialias: true,
    maxActiveChunks: 1500,
    maxParticles: 20000,
  },
  high: {
    level: 'high',
    pixelRatio: 1.5,
    shadowMapSize: 2048,
    shadowsOnCity: true,
    antialias: true,
    maxActiveChunks: 800,
    maxParticles: 10000,
  },
  // Phone tier: monster-only shadows, no MSAA.
  medium: {
    level: 'medium',
    pixelRatio: 1.5,
    shadowMapSize: 1024,
    shadowsOnCity: false,
    antialias: false,
    maxActiveChunks: 300,
    maxParticles: 3000,
  },
  // Weak phones: no shadow maps at all (blob shadows come later).
  low: {
    level: 'low',
    pixelRatio: 1,
    shadowMapSize: 0,
    shadowsOnCity: false,
    antialias: false,
    maxActiveChunks: 150,
    maxParticles: 1000,
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

/**
 * Pick a quality level.
 *  1. `?quality=low|medium|high|ultra` in the URL always wins.
 *  2. Mobile/touch-primary devices get 'medium', or 'low' when they look weak
 *     (hardwareConcurrency <= 4, or deviceMemory <= 3 GB where reported).
 *  3. Desktop gets 'high', or 'ultra' with hardwareConcurrency >= 12.
 */
export function detectQuality(): QualityLevel {
  try {
    const q = new URLSearchParams(window.location.search).get('quality');
    if (q && (LEVELS as readonly string[]).includes(q)) return q as QualityLevel;
  } catch {
    // bad URL: fall through to the heuristic
  }

  const cores = navigator.hardwareConcurrency || 4;
  // deviceMemory is Chromium-only and not in lib.dom.
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

  if (isMobileLike()) {
    if (cores <= 4 || (memory !== undefined && memory <= 3)) return 'low';
    return 'medium';
  }
  return cores >= 12 ? 'ultra' : 'high';
}
