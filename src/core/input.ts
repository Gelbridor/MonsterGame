// Unified input: keyboard + mouse, gamepad, and touch (virtual stick + look
// drag + placeholder action buttons). Produces one reusable InputSnapshot.
//
// Control map
//   Keyboard : WASD move (event.code, layout independent), Shift = run,
//              Arrow keys = look (no mouse needed), Backquote (`) = debug toggle.
//   Mouse    : hold left OR right button and drag on the game area = look.
//   Gamepad  : left stick / D-pad move, right stick look, L3 / RT / RB = run,
//              Back/Select (button 8) = debug toggle.
//   Touch    : left 45% of the screen = floating move stick (push past 90% of
//              its radius to run), right side drag = look, four action
//              buttons bottom-right (placeholders), three-finger tap = debug.

import { config } from '../config';
import type { Input, InputSnapshot } from './types';

// ---------------------------------------------------------------- exports

export type TouchAction = 'punch' | 'stomp' | 'grab' | 'special';

/**
 * Held state of the on-screen action buttons. Not part of the Input contract;
 * later phases can read this (or wire the buttons properly). Reset on dispose.
 */
export const actions: Record<TouchAction, boolean> = {
  punch: false,
  stomp: false,
  grab: false,
  special: false,
};

/** Haptics helper for later rumble. Returns false when unsupported. */
export function vibrate(pattern: number | number[]): boolean {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      return navigator.vibrate(pattern);
    }
  } catch {
    /* ignore */
  }
  return false;
}

// ---------------------------------------------------------------- constants

/** Fraction of the screen width (from the left) that owns the move stick. */
const STICK_ZONE = 0.45;
/** Touch look is a bit more sensitive than the mouse. */
const TOUCH_LOOK_MULT = 1.5;
/** Stick deflection (fraction of radius) beyond which touch counts as running. */
const TOUCH_RUN_THRESHOLD = 0.9;
/** Three-finger tap timing / tolerance. */
const TAP_START_WINDOW_MS = 250;
const TAP_END_WINDOW_MS = 400;
const TAP_MAX_MOVE_PX = 24;
/** Largest dt used for continuous (stick / arrow) look, guards tab-switch spikes. */
const MAX_LOOK_DT = 0.1;

const ACTION_LABELS: ReadonlyArray<readonly [TouchAction, string]> = [
  ['special', 'Special'],
  ['grab', 'Grab'],
  ['punch', 'Punch'],
  ['stomp', 'Stomp'],
];

const GAME_KEYS: ReadonlySet<string> = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight',
]);

const IGNORE_SELECTOR = '.lil-gui, input, select, textarea, a, button';

const STYLE_CSS = `
.mb-touch-root{position:fixed;inset:0;z-index:20;pointer-events:none;touch-action:none;
  user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;
  --mb-btn:max(64px,min(78px,17vmin));--mb-step:calc(var(--mb-btn)*.9);}
.mb-touch-root *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
.mb-stick{position:absolute;border-radius:50%;border:3px solid rgba(255,255,255,.6);
  background:rgba(255,255,255,.1);transition:opacity .15s;opacity:.95;will-change:left,top;}
.mb-stick.mb-idle{opacity:.28;
  left:calc(env(safe-area-inset-left,0px) + 28px);bottom:calc(env(safe-area-inset-bottom,0px) + 28px);}
.mb-knob{position:absolute;left:50%;top:50%;border-radius:50%;
  background:rgba(255,255,255,.5);border:2px solid rgba(255,255,255,.85);}
.mb-actions{position:absolute;pointer-events:none;
  right:calc(env(safe-area-inset-right,0px) + 18px);bottom:calc(env(safe-area-inset-bottom,0px) + 18px);
  width:calc(var(--mb-step)*2 + var(--mb-btn));height:calc(var(--mb-step)*2 + var(--mb-btn));}
.mb-act{position:absolute;width:var(--mb-btn);height:var(--mb-btn);border-radius:50%;
  pointer-events:auto;touch-action:none;display:flex;align-items:center;justify-content:center;
  font:700 12px/1 system-ui,-apple-system,sans-serif;letter-spacing:.02em;color:#fff;
  text-shadow:0 1px 2px rgba(0,0,0,.6);background:rgba(255,255,255,.14);
  border:2px solid rgba(255,255,255,.55);transition:background .08s,transform .08s;}
.mb-act.mb-down{background:rgba(255,255,255,.4);transform:scale(.93);}
.mb-act[data-mb-act="special"]{left:var(--mb-step);top:0;}
.mb-act[data-mb-act="grab"]{left:0;top:var(--mb-step);}
.mb-act[data-mb-act="punch"]{left:calc(var(--mb-step)*2);top:var(--mb-step);}
.mb-act[data-mb-act="stomp"]{left:var(--mb-step);top:calc(var(--mb-step)*2);}
`;

