// Canal (copings, lock gate, moored narrowboats) and the brick railway viaduct
// with real arches. Colliders are created by the caller to match the
// original blockout (deck + piers, bank wall).

import * as THREE from 'three/webgpu';
import type { BuilderSet, BuildCtx } from './buildings';
import { setPaint } from './buildings';
import type { TownLayout } from './town-layout';

export interface ViaductGeometry {
  deckBase: number;
  deckH: number;
  pitch: number;
  pierLen: number;
  pierW: number;
  count: number;
}

export const VIADUCT = { deckBase: 10, deckH: 2.5, pitch: 16, pierLen: 5 };

export function viaductParams(layout: TownLayout): ViaductGeometry {
  const v = layout.viaduct;
  const len = v.z1 - v.z0;
  const w = v.x1 - v.x0;
  return { ...VIADUCT, pierW: w - 2, count: Math.floor(len / VIADUCT.pitch) };
}

/** Brick arches: one extruded wall profile (with arch holes) per side, plus top, track and parapets. */
export function buildViaduct(layout: TownLayout, b: BuilderSet, ctx: BuildCtx): void {
  const v = layout.viaduct;
  const vp = viaductParams(layout);
  const w = v.x1 - v.x0;
  const cx = (v.x0 + v.x1) / 2;
  const topY = vp.deckBase + vp.deckH;
  const len = v.z1 - v.z0;
  const vb = b.viaduct;
  vb.clearFrame();
  vb.setAttrs([1, 1, 1, 0.8], [99, 0, 0, 0], [topY, topY, 0.21, 0]);

  // Profile in (s, y) where s = z1 - z. Arches sit in the gaps between piers.
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(len, 0);
  shape.lineTo(len, topY);
  shape.lineTo(0, topY);
  shape.lineTo(0, 0);
  const gap = vp.pitch - vp.pierLen;
  const r = gap / 2;
  const spring = vp.deckBase - 1.0 - r; // crown 1 m below the deck
  for (let i = 0; i < vp.count - 1; i++) {
    const zA = v.z0 + vp.pitch * (i + 0.5) + vp.pierLen / 2; // z of arch start (north side)
    const zB = zA + gap;
    const sA = v.z1 - zB;
    const hole = new THREE.Path();
    hole.moveTo(sA, 0);
    hole.lineTo(sA + gap, 0);
    hole.lineTo(sA + gap, spring);
    hole.absarc(sA + r, spring, r, 0, Math.PI, false);
    hole.lineTo(sA, 0);
    shape.holes.push(hole);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false, steps: 1, curveSegments: ctx.geo >= 2 ? 14 : 8 });
  // map (s, y, ez) -> world (x = x0 + ez, y, z = z1 - s)
  const m = new THREE.Matrix4().set(
    0, 0, 1, v.x0,
    0, 1, 0, 0,
    -1, 0, 0, v.z1,
    0, 0, 0, 1,
  );
  vb.addGeometry(geo, m);
  geo.dispose();

  // deck top, parapets with copings, ballast, track
  const pnt = b.paint;
  const par = vb;
  par.setAttrs([1, 1, 1, 0.9], [99, 0, 0, 0], [1.2, 1.2, 0.8, 0]);
  const cz = (v.z0 + v.z1) / 2;
  for (const side of [-1, 1]) {
    par.box(cx + side * (w / 2 - 0.35), topY + 0.55, cz, 0.7, 1.1, len);
  }
  setPaint(pnt, 0x6d695f, 0, 0.85);
  for (const side of [-1, 1]) pnt.box(cx + side * (w / 2 - 0.35), topY + 1.14, cz, 0.9, 0.12, len);
  setPaint(pnt, 0x2a2724, 0, 0.95);
  pnt.box(cx, topY + 0.18, cz, w - 1.6, 0.36, len);
  if (ctx.geo >= 1) {
    // rails
    setPaint(pnt, 0x6b5a4a, 0.7, 0.45);
    for (const s of [-0.72, 0.72]) pnt.box(cx + s, topY + 0.45, cz, 0.07, 0.16, len);
    // sleepers
    setPaint(pnt, 0x1a1512, 0, 0.9);
    const step = ctx.geo >= 2 ? 0.75 : 2.2;
    for (let z = v.z0 + 1; z < v.z1 - 1; z += step) pnt.box(cx, topY + 0.38, z, 2.5, 0.1, 0.24);
    // signal posts with red / green aspects
    for (let i = 0; i < 6; i++) {
      const z = v.z0 + 30 + i * 62;
      setPaint(pnt, 0x303438, 0.5, 0.5);
      pnt.cylinder(cx + 2.2, topY + 0.4, z, 0.08, 0.08, 4.0, 6, true);
      pnt.box(cx + 2.2, topY + 4.3, z, 0.35, 1.0, 0.3);
      setPaint(pnt, 0x300000, 0, 0.5, i % 2 === 0 ? 0xff2010 : 0x20ff50, 4.5);
      pnt.box(cx + 2.2 - 0.18, topY + 4.55, z, 0.04, 0.22, 0.22);
    }
  }
}