// ---------------------------------------------------------------- helpers

interface Vec2 {
  x: number;
  y: number;
}

const scratch: Vec2 = { x: 0, y: 0 };

/** Radial dead zone; output rescaled so it starts at 0 just past the zone. */
function radialDeadZone(x: number, y: number, out: Vec2): void {
  const dz = Math.min(Math.max(config.input.deadZone, 0), 0.95);
  const mag = Math.hypot(x, y);
  if (mag <= dz || mag === 0) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const k = (Math.min(mag, 1) - dz) / (1 - dz) / mag;
  out.x = x * k;
  out.y = y * k;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function isIgnoredTarget(t: EventTarget | null): boolean {
  const el = t as Element | null;
  return !!el && typeof el.closest === 'function' && el.closest(IGNORE_SELECTOR) !== null;
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

// ---------------------------------------------------------------- touch UI

interface TouchUI {
  root: HTMLDivElement;
  styleEl: HTMLStyleElement;
  /** Show the stick centred at viewport (x, y) with the given radius. */
  showStick(x: number, y: number, radius: number): void;
  moveKnob(dx: number, dy: number): void;
  idleStick(radius: number): void;
  setPressed(a: TouchAction, down: boolean): void;
  destroy(): void;
}

function createTouchUI(parent: HTMLElement): TouchUI {
  const styleEl = document.createElement('style');
  styleEl.setAttribute('data-mb-input', '');
  styleEl.textContent = STYLE_CSS;
  document.head.appendChild(styleEl);

  const root = document.createElement('div');
  root.className = 'mb-touch-root';

  const ring = document.createElement('div');
  ring.className = 'mb-stick mb-idle';
  const knob = document.createElement('div');
  knob.className = 'mb-knob';
  ring.appendChild(knob);
  root.appendChild(ring);

  const actionsEl = document.createElement('div');
  actionsEl.className = 'mb-actions';
  const buttons = new Map<TouchAction, HTMLDivElement>();
  for (const [key, label] of ACTION_LABELS) {
    const b = document.createElement('div');
    b.className = 'mb-act';
    b.setAttribute('data-mb-act', key);
    b.setAttribute('role', 'button');
    b.textContent = label;
    actionsEl.appendChild(b);
    buttons.set(key, b);
  }
  root.appendChild(actionsEl);
  parent.appendChild(root);

  const sizeStick = (radius: number): void => {
    const knobD = Math.round(radius * 0.85);
    ring.style.width = ring.style.height = `${radius * 2}px`;
    knob.style.width = knob.style.height = `${knobD}px`;
    knob.style.marginLeft = knob.style.marginTop = `${-knobD / 2}px`;
  };

  return {
    root,
    styleEl,
    showStick(x, y, radius) {
      sizeStick(radius);
      ring.classList.remove('mb-idle');
      ring.style.left = `${x - radius}px`;
      ring.style.top = `${y - radius}px`;
      ring.style.bottom = 'auto';
      knob.style.transform = 'translate(0px, 0px)';
    },
    moveKnob(dx, dy) {
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    },
    idleStick(radius) {
      sizeStick(radius);
      ring.classList.add('mb-idle');
      ring.style.left = ring.style.top = ring.style.bottom = '';
      knob.style.transform = 'translate(0px, 0px)';
    },
    setPressed(a, down) {
      buttons.get(a)?.classList.toggle('mb-down', down);
    },
    destroy() {
      root.remove();
      styleEl.remove();
    },
  };
}

// ---------------------------------------------------------------- input

export function createInput(target: HTMLElement): Input {
  const snap: InputSnapshot = {
    moveX: 0,
    moveY: 0,
    lookX: 0,
    lookY: 0,
    run: false,
    device: 'keyboard',
  };

  let disposed = false;
  const unlisten: Array<() => void> = [];
  const debugCallbacks: Array<() => void> = [];

  function listen<E extends Event>(
    el: EventTarget,
    type: string,
    fn: (e: E) => void,
    opts?: AddEventListenerOptions | boolean,
  ): void {
    el.addEventListener(type, fn as EventListener, opts);
    unlisten.push(() => el.removeEventListener(type, fn as EventListener, opts));
  }

  function fireDebug(): void {
    for (const cb of debugCallbacks.slice()) {
      try {
        cb();
      } catch (err) {
        console.error(err);
      }
    }
  }

  // Touch needs the browser to leave gestures alone on the game surface.
  const prevTouchAction = target.style.touchAction;
  const prevUserSelect = target.style.userSelect;
  target.style.touchAction = 'none';
  target.style.userSelect = 'none';

  // ---- shared state
  /** Look accumulated from pointer drags since the last read(). */
  let lookAccX = 0;
  let lookAccY = 0;

  const coarse = (() => {
    try {
      return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    } catch {
      return false;
    }
  })();
  snap.device = coarse ? 'touch' : 'keyboard';

  // ---- keyboard
  const keys = new Set<string>();

  listen<KeyboardEvent>(window, 'keydown', (ev) => {
    if (ev.code === 'Backquote') {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || isTypingTarget(ev.target)) return;
      ev.preventDefault();
      if (!ev.repeat) fireDebug();
      return;
    }
    if (ev.key === 'Meta' || ev.key === 'OS') keys.clear(); // keyups are swallowed under Cmd
    if (!GAME_KEYS.has(ev.code)) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey || isTypingTarget(ev.target)) return;
    if (!ev.code.startsWith('Shift')) ev.preventDefault();
    keys.add(ev.code);
    snap.device = 'keyboard';
  });
  listen<KeyboardEvent>(window, 'keyup', (ev) => {
    keys.delete(ev.code);
  });
  const releaseAll = (): void => {
    keys.clear();
    resetPointers();
  };
  listen(window, 'blur', releaseAll);
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState !== 'visible') releaseAll();
  });

  // ---- pointer state
  let mouseId: number | null = null;
  let mouseLastX = 0;
  let mouseLastY = 0;

  // touch
  let ui: TouchUI | null = null;
  const touches = new Map<number, Vec2>(); // active touch pointers -> down position
  let stickId: number | null = null;
  let stickBaseX = 0;
  let stickBaseY = 0;
  let stickVX = 0; // normalised, length <= 1, +y = screen down
  let stickVY = 0;
  let stickRun = false;
  let lookId: number | null = null;
  let lookLastX = 0;
  let lookLastY = 0;
  const actionPointers = new Map<number, TouchAction>();
  let wasLandscape = window.innerWidth >= window.innerHeight;

  // three-finger tap
  let tapFirstAt = 0;
  let tapArmedAt = 0;
  let tapArmed = false;
  let tapBroken = false;

  function ensureTouchUI(): void {
    if (ui || disposed) return;
    ui = createTouchUI(target);
    ui.idleStick(config.input.touchStickRadius);
  }
  if (coarse) ensureTouchUI();

  function resetStick(): void {
    stickId = null;
    stickVX = 0;
    stickVY = 0;
    stickRun = false;
    ui?.idleStick(config.input.touchStickRadius);
  }

  function clearActions(): void {
    for (const [, a] of actionPointers) {
      actions[a] = false;
      ui?.setPressed(a, false);
    }
    actionPointers.clear();
  }

  function resetPointers(): void {
    mouseId = null;
    lookId = null;
    resetStick();
    clearActions();
    touches.clear();
    tapArmed = false;
    tapBroken = false;
  }

  function actionFromTarget(t: EventTarget | null): TouchAction | null {
    const el = (t as Element | null)?.closest?.('[data-mb-act]');
    return el ? (el.getAttribute('data-mb-act') as TouchAction) : null;
  }

  function updateStick(x: number, y: number): void {
    const r = Math.max(config.input.touchStickRadius, 1);
    let dx = x - stickBaseX;
    let dy = y - stickBaseY;
    const len = Math.hypot(dx, dy);
    stickRun = len / r > TOUCH_RUN_THRESHOLD;
    if (len > r) {
      dx = (dx / len) * r;
      dy = (dy / len) * r;
    }
    stickVX = dx / r;
    stickVY = dy / r;
    ui?.moveKnob(dx, dy);
  }

  function touchDown(ev: PointerEvent): void {
    ensureTouchUI();
    snap.device = 'touch';
    const now = performance.now();

    // three-finger tap bookkeeping
    if (touches.size === 0) {
      tapFirstAt = now;
      tapArmed = false;
      tapBroken = false;
    }
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (touches.size === 3) {
      if (!tapBroken && now - tapFirstAt <= TAP_START_WINDOW_MS) {
        tapArmed = true;
        tapArmedAt = now;
      } else {
        tapBroken = true;
      }
    } else if (touches.size > 3) {
      tapBroken = true;
      tapArmed = false;
    }

    // action buttons: never start a stick / look-drag
    const act = actionFromTarget(ev.target);
    if (act) {
      actionPointers.set(ev.pointerId, act);
      actions[act] = true;
      ui?.setPressed(act, true);
      try {
        (ev.target as Element).setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      return;
    }

    try {
      target.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }

    const rect = target.getBoundingClientRect();
    const relX = rect.width > 0 ? (ev.clientX - rect.left) / rect.width : 0;
    if (relX < STICK_ZONE) {
      if (stickId === null) {
        const r = Math.max(config.input.touchStickRadius, 1);
        const pad = r + 8;
        stickId = ev.pointerId;
        stickBaseX = clamp(ev.clientX, pad, Math.max(pad, window.innerWidth - pad));
        stickBaseY = clamp(ev.clientY, pad, Math.max(pad, window.innerHeight - pad));
        stickVX = 0;
        stickVY = 0;
        stickRun = false;
        ui?.showStick(stickBaseX, stickBaseY, r);
        updateStick(ev.clientX, ev.clientY);
      }
    } else if (lookId === null) {
      lookId = ev.pointerId;
      lookLastX = ev.clientX;
      lookLastY = ev.clientY;
    }
  }

  function touchMove(ev: PointerEvent): void {
    const down = touches.get(ev.pointerId);
    if (down && !tapBroken && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > TAP_MAX_MOVE_PX) {
      tapBroken = true;
    }
    if (ev.pointerId === stickId) {
      snap.device = 'touch';
      updateStick(ev.clientX, ev.clientY);
    } else if (ev.pointerId === lookId) {
      snap.device = 'touch';
      const k = config.camera.lookSensitivity * TOUCH_LOOK_MULT;
      lookAccX += (ev.clientX - lookLastX) * k;
      lookAccY += (ev.clientY - lookLastY) * k;
      lookLastX = ev.clientX;
      lookLastY = ev.clientY;
    }
  }

  /** Common end-of-pointer handling (up, cancel, lost capture). */
  function releasePointer(id: number, cancelled: boolean): void {
    if (id === mouseId) mouseId = null;
    if (id === stickId) resetStick();
    if (id === lookId) lookId = null;
    const act = actionPointers.get(id);
    if (act !== undefined) {
      actionPointers.delete(id);
      actions[act] = false;
      ui?.setPressed(act, false);
    }
    if (touches.has(id)) {
      if (cancelled) tapBroken = true;
      touches.delete(id);
      if (touches.size === 0) {
        if (tapArmed && !tapBroken && performance.now() - tapArmedAt <= TAP_END_WINDOW_MS) {
          fireDebug();
        }
        tapArmed = false;
        tapBroken = false;
      }
    }
  }

  function mouseDown(ev: PointerEvent): void {
    if (mouseId !== null) return;
    // Left or right button (pens report button 0 on contact).
    if (ev.button !== 0 && ev.button !== 2) return;
    mouseId = ev.pointerId;
    mouseLastX = ev.clientX;
    mouseLastY = ev.clientY;
    snap.device = 'keyboard';
    try {
      target.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  }

  function mouseMove(ev: PointerEvent): void {
    if (ev.pointerId !== mouseId) return;
    if (ev.pointerType === 'mouse' && ev.buttons === 0) {
      mouseId = null; // missed the release
      return;
    }
    const k = config.camera.lookSensitivity;
    lookAccX += (ev.clientX - mouseLastX) * k;
    lookAccY += (ev.clientY - mouseLastY) * k;
    mouseLastX = ev.clientX;
    mouseLastY = ev.clientY;
    snap.device = 'keyboard';
  }

  // Capture phase so buttons that stop propagation never hide touches from us.
  listen<PointerEvent>(
    target,
    'pointerdown',
    (ev) => {
      if (isIgnoredTarget(ev.target)) return;
      if (ev.pointerType === 'touch') touchDown(ev);
      else mouseDown(ev);
    },
    true,
  );
  listen<PointerEvent>(
    target,
    'pointermove',
    (ev) => {
      if (ev.pointerType === 'touch') touchMove(ev);
      else mouseMove(ev);
    },
    true,
  );
  listen<PointerEvent>(target, 'pointerup', (ev) => releasePointer(ev.pointerId, false), true);
  listen<PointerEvent>(target, 'pointercancel', (ev) => releasePointer(ev.pointerId, true), true);
  listen<PointerEvent>(
    target,
    'lostpointercapture',
    (ev) => {
      // Re-targeting implicit touch capture to `target` fires this on the old
      // element; only a loss on our own capture holders means the pointer is gone.
      const t = ev.target as Element | null;
      if (t === target || actionFromTarget(t)) releasePointer(ev.pointerId, true);
    },
    true,
  );

  // No context menu on right-drag / long-press, no iOS pinch zoom.
  listen<Event>(target, 'contextmenu', (ev) => {
    if (!isIgnoredTarget(ev.target)) ev.preventDefault();
  });
  listen<Event>(target, 'gesturestart', (ev) => ev.preventDefault(), { passive: false });

  // Orientation change: stick/look positions are meaningless afterwards.
  const onOrientation = (): void => {
    wasLandscape = window.innerWidth >= window.innerHeight;
    resetPointers();
  };
  listen(window, 'orientationchange', onOrientation);
  listen(window, 'resize', () => {
    // Ignore URL-bar resizes mid-drag; only a real portrait/landscape flip counts.
    if (window.innerWidth >= window.innerHeight !== wasLandscape) onOrientation();
  });
  try {
    const so = screen.orientation;
    if (so && typeof so.addEventListener === 'function') listen(so, 'change', onOrientation);
  } catch {
    /* ignore */
  }

  // ---- gamepad
  let padBackPrev = false;
  let padIndexPrev = -1;

  function pickPad(): Gamepad | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    let pads: ArrayLike<Gamepad | null>;
    try {
      pads = navigator.getGamepads();
    } catch {
      return null;
    }
    let fallback: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      if (p.mapping === 'standard') return p;
      if (!fallback) fallback = p;
    }
    return fallback;
  }

  const padBtn = (p: Gamepad, i: number): number => {
    const b = p.buttons[i];
    return b ? (b.pressed && b.value < 0.01 ? 1 : b.value) : 0;
  };

  // ---- read()
  function read(dt: number): InputSnapshot {
    const ldt = clamp(Number.isFinite(dt) ? dt : 0, 0, MAX_LOOK_DT);

    // keyboard
    let mx = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    let my = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    let run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const arrowX = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
    const arrowY = (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0);
    const keyLook = config.camera.stickLookSpeed * ldt;
    let lx = lookAccX + arrowX * keyLook;
    let ly = lookAccY + arrowY * keyLook;
    lookAccX = 0;
    lookAccY = 0;

    // touch stick
    if (stickId !== null) {
      radialDeadZone(stickVX, stickVY, scratch);
      if (scratch.x !== 0 || scratch.y !== 0) snap.device = 'touch';
      mx += scratch.x;
      my -= scratch.y; // screen down -> backwards
      if (stickRun) run = true;
    }

    // gamepad
    const pad = pickPad();
    if (pad) {
      if (pad.index !== padIndexPrev) {
        padIndexPrev = pad.index;
        padBackPrev = padBtn(pad, 8) > 0.5; // don't fire on connect
      }
      let active = false;

      radialDeadZone(pad.axes[0] ?? 0, pad.axes[1] ?? 0, scratch);
      let gx = scratch.x;
      let gy = -scratch.y;
      if (gx !== 0 || gy !== 0) active = true;
      const dx = (padBtn(pad, 15) > 0.5 ? 1 : 0) - (padBtn(pad, 14) > 0.5 ? 1 : 0);
      const dy = (padBtn(pad, 12) > 0.5 ? 1 : 0) - (padBtn(pad, 13) > 0.5 ? 1 : 0);
      if (dx !== 0 || dy !== 0) {
        active = true;
        gx += dx;
        gy += dy;
      }
      mx += gx;
      my += gy;

      radialDeadZone(pad.axes[2] ?? 0, pad.axes[3] ?? 0, scratch);
      if (scratch.x !== 0 || scratch.y !== 0) {
        active = true;
        const s = config.camera.stickLookSpeed * ldt;
        lx += scratch.x * s;
        ly += scratch.y * s; // stick up is negative axis -> look up (negative)
      }

      if (padBtn(pad, 10) > 0.5 || padBtn(pad, 7) > 0.5 || padBtn(pad, 5) > 0.5) {
        run = true;
        active = true;
      }

      const back = padBtn(pad, 8) > 0.5;
      if (back && !padBackPrev) fireDebug();
      padBackPrev = back;

      if (!active) {
        for (let i = 0; i < pad.buttons.length; i++) {
          if (pad.buttons[i]?.pressed) {
            active = true;
            break;
          }
        }
      }
      if (active) snap.device = 'gamepad';
    } else {
      padIndexPrev = -1;
      padBackPrev = false;
    }

    // clamp movement vector to the unit disc
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }

    snap.moveX = mx;
    snap.moveY = my;
    snap.lookX = lx;
    snap.lookY = ly;
    snap.run = run;
    return snap;
  }

  return {
    read,
    onDebugToggle(cb) {
      debugCallbacks.push(cb);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of unlisten) off();
      unlisten.length = 0;
      debugCallbacks.length = 0;
      keys.clear();
      clearActions();
      ui?.destroy();
      ui = null;
      for (const k of Object.keys(actions) as TouchAction[]) actions[k] = false;
      target.style.touchAction = prevTouchAction;
      target.style.userSelect = prevUserSelect;
    },
  };
}