/** Canal: stone bank, copings, far bank, lock gate and narrowboats. */
export function buildCanal(layout: TownLayout, b: BuilderSet, ctx: BuildCtx): void {
  const c = layout.canal;
  const wallZ = c.z1 - 0.4;
  const len = c.x1 - c.x0;
  const st = b.sootStone;
  const pnt = b.paint;
  st.clearFrame();
  st.setAttrs([1, 1, 1, 0.6], [99, 0, 0, 0], [2, 2, 0.33, 0]);
  st.box(0, 1, wallZ, len, 2, 0.8);
  // far bank wall
  st.box(0, 0.8, c.z0 + 0.4, len, 1.6, 0.8);
  setPaint(pnt, 0x77736a, 0, 0.85);
  pnt.box(0, 2.07, wallZ, len, 0.14, 1.1);
  pnt.box(0, 1.67, c.z0 + 0.45, len, 0.14, 1.1);
  if (ctx.geo >= 1) {
    // iron bollards along the towpath edge
    setPaint(pnt, 0x1a1a1c, 0.6, 0.5);
    for (let x = c.x0 + 8; x < c.x1; x += 18) {
      pnt.cylinder(x, 2.14, wallZ, 0.13, 0.1, 0.45, 6, true);
    }
    // lock gate: two leaves meeting in a V, balance beams over the banks
    const xg = 30;
    const wz0 = wallZ - 0.4; // water edge
    const wz1 = c.z0 + 0.8;
    const mid = (wz0 + wz1) / 2;
    for (const [zs, sgn] of [[wz0, 1], [wz1, -1]] as Array<[number, number]>) {
      const dx = 2.4, dz = (mid - zs);
      const L = Math.hypot(dx, dz);
      const yaw = Math.atan2(-dz, dx);
      setPaint(pnt, 0x0e0f10, 0, 0.7);
      pnt.boxRot(xg + dx / 2, 1.0, (zs + mid) / 2, L, 2.2, 0.32, yaw);
      // balance beam (white tip) extending back over the bank
      setPaint(pnt, 0x181818, 0, 0.7);
      const bx = xg - 0.3, bzOut = zs - sgn * 3.2;
      pnt.boxRot(bx, 2.2, (zs + bzOut) / 2, 0.3, 0.3, 3.8 + 0.0, 0);
      setPaint(pnt, 0xe8e8e0, 0, 0.6);
      pnt.box(bx, 2.2, bzOut - sgn * 0.0, 0.3, 0.3, 1.2);
    }
    // lock-side walkway planks and stone
    setPaint(pnt, 0x3a2a1c, 0, 0.9);
    pnt.box(xg + 1.2, 2.4, mid, 0.9, 0.08, 6.2);
    // narrowboats
    const boats: Array<[number, number, number]> = [[-120, 0x1f4d6a, 0xc03030], [-52, 0x1c5a34, 0xe0b030], [90, 0x6a2424, 0x2a4a7a]];
    for (const [bx0, hullCol, trim] of boats) {
      const bz = wallZ - 3.4;
      setPaint(pnt, 0x15181a, 0.2, 0.5);
      pnt.box(bx0, 0.55, bz, 17, 1.0, 2.0);
      setPaint(pnt, hullCol, 0.2, 0.45);
      pnt.box(bx0 - 1.0, 1.25, bz, 13, 1.1, 1.9);
      setPaint(pnt, trim, 0.2, 0.45);
      pnt.box(bx0 - 1.0, 1.85, bz, 13.3, 0.14, 2.05);
      setPaint(pnt, 0x111111, 0.4, 0.5);
      pnt.cylinder(bx0 + 2.0, 1.9, bz, 0.12, 0.1, 0.9, 6, true);
      // lit cabin windows on both sides
      const w = b.windows;
      for (const side of [-1, 1]) {
        for (let i = 0; i < 6; i++) {
          const wx = bx0 - 6.0 + i * 1.9;
          w.setAttrs([ctx.rng(), 2, 1.4, 1.1], [1.0, 0.55, 0.2, 0.3], [1.6, 0.8, 1.0, 0]);
          w.plane([wx, 1.35, bz + side * 0.96], [side, 0, 0], [0, 1, 0], 1.0, 0.55);
        }
      }
    }
  }
  void layout;
}
