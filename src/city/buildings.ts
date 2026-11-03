// Per-BuildingSpec visual generation. Everything is appended to shared
// MeshBuilders (one per material) so the whole town is a few draw calls.
//
// Phase 2 can replace `buildBuildingVisual` with fracturable pieces: nothing
// here touches physics (colliders live in `addBuildingColliders`).

import * as THREE from 'three/webgpu';
import { FACE, MeshBuilder, type V3, type V4 } from './mesh-builder';
import type { BuildingSpec, TownLayout } from './town-layout';
import type { SignAtlas, SignName } from './signage';

export interface BuilderSet {
  viaduct: MeshBuilder;
  brick: MeshBuilder;
  sandstone: MeshBuilder;
  sootStone: MeshBuilder;
  concrete: MeshBuilder;
  slate: MeshBuilder;
  curtain: MeshBuilder;
  windows: MeshBuilder;
  paint: MeshBuilder;
  rust: MeshBuilder;
  signs: MeshBuilder;
}

export interface BuildCtx {
  b: BuilderSet;
  rng: () => number;
  /** geometryDetail 0..2 */
  geo: 0 | 1 | 2;
  atlas: SignAtlas;
  layout: TownLayout;
  /** Filled by generators: positions of lit things the lamp-pool bake can use (shop spill etc). */
  spills: Array<{ x: number; z: number; color: [number, number, number]; weight: number; radius: number }>;
  /** Ids chosen for special treatment. */
  pubId: number;
  tallestOfficeId: number;
  tallestTowerIds: number[];
}

// ------------------------------------------------------------------ helpers

const col = new THREE.Color();
export const lin = (hex: number): [number, number, number] => {
  col.setHex(hex);
  return [col.r, col.g, col.b];
};

/** Set the paint attributes (colour, metalness, roughness, emissive colour * intensity). */
export function setPaint(b: MeshBuilder, hex: number, metal = 0, rough = 0.5, emissive?: number, intensity = 0): void {
  const [r, g, bl] = lin(hex);
  const [er, eg, eb] = emissive !== undefined ? lin(emissive) : [0, 0, 0];
  b.setAttrs([r, g, bl, metal], [er * intensity, eg * intensity, eb * intensity, rough], [0, 0, 0, 0]);
}

type Face = 0 | 1 | 2 | 3; // +z, -z, +x, -x (outward)
const FACE_N: V3[] = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]];
const FACE_R: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 0, -1], [0, 0, 1]];
const FACE_BIT = [FACE.PZ, FACE.NZ, FACE.PX, FACE.NX];

/** Face extents: `len` along the face, plane offset from the centre. */
function faceInfo(spec: BuildingSpec, f: Face): { len: number; half: number; plane: number } {
  const alongX = f < 2;
  return { len: alongX ? spec.width : spec.depth, half: (alongX ? spec.width : spec.depth) / 2, plane: alongX ? spec.depth / 2 : spec.width / 2 };
}

function facePos(spec: BuildingSpec, f: Face, u: number, y: number, out: number): V3 {
  const { plane } = faceInfo(spec, f);
  switch (f) {
    case 0: return [u, y, plane + out];
    case 1: return [u, y, -plane - out];
    case 2: return [plane + out, y, u];
    default: return [-plane - out, y, u];
  }
}

/** Draw one wall face (no top/bottom) of the spec's box between y0 and y1. */
function wallFace(b: MeshBuilder, spec: BuildingSpec, f: Face, y0: number, y1: number): void {
  b.box(0, (y0 + y1) / 2, 0, spec.width, y1 - y0, spec.depth, 63 & ~FACE_BIT[f]);
}

/** Which face fronts the street: the long face closest to a road centre line. */
export function frontFace(spec: BuildingSpec, layout: TownLayout): Face {
  const dist = (f: Face): number => {
    const { plane } = faceInfo(spec, f);
    let pos: number, roads: number[], dir: number;
    if (f < 2) { dir = f === 0 ? 1 : -1; pos = spec.z + dir * plane; roads = layout.roadZ; }
    else { dir = f === 2 ? 1 : -1; pos = spec.x + dir * plane; roads = layout.roadX; }
    let best = 1e9;
    for (const r of roads) {
      const d = (r - pos) * dir;
      if (d > -1 && d < best) best = d;
    }
    return best;
  };
  let bestF: Face = 0;
  let bestScore = 1e9;
  for (const f of [0, 1, 2, 3] as Face[]) {
    const { len } = faceInfo(spec, f);
    const longest = Math.max(spec.width, spec.depth);
    const score = dist(f) + (len < longest * 0.99 ? 6 : 0);
    if (score < bestScore) { bestScore = score; bestF = f; }
  }
  return bestF;
}

const BRICK_TINT: Record<string, [number, number, number]> = {
  brick0: [1.0, 0.95, 0.92],
  brick1: [1.2, 1.05, 0.95],
  brick2: [0.82, 0.78, 0.8],
  brick3: [0.9, 0.98, 1.05],
  shopBrick: [1.3, 1.12, 0.95],
};

interface WinOpts {
  kind: number; lit: number; warm: number;
  roomW: number; floorBase: number; depth?: number; out?: number; seed?: number;
}

/** A lit window pane in the plane of a wall face (u along the face, y0 bottom). */
function addWin(ctx: BuildCtx, spec: BuildingSpec, f: Face, u: number, y0: number, ww: number, wh: number, o: WinOpts): void {
  const w = ctx.b.windows;
  const seed = o.seed ?? ctx.rng();
  const roomH = spec.floorHeight;
  w.setAttrs(
    [seed, o.kind, o.roomW, roomH],
    [ww, wh, (o.roomW - ww) / 2, y0 - o.floorBase],
    [o.depth ?? 3.2, o.lit, o.warm, 0],
  );
  w.plane(facePos(spec, f, u, y0 + wh / 2, o.out ?? 0.025), FACE_R[f], [0, 1, 0], ww, wh);
}

/** Stone sill + lintel around a window (cheap geometry detail). */
function addSillLintel(ctx: BuildCtx, spec: BuildingSpec, f: Face, u: number, y0: number, ww: number, wh: number, stone = 0x8c8678): void {
  if (ctx.geo < 1) return;
  const p = ctx.b.paint;
  setPaint(p, stone, 0, 0.85);
  const horiz = f < 2;
  const pos = (y: number, out: number): V3 => facePos(spec, f, u, y, out);
  const s1 = pos(y0 - 0.045, 0.09);
  const s2 = pos(y0 + wh + 0.09, 0.05);
  const mk = (c: V3, w: number, h: number, d: number): void => {
    if (horiz) p.box(c[0], c[1], c[2] + (f === 0 ? 0 : 0), w, h, d);
    else p.box(c[0], c[1], c[2], d, h, w);
  };
  mk(s1, ww + 0.22, 0.09, 0.2);
  mk(s2, ww + 0.2, 0.17, 0.13);
}

// ------------------------------------------------------------------ terraces + corner shops

const DOOR_COLOURS = [0x7a1a1a, 0x1d3a2c, 0x1b2c4e, 0x141414, 0xd9cfb0, 0xb8872a, 0x5a1f4a, 0x2a5a5a, 0x8a2a14];
const SHOP_NAMES: SignName[] = ['chippy', 'news', 'offLicence', 'launderette', 'kebab', 'chemist', 'takeaway', 'cafe', 'butcher', 'pawn'];

function gableWalls(b: MeshBuilder, len: number, wid: number, y0: number, rise: number, alongX: boolean): void {
  const gw = wid / 2;
  const top = y0 + rise;
  for (const s of [-1, 1]) {
    const a = s * (len / 2);
    const P = (c: number, y: number): V3 => (alongX ? [a, y, c] : [c, y, a]);
    const n: V3 = alongX ? [s, 0, 0] : [0, 0, s];
    // choose winding so the normal faces outwards
    const p0 = P(-gw, y0 - 0.02), p1 = P(gw, y0 - 0.02), p2 = P(0, top);
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    const d = (ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2];
    const uA: [number, number] = [alongX ? -gw : -gw, y0], uB: [number, number] = [gw, y0], uC: [number, number] = [0, top];
    if (d >= 0) b.tri(p0, p1, p2, uA, uB, uC, n);
    else b.tri(p0, p2, p1, uA, uC, uB, n);
  }
}

function slateRoof(ctx: BuildCtx, spec: BuildingSpec, y0: number, rise: number, alongX: boolean, over = 0.28): void {
  const len = alongX ? spec.width : spec.depth;
  const wid = alongX ? spec.depth : spec.width;
  const s = ctx.b.slate;
  s.setAttrs(undefined, undefined, [0, 0, (spec.id * 0.6180339) % 1, 0]);
  s.gableRoof(0, y0, 0, len + 0.0, wid, rise, alongX, over, false);
  // gables in the wall material
  const gb = spec.type === 'church' ? ctx.b.sootStone : spec.type === 'townHall' ? ctx.b.sandstone : ctx.b.brick;
  gableWalls(gb, len, wid, y0, rise, alongX);
}

function chimney(ctx: BuildCtx, spec: BuildingSpec, x: number, z: number, y0: number, h: number, alongX: boolean, pots: number): void {
  const b = ctx.b.brick;
  const sx = alongX ? 0.95 : 0.6;
  const sz = alongX ? 0.6 : 0.95;
  b.setAttrs([1.05, 0.95, 0.9, 0.9], [2, 0, 0.9, 0.9], [3.2, 40, (spec.id * 0.37 + x * 0.013) % 1, 0]);
  b.box(x, y0 + h / 2, z, sx, h, sz, FACE.NY);
  const p = ctx.b.paint;
  // stone cap
  setPaint(p, 0x7a756b, 0, 0.9);
  p.box(x, y0 + h + 0.05, z, sx + 0.14, 0.1, sz + 0.14, FACE.NY);
  if (ctx.geo >= 2) {
    setPaint(p, 0xa5573a, 0, 0.75);
    const n = Math.min(pots, 3);
    for (let i = 0; i < n; i++) {
      const o = (i - (n - 1) / 2) * 0.28;
      const px = alongX ? x + o : x;
      const pz = alongX ? z : z + o;
      p.cylinder(px, y0 + h + 0.1, pz, 0.1, 0.085, 0.42, 6, true);
      p.cylinder(px, y0 + h + 0.5, pz, 0.12, 0.1, 0.1, 6, true);
    }
  }
}

function buildTerrace(spec: BuildingSpec, ctx: BuildCtx): void {
  const { width: w, depth: d, floors, floorHeight: fh, height: h } = spec;
  const isShop = spec.type === 'cornerShop';
  const front = frontFace(spec, ctx.layout);
  const back = (front ^ 1) as Face;
  const alongX = front < 2;
  const L = alongX ? w : d;
  const u0 = -L / 2;
  const nHouse = Math.max(1, Math.round(L / 5));
  const houseW = L / nHouse;
  const bayW = houseW / 2;
  const phase = u0 + houseW / 4;
  const tint = BRICK_TINT[spec.material] ?? [1, 1, 1];
  const seed = (spec.id * 0.6180339 + 0.13) % 1;
  const soot = 0.35 + ctx.rng() * 0.4;
  const rng = ctx.rng;
  const bk = ctx.b.brick;
  const isPub = spec.id === ctx.pubId;

  // shop occupies the 2 houses nearest the nearest road along the frontage
  let shopHouses = new Set<number>();
  let shopEndLow = true;
  if (isShop) {
    const fAxis = alongX ? spec.x : spec.z;
    const ends = [fAxis - L / 2, fAxis + L / 2];
    const roads = alongX ? ctx.layout.roadX : ctx.layout.roadZ;
    const dd = ends.map((e) => Math.min(...roads.map((r) => Math.abs(r - e))));
    shopEndLow = dd[0] <= dd[1];
    const n = Math.min(2, nHouse - 1);
    shopHouses = new Set(shopEndLow ? Array.from({ length: n }, (_, i) => i) : Array.from({ length: n }, (_, i) => nHouse - 1 - i));
  }

  // --- walls
  bk.setFrame(spec.x, spec.z, spec.yaw);
  for (const f of [0, 1, 2, 3] as Face[]) {
    const isFB = f === front || f === back;
    bk.setAttrs(
      [tint[0], tint[1], tint[2], soot],
      isFB ? [bayW, phase, 1.05, 0.9] : [99, 0, 0, 0],
      [fh, h, seed, 0],
    );
    wallFace(bk, spec, f, 0, h);
  }

  // --- roof (ridge parallel to the street)
  const wid = alongX ? d : w;
  const rise = Math.min(3.4, Math.max(2.4, wid * 0.32));
  slateRoof(ctx, spec, h, rise, alongX);
  const pnt = ctx.b.paint;
  if (ctx.geo >= 1) {
    setPaint(pnt, 0x1a1210, 0, 0.7);
    const rl = L + 0.1;
    if (alongX) pnt.box(0, h + rise + 0.03, 0, rl, 0.12, 0.26);
    else pnt.box(0, h + rise + 0.03, 0, 0.26, 0.12, rl);
    // gutters + fascia along both eaves
    const eaveY = h - 0.28 * (rise / (wid / 2)) - 0.05;
    setPaint(pnt, 0x15171a, 0.6, 0.45);
    for (const s of [-1, 1]) {
      const o = s * (wid / 2 + 0.3);
      if (alongX) pnt.box(0, eaveY, o, L + 0.2, 0.1, 0.12);
      else pnt.box(o, eaveY, 0, 0.12, 0.1, L + 0.2);
    }
  }
  if (ctx.geo >= 1) {
    // chimney stacks on the party walls
    const ridgeY = h + rise;
    for (let i = 0; i <= nHouse; i++) {
      if (i !== 0 && i !== nHouse && rng() < 0.35) continue;
      const a = u0 + houseW * i + (i === 0 ? 0.6 : i === nHouse ? -0.6 : 0);
      const cx = alongX ? a : 0;
      const cz = alongX ? 0 : a;
      chimney(ctx, spec, cx, cz, ridgeY - 0.8, 2.0 + rng() * 0.5, alongX, 2 + Math.floor(rng() * 2));
    }
  }

  // --- facades: windows, doors, steps, bays, shopfront
  const winW = 1.05;
  const winH = 1.55;
  const sill = 0.9;
  const litP = isPub ? 1.0 : 0.38;
  for (let hi = 0; hi < nHouse; hi++) {
    const hc = u0 + houseW * hi;
    const uL = hc + houseW * 0.25;
    const uR = hc + houseW * 0.75;
    const shopHere = shopHouses.has(hi);
    const doorLeft = hi % 2 === 0;
    const doorU = doorLeft ? uL : uR;
    const winU = doorLeft ? uR : uL;
    // upper floors (front)
    for (let fl = 1; fl < floors; fl++) {
      for (const u of [uL, uR]) {
        addWin(ctx, spec, front, u, fl * fh + sill, winW, winH, { kind: 0, lit: litP, warm: 0.92, roomW: bayW, floorBase: fl * fh });
        addSillLintel(ctx, spec, front, u, fl * fh + sill, winW, winH);
      }
    }
    if (!shopHere) {
      // ground floor window / bay window + door
      const hasBay = ctx.geo >= 2 && !isShop && rng() < 0.45;
      if (hasBay) {
        const bw = 2.2;
        const bh = 2.4;
        const bp = facePos(spec, front, winU, bh / 2 + 0.1, 0.0);
        const dir = FACE_N[front];
        const proud = 0.55;
        // brick bay box
        const horiz = front < 2;
        const cx = bp[0] + dir[0] * proud / 2;
        const cz = bp[2] + dir[2] * proud / 2;
        bk.setAttrs([tint[0], tint[1], tint[2], soot], [99, 0, 0, 0], [fh, h, seed, 0]);
        bk.box(cx, bh / 2 + 0.1, cz, horiz ? bw : proud, bh, horiz ? proud : bw, FACE.NY | FACE.PY);
        setPaint(pnt, 0x6d685e, 0, 0.8);
        pnt.box(cx, bh + 0.17, cz, horiz ? bw + 0.2 : proud + 0.2, 0.14, horiz ? proud + 0.2 : bw + 0.2);
        addWin(ctx, spec, front, winU, 0.9, 1.5, 1.35, { kind: 0, lit: litP, warm: 0.92, roomW: 1.9, floorBase: 0, out: proud + 0.01, depth: 3.4 });
      } else {
        addWin(ctx, spec, front, winU, sill, winW, winH, { kind: 0, lit: litP, warm: 0.92, roomW: bayW, floorBase: 0 });
        addSillLintel(ctx, spec, front, winU, sill, winW, winH);
      }
      // door (coloured, recessed look via fanlight), step
      const dc = DOOR_COLOURS[Math.floor(rng() * DOOR_COLOURS.length)];
      const dp = facePos(spec, front, doorU, 1.05, 0.04);
      setPaint(pnt, dc, 0, 0.35);
      if (front < 2) pnt.box(dp[0], dp[1], dp[2], 1.0, 2.1, 0.08);
      else pnt.box(dp[0], dp[1], dp[2], 0.08, 2.1, 1.0);
      addWin(ctx, spec, front, doorU, 2.2, 0.9, 0.45, { kind: 0, lit: 0.55, warm: 0.7, roomW: bayW, floorBase: 0, out: 0.06, depth: 2.2 });
      addSillLintel(ctx, spec, front, doorU, 2.05, 1.0, 0.45);
      if (ctx.geo >= 1) {
        setPaint(pnt, 0x77736a, 0, 0.9);
        const sp = facePos(spec, front, doorU, 0.09, 0.3);
        if (front < 2) pnt.box(sp[0], sp[1], sp[2], 1.25, 0.18, 0.6);
        else pnt.box(sp[0], sp[1], sp[2], 0.6, 0.18, 1.25);
      }
    }
    // back: windows everywhere, one per bay per floor
    for (let fl = 0; fl < floors; fl++) {
      for (const u of [uL, uR]) {
        addWin(ctx, spec, back, u, fl * fh + sill, winW, winH, { kind: 0, lit: litP * 0.8, warm: 0.9, roomW: bayW, floorBase: fl * fh });
      }
    }
  }

  // --- shopfront
  if (isShop && shopHouses.size > 0) {
    const idxs = [...shopHouses].sort((a, b2) => a - b2);
    const su0 = u0 + houseW * idxs[0];
    const su1 = u0 + houseW * (idxs[idxs.length - 1] + 1);
    const sw = su1 - su0;
    const sc = (su0 + su1) / 2;
    const pubGreen = 0x14301f;
    const trim = isPub ? pubGreen : [0x1d3a5a, 0x6a1620, 0x1b4a3a, 0x2a2a30, 0x5a3a14][Math.floor(rng() * 5)];
    const shopName: SignName = isPub ? 'pub' : SHOP_NAMES[Math.floor(rng() * SHOP_NAMES.length)];
    const neon = shopName === 'kebab' || shopName === 'takeaway';
    // fascia board + sign
    const signH = 0.85;
    const signW = isPub ? Math.min(sw - 1.0, signH * 4.0 * 1.25) : Math.min(sw - 1.4, signH * 4.0);
    const fy = 2.6;
    const dir = FACE_N[front];
    const horiz = front < 2;
    setPaint(pnt, trim, 0.1, 0.4);
    const fp0 = facePos(spec, front, sc, fy + signH / 2 + 0.05, 0.14);
    if (horiz) pnt.box(fp0[0], fp0[1], fp0[2], sw - 0.1, signH + 0.3, 0.28);
    else pnt.box(fp0[0], fp0[1], fp0[2], 0.28, signH + 0.3, sw - 0.1);
    const sg = ctx.b.signs;
    sg.setFrame(spec.x, spec.z, spec.yaw);
    sg.setAttrs(undefined, [neon ? 5 : isPub ? 2.6 : 3.2, neon && rng() < 0.6 ? 1 : 0, rng(), 0]);
    sg.plane(facePos(spec, front, sc, fy + signH / 2 + 0.05, 0.285), FACE_R[front], [0, 1, 0], signW, signH, ctx.atlas.rect(shopName));
    // pilasters at shopfront ends
    setPaint(pnt, trim, 0.1, 0.4);
    for (const u of [su0 + 0.18, su1 - 0.18]) {
      const pp = facePos(spec, front, u, 1.4, 0.1);
      if (horiz) pnt.box(pp[0], pp[1], pp[2], 0.36, 2.8, 0.2);
      else pnt.box(pp[0], pp[1], pp[2], 0.2, 2.8, 0.36);
    }
    // windows (stallriser = brick below), door on the road-side end
    const nW = Math.max(1, Math.floor((sw - 1.8) / 2.6));
    const doorU = shopEndLow ? su1 - 1.1 : su0 + 1.1;
    const glassLo = shopEndLow ? su0 + 0.5 : su0 + 2.0;
    const glassHi = shopEndLow ? su1 - 2.0 : su1 - 0.5;
    const gw = (glassHi - glassLo) / nW;
    for (let i = 0; i < nW; i++) {
      const gu = glassLo + gw * (i + 0.5);
      addWin(ctx, spec, front, gu, 0.65, gw - 0.2, 1.8, { kind: isPub ? 3 : 2, lit: 1, warm: isPub ? 1 : 0.55, roomW: gw, floorBase: 0, depth: 4.5 });
    }
    // door
    setPaint(pnt, trim, 0.1, 0.4);
    const dp = facePos(spec, front, doorU, 1.05, 0.05);
    if (horiz) pnt.box(dp[0], dp[1], dp[2], 1.1, 2.1, 0.1);
    else pnt.box(dp[0], dp[1], dp[2], 0.1, 2.1, 1.1);
    addWin(ctx, spec, front, doorU, 0.35, 0.8, 1.7, { kind: 2, lit: 1, warm: 0.8, roomW: 1.1, floorBase: 0, out: 0.11, depth: 3.5 });
    // light spill on the pavement
    const wp = ctx.b.brick.toWorld(...(horiz ? [sc, dir[2] * (spec.depth / 2 + 2.5)] : [dir[0] * (spec.width / 2 + 2.5), sc]) as [number, number]);
    ctx.spills.push({ x: wp[0], z: wp[1], color: isPub ? [0.9, 0.5, 0.2] : neon ? [0.6, 0.3, 0.6] : [0.7, 0.55, 0.35], weight: 0.55, radius: 7 });

    // projecting blade sign (pub: hanging painted sign)
    if (isPub) {
      const hp = facePos(spec, front, shopEndLow ? su1 - 0.6 : su0 + 0.6, 4.0, 0.9);
      setPaint(pnt, 0x0f0f10, 0.5, 0.4);
      const bp = facePos(spec, front, shopEndLow ? su1 - 0.6 : su0 + 0.6, 4.3, 0.55);
      if (horiz) pnt.box(bp[0], bp[1], bp[2], 0.05, 0.05, 1.1);
      else pnt.box(bp[0], bp[1], bp[2], 1.1, 0.05, 0.05);
      const board = ctx.b.signs;
      board.setAttrs(undefined, [2.4, 0, 0.3, 0]);
      // two faces, perpendicular to the wall
      const right: V3 = horiz ? [1, 0, 0] : [0, 0, 1];
      const nrm: V3 = horiz ? [1, 0, 0] : [0, 0, 1];
      void nrm;
      const rect = ctx.atlas.rect('pubHang');
      board.plane([hp[0] + (horiz ? 0.03 : 0), hp[1], hp[2] + (horiz ? 0 : 0.03)], right, [0, 1, 0], 0.9, 0.9, rect);
      board.plane([hp[0] - (horiz ? 0.03 : 0), hp[1], hp[2] - (horiz ? 0 : 0.03)], [-right[0], 0, -right[2]], [0, 1, 0], 0.9, 0.9, rect);
      // wall lanterns
      setPaint(pnt, 0x222222, 0.5, 0.5, 0xffc070, 4.0);
      for (const u of [su0 + 0.7, su1 - 0.7]) {
        const lp = facePos(spec, front, u, 2.4, 0.25);
        pnt.box(lp[0], lp[1], lp[2], 0.18, 0.28, 0.18);
      }
    }
    // side face (towards the cross street): shop windows + upper windows
    const side: Face = (alongX ? (shopEndLow ? 3 : 2) : (shopEndLow ? 1 : 0)) as Face;
    const sideLen = alongX ? d : w;
    const su = -sideLen / 2;
    const nS = Math.max(1, Math.floor((sideLen - 2) / 2.8));
    const sw2 = (sideLen - 2.4) / nS;
    for (let i = 0; i < nS; i++) {
      const u = su + 1.2 + sw2 * (i + 0.5);
      addWin(ctx, spec, side, u, 0.65, sw2 - 0.3, 1.8, { kind: isPub ? 3 : 2, lit: 1, warm: 0.6, roomW: sw2, floorBase: 0, depth: 4.0 });
      for (let fl = 1; fl < floors; fl++) {
        addWin(ctx, spec, side, u, fl * fh + sill, winW, winH, { kind: 0, lit: 0.45, warm: 0.9, roomW: sw2, floorBase: fl * fh });
        addSillLintel(ctx, spec, side, u, fl * fh + sill, winW, winH);
      }
    }
  }
  bk.clearFrame();
}

// ------------------------------------------------------------------ tower blocks (1960s concrete)

function aerial(ctx: BuildCtx, x: number, y: number, z: number, hgt: number): void {
  const p = ctx.b.paint;
  setPaint(p, 0x555a60, 0.7, 0.4);
  p.cylinder(x, y, z, 0.04, 0.03, hgt, 5, true);
  p.box(x, y + hgt * 0.7, z, 1.1, 0.03, 0.03);
  p.box(x, y + hgt * 0.85, z, 0.8, 0.03, 0.03);
  p.box(x, y + hgt * 0.55, z, 0.03, 0.03, 1.3);
}

function buildTower(spec: BuildingSpec, ctx: BuildCtx): void {
  const { width: w, depth: d, floors, floorHeight: fh, height: h } = spec;
  const cb = ctx.b.concrete;
  const seed = (spec.id * 0.6180339 + 0.31) % 1;
  const tintV = spec.material === 'concrete1' ? 1.06 : 1.0;
  const margin = 1.7;
  cb.setFrame(spec.x, spec.z, spec.yaw);
  const faceBay: number[] = [];
  for (const f of [0, 1, 2, 3] as Face[]) {
    const L = faceInfo(spec, f).len;
    const n = Math.max(2, Math.round((L - 2 * margin) / 3.4));
    const bayW = (L - 2 * margin) / n;
    faceBay[f] = bayW;
    cb.setAttrs([tintV, tintV, tintV * 0.98, 0.4], [bayW, -L / 2 + margin, 0, 0], [fh, h, seed, 0]);
    wallFace(cb, spec, f, 0, h);
  }
  // windows: one wide pane per bay per floor; every face; balconies on two faces
  const front = frontFace(spec, ctx.layout);
  for (const f of [0, 1, 2, 3] as Face[]) {
    const L = faceInfo(spec, f).len;
    const bayW = faceBay[f];
    const n = Math.round((L - 2 * margin) / bayW);
    const u0 = -L / 2 + margin;
    for (let fl = 0; fl < floors; fl++) {
      for (let i = 0; i < n; i++) {
        const u = u0 + bayW * (i + 0.5);
        addWin(ctx, spec, f, u, fl * fh + 0.95, Math.min(2.3, bayW - 0.9), 1.3, {
          kind: 1, lit: 0.42, warm: 0.72, roomW: bayW, floorBase: fl * fh, depth: 3.6,
        });
      }
    }
    // lit stairwell strip: a narrow cool window on every landing near a corner (front face and one side)
    if (f === front || f === 2) {
      for (let fl = 0; fl < floors; fl++) {
        const half = fl % 2 === 0;
        addWin(ctx, spec, f, -L / 2 + 0.85, fl * fh + (half ? 0.4 : 1.1), 0.5, 1.6, { kind: 1, lit: 0.92, warm: 0.0, roomW: 1.0, floorBase: fl * fh, depth: 2.2 });
      }
    }
  }
  const pnt = ctx.b.paint;
  if (ctx.geo >= 1) {
    // balcony decks with railings on the front and back faces
    for (const f of [front, (front ^ 1) as Face]) {
      const L = faceInfo(spec, f).len;
      const len = L - 2 * margin + 0.6;
      for (let fl = 1; fl < floors; fl++) {
        const c = facePos(spec, f, 0, fl * fh + 0.08, 0.5);
        const horiz = f < 2;
        setPaint(pnt, 0x7c7a74, 0, 0.9);
        if (horiz) pnt.box(c[0], c[1], c[2], len, 0.16, 1.0); else pnt.box(c[0], c[1], c[2], 1.0, 0.16, len);
        if (ctx.geo >= 2) {
          setPaint(pnt, 0x2a2e33, 0.5, 0.5);
          const rc = facePos(spec, f, 0, fl * fh + 0.62, 0.98);
          if (horiz) pnt.box(rc[0], rc[1], rc[2], len, 0.9, 0.04); else pnt.box(rc[0], rc[1], rc[2], 0.04, 0.9, len);
        }
      }
    }
    // entrance canopy + lit lobby
    const ec = facePos(spec, front, 0, 3.0, 1.2);
    setPaint(pnt, 0x6a6a66, 0, 0.9);
    if (front < 2) pnt.box(ec[0], ec[1], ec[2], 6.0, 0.25, 2.4); else pnt.box(ec[0], ec[1], ec[2], 2.4, 0.25, 6.0);
    addWin(ctx, spec, front, 0, 0.1, 3.6, 2.5, { kind: 2, lit: 1, warm: 0.0, roomW: 4.0, floorBase: 0, out: 0.06, depth: 5 });
    // parapet
    setPaint(pnt, 0x65666a, 0, 0.9);
    const t = 0.25;
    pnt.box(0, h + 0.5, d / 2 - t / 2, w, 1.0, t);
    pnt.box(0, h + 0.5, -d / 2 + t / 2, w, 1.0, t);
    pnt.box(w / 2 - t / 2, h + 0.5, 0, t, 1.0, d - 2 * t);
    pnt.box(-w / 2 + t / 2, h + 0.5, 0, t, 1.0, d - 2 * t);
  }
  // rooftop plant: lift motor room, water tank, aerials, obstruction light
  cb.setAttrs([0.8, 0.8, 0.8, 0.5], [99, 0, 0, 0], [3.5, 40, seed, 0]);
  cb.box(0, h + 1.75, 0, 7, 3.5, 7, FACE.NY);
  if (ctx.geo >= 1) {
    setPaint(pnt, 0x2f3a2f, 0.3, 0.6);
    pnt.box(3.52, h + 1.2, 0, 0.1, 2.2, 1.6);
    setPaint(pnt, 0x7b7f82, 0.6, 0.5);
    pnt.cylinder(-6.5, h + 0.2, 5.0, 1.3, 1.3, 2.2, 10, true);
    aerial(ctx, 2.0, h + 3.5, 2.0, 5.5);
    aerial(ctx, -2.5, h + 3.5, -1.8, 4.2);
    setPaint(pnt, 0x888d90, 0.6, 0.4);
    pnt.cylinder(8, h + 0.2, -7, 0.9, 0.9, 0.4, 8, true);
    if (ctx.tallestTowerIds.includes(spec.id)) {
      setPaint(pnt, 0x330000, 0, 0.5, 0xff1a10, 7.0);
      pnt.box(2.0, h + 3.5 + 5.6, 2.0, 0.22, 0.22, 0.22);
      pnt.box(-w / 2 + 0.4, h + 1.15, -d / 2 + 0.4, 0.22, 0.22, 0.22);
    }
  }
  cb.clearFrame();
}

// ------------------------------------------------------------------ glass offices

function buildOffice(spec: BuildingSpec, ctx: BuildCtx): void {
  const { width: w, depth: d, floors, floorHeight: fh, height: h } = spec;
  const cw = ctx.b.curtain;
  const seed = (spec.id * 0.6180339 + 0.77) % 1;
  cw.setFrame(spec.x, spec.z, spec.yaw);
  for (const f of [0, 1, 2, 3] as Face[]) {
    const L = faceInfo(spec, f).len;
    const bayW = L / Math.round(L / 1.5);
    cw.setAttrs([seed, 0.45, fh, bayW], [1.0, 0.07, -L / 2, 0], [0, 0, 0, 0]);
    wallFace(cw, spec, f, 0, h);
  }
  void floors;
  const pnt = ctx.b.paint;
  setPaint(pnt, 0x1d2126, 0.7, 0.4);
  // corner posts + roof band
  const t = 0.45;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) pnt.box(sx * (w / 2 - t / 2 + 0.02), h / 2, sz * (d / 2 - t / 2 + 0.02), t, h + 0.4, t);
  setPaint(pnt, 0x23282d, 0.6, 0.5);
  pnt.box(0, h + 0.35, 0, w + 0.3, 0.7, d + 0.3);
  // plinth band at the base
  pnt.box(0, 0.4, 0, w + 0.2, 0.8, d + 0.2);
  // plant room + cooling units + mast
  setPaint(pnt, 0x4a5056, 0.5, 0.55);
  pnt.box(0, h + 0.7 + 1.5, 0, w * 0.45, 3, d * 0.45);
  if (ctx.geo >= 1) {
    setPaint(pnt, 0x2a2e33, 0.7, 0.4);
    for (let i = 0; i < 4; i++) {
      const px = (i % 2 === 0 ? -1 : 1) * w * 0.3;
      const pz = (i < 2 ? -1 : 1) * d * 0.33;
      pnt.cylinder(px, h + 0.7, pz, 1.1, 1.1, 1.0, 10, true);
      setPaint(pnt, 0x111214, 0.5, 0.4);
      pnt.cylinder(px, h + 1.7, pz, 0.9, 0.9, 0.05, 10, true);
      setPaint(pnt, 0x2a2e33, 0.7, 0.4);
    }
    setPaint(pnt, 0x555a60, 0.7, 0.4);
    pnt.cylinder(0, h + 4.2, 0, 0.08, 0.05, 6, 6, true);
    pnt.box(0, h + 8.5, 0, 1.4, 0.04, 0.04);
    // window-cleaning gantry rails
    setPaint(pnt, 0x303438, 0.6, 0.5);
    pnt.box(0, h + 0.9, d / 2 - 1.0, w - 2, 0.12, 0.12);
    if (spec.id === ctx.tallestOfficeId) {
      setPaint(pnt, 0x330000, 0, 0.5, 0xff1a10, 8.0);
      pnt.box(0, h + 10.4, 0, 0.35, 0.35, 0.35);
      pnt.box(0, h + 4.3, 0.12, 0.2, 0.2, 0.2);
    }
  }
  cw.clearFrame();
}

// ------------------------------------------------------------------ town hall

function buildTownHall(spec: BuildingSpec, ctx: BuildCtx): void {
  const { width: w, depth: d, floors, floorHeight: fh, height: h } = spec;
  const ss = ctx.b.sandstone;
  const seed = 0.37;
  ss.setFrame(spec.x, spec.z, spec.yaw);
  const bays = 12;
  const bayW = (w - 2) / bays;
  for (const f of [0, 1, 2, 3] as Face[]) {
    ss.setAttrs([1, 1, 1, 0.55], [bayW, -w / 2 + 1 + bayW / 2, 1.5, 1.0], [fh, h, seed, 0]);
    wallFace(ss, spec, f, 0, h);
  }
  const pnt = ctx.b.paint;
  const front: Face = 0;
  // --- windows: tall sashes in each bay, ground floor shorter
  for (let i = 0; i < bays; i++) {
    const u = -w / 2 + 1 + bayW * (i + 0.5);
    if (Math.abs(u) < 3.2) continue;
    for (let fl = 0; fl < floors; fl++) {
      const sillH = fl * fh + (fl === 0 ? 1.1 : 0.95);
      const wh = fl === 0 ? 2.7 : 3.0;
      addWin(ctx, spec, front, u, sillH, 1.5, wh, { kind: 0, lit: 0.55, warm: 1.0, roomW: bayW, floorBase: fl * fh, depth: 5.5 });
      addSillLintel(ctx, spec, front, u, sillH, 1.5, wh, 0xb3a487);
      addWin(ctx, spec, 1, u, sillH, 1.5, wh, { kind: 0, lit: 0.4, warm: 1.0, roomW: bayW, floorBase: fl * fh, depth: 5.5 });
    }
  }
  for (const f of [2, 3] as Face[]) {
    for (let i = 0; i < 4; i++) {
      const u = -d / 2 + 3 + i * (d - 6) / 3;
      for (let fl = 0; fl < floors; fl++) addWin(ctx, spec, f, u, fl * fh + 1.0, 1.5, 2.9, { kind: 0, lit: 0.4, warm: 1.0, roomW: 4, floorBase: fl * fh, depth: 5 });
    }
  }
  // --- cornice, balustrade, pilasters, plinth
  if (ctx.geo >= 1) {
    ss.setAttrs([1.05, 1.05, 1.05, 0.5], [99, 0, 0, 0], [fh, h, seed, 0]);
    ss.box(0, h - 0.1, 0, w + 1.6, 0.6, d + 1.6, FACE.NY);
    ss.box(0, h + 0.5, 0, w + 0.8, 0.7, d + 0.8);
    ss.box(0, fh - 0.15, d / 2 + 0.1, w + 0.2, 0.3, 0.25);
    ss.box(0, 2 * fh - 0.15, d / 2 + 0.1, w + 0.2, 0.3, 0.25);
  }
  if (ctx.geo >= 2) {
    for (let i = 0; i <= bays; i++) {
      const u = -w / 2 + 1 + bayW * i;
      ss.box(u, h / 2, d / 2 + 0.17, 0.7, h - 0.2, 0.35);
    }
    // portico: columns, entablature, balustraded terrace, steps (kept within the 4.5 m of pavement)
    for (const x of [-6, -3.6, -1.2, 1.2, 3.6, 6]) {
      ss.cylinder(x, 0.0, d / 2 + 1.6, 0.5, 0.42, fh + 0.3, 12, false);
      ss.box(x, 0.15, d / 2 + 1.6, 1.3, 0.3, 1.3);
      ss.box(x, fh + 0.4, d / 2 + 1.6, 1.25, 0.3, 1.25);
    }
    ss.box(0, fh + 0.9, d / 2 + 1.5, 14, 1.0, 3.2);
    ss.box(0, fh + 1.55, d / 2 + 2.95, 14, 0.5, 0.3);
    for (let s = 0; s < 4; s++) ss.boxBase(0, 0, d / 2 + 3.2 + s * 0.35, 16 - s * 0.6, 0.14 * (4 - s), 0.4);
    // central door
    setPaint(pnt, 0x1a0f0a, 0, 0.4);
    pnt.box(0, 2.0, d / 2 + 0.06, 3.4, 4.0, 0.12);
    addWin(ctx, spec, front, 0, 4.1, 3.2, 0.9, { kind: 2, lit: 1, warm: 1, roomW: 4, floorBase: 0, out: 0.1, depth: 6 });
    // gas lamps on the steps
    setPaint(pnt, 0x1a1c1f, 0.6, 0.45);
    for (const x of [-8.4, 8.4]) {
      pnt.cylinder(x, 0, d / 2 + 3.2, 0.12, 0.08, 3.0, 6, true);
      setPaint(pnt, 0x2a1a08, 0.2, 0.5, 0xffb060, 5.0);
      pnt.box(x, 3.2, d / 2 + 3.2, 0.34, 0.42, 0.34);
      setPaint(pnt, 0x1a1c1f, 0.6, 0.45);
    }
  }
  // --- roof: low hipped slate roof
  const sl = ctx.b.slate;
  sl.setAttrs(undefined, undefined, [0, 0, 0.4, 0]);
  sl.pyramid(0, h + 1.0, 0, w - 0.4, d - 0.4, 3.0, w - 16, d - 14);
  setPaint(pnt, 0x15181c, 0.5, 0.45);
  pnt.box(0, h + 4.05, 0, w - 15.8, 0.14, d - 13.8);
  // chimneys on the roof
  if (ctx.geo >= 1) {
    for (const x of [-22, -12, 12, 22]) chimney(ctx, spec, x, 0, h + 1.8, 3.0, true, 3);
  }

  // --- clock tower (tz = d/2 - 6, 10 x 42 x 10) with pyramid cap
  const tz = d / 2 - 6;
  const towerH = 42;
  ss.setAttrs([0.95, 0.95, 0.95, 0.65], [99, 0, 0, 0], [3.2, towerH, 0.52, 0]);
  if (ctx.geo >= 2) {
    // string courses
    for (const y of [16.2, 24, 30.5, 40.8]) ss.box(0, y, tz, 10.7, 0.5, 10.7);
    // corner quoins as slightly proud piers
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) ss.box(sx * 4.75, towerH / 2, tz + sz * 4.75, 1.0, towerH - 0.5, 1.0);
  }
  const tcx = ss.toWorld(0, tz);
  void tcx;
  // tower faces
  for (const f of [0, 1, 2, 3] as Face[]) {
    ss.setAttrs([0.95, 0.95, 0.95, 0.65], [99, 0, 0, 0], [3.2, towerH, 0.52, 0]);
    ss.box(0, h + (towerH - h) / 2 - 0.0, tz, 10, towerH - h + 0.0, 10, 63 & ~FACE_BIT[f]);
  }
  // tall slit windows + belfry openings + clocks on all four sides
  const tf = (f: Face, u: number, y: number, out: number): V3 => {
    const sgn = f === 0 || f === 2 ? 1 : -1;
    switch (f) {
      case 0: case 1: return [u, y, tz + sgn * (5 + out)];
      default: return [sgn * (5 + out), y, tz + u];
    }
  };
  for (const f of [0, 1, 2, 3] as Face[]) {
    const right = FACE_R[f];
    const ctr = tf(f, 0, 35, 0.04);
    const sg = ctx.b.signs;
    sg.setFrame(spec.x, spec.z, spec.yaw);
    sg.setAttrs(undefined, [3.4, 0, 0.1, 0]);
    sg.plane(ctr, right, [0, 1, 0], 4.4, 4.4, ctx.atlas.rect('clock'));
    // surround
    ss.setAttrs([1, 1, 1, 0.5], [99, 0, 0, 0], [3.2, towerH, 0.52, 0]);
    if (f < 2) ss.box(ctr[0], ctr[1], ctr[2] - (f === 0 ? 0.03 : -0.03), 5.0, 5.0, 0.1); else ss.box(ctr[0] - (f === 2 ? 0.03 : -0.03), ctr[1], ctr[2], 0.1, 5.0, 5.0);
    // slit windows (stairs) below the clock
    for (const y of [20, 25.5]) {
      const wp = tf(f, 0, y, 0.0);
      const w2 = ctx.b.windows;
      w2.setAttrs([ctx.rng(), 0, 0.8, 3], [0.6, 2.0, 0.1, 0.5], [2, 0.6, 1, 0]);
      w2.plane([wp[0] + FACE_N[f][0] * 0.03, wp[1], wp[2] + FACE_N[f][2] * 0.03], right, [0, 1, 0], 0.6, 2.0);
    }
    // belfry: two dark louvred arches
    setPaint(pnt, 0x08090b, 0, 0.9);
    for (const u of [-1.8, 1.8]) {
      const bp = tf(f, u, 39.2, 0.04);
      if (f < 2) pnt.box(bp[0], bp[1], bp[2], 1.6, 3.0, 0.08); else pnt.box(bp[0], bp[1], bp[2], 0.08, 3.0, 1.6);
    }
  }
  // cap + pinnacles + flagpole
  sl.setAttrs(undefined, undefined, [0, 0, 0.77, 0]);
  sl.pyramid(0, towerH, tz, 11.0, 11.0, 9.0, 0.0, 0.0);
  ss.setAttrs([1, 1, 1, 0.5], [99, 0, 0, 0], [3.2, towerH, 0.52, 0]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    ss.box(sx * 4.8, towerH + 0.9, tz + sz * 4.8, 0.7, 1.8, 0.7);
    sl.pyramid(sx * 4.8, towerH + 1.8, tz + sz * 4.8, 0.7, 0.7, 1.6);
  }
  setPaint(pnt, 0x90621a, 0.8, 0.4);
  pnt.cylinder(0, towerH + 9, tz, 0.06, 0.04, 3.5, 6, true);
  setPaint(pnt, 0x330000, 0, 0.5, 0xff2a18, 4);
  pnt.box(0, towerH + 12.4, tz, 0.2, 0.2, 0.2);
  ss.clearFrame();
}

// ------------------------------------------------------------------ church

function pointedArch(w: number, h: number): [number, number][] {
  const pts: [number, number][] = [];
  const spring = h - w * 0.75;
  pts.push([0, 0], [w, 0], [w, spring]);
  const r = w; // two-centred arch: centres at the opposite springing points
  const n = 6;
  for (let i = 1; i <= n; i++) {
    const a = (i / n) * Math.acos((r - w / 2) / r);
    pts.push([w - (r - r * Math.cos(a)), spring + r * Math.sin(a)]);
  }
  for (let i = n - 1; i >= 1; i--) {
    const a = (i / n) * Math.acos((r - w / 2) / r);
    pts.push([r - r * Math.cos(a), spring + r * Math.sin(a)]);
  }
  pts.push([0, spring]);
  return pts;
}

function buildChurch(spec: BuildingSpec, ctx: BuildCtx): void {
  const { width: w, depth: d, height: h } = spec;
  const st = ctx.b.sootStone;
  const seed = 0.62;
  st.setFrame(spec.x, spec.z, spec.yaw);
  // nave
  for (const f of [0, 1, 2, 3] as Face[]) {
    st.setAttrs([1, 1, 1, 0.75], [99, 0, 0, 0], [5, h, seed, 0]);
    wallFace(st, spec, f, 0, h);
  }
  slateRoof(ctx, spec, h, 4.5, false, 0.35);
  const win = ctx.b.windows;
  win.setFrame(spec.x, spec.z, spec.yaw);
  const pnt = ctx.b.paint;
  // buttresses + tall pointed stained-glass windows on the long sides
  const bayN = 6;
  const bayL = (d - 9) / bayN;
  const z0 = -d / 2 + 9 + bayL / 2; // south of the tower
  for (const side of [-1, 1]) {
    const f: Face = side > 0 ? 2 : 3;
    for (let i = 0; i <= bayN; i++) {
      const bz = -d / 2 + 9 + bayL * i;
      if (ctx.geo >= 1) {
        st.setAttrs([1, 1, 1, 0.75], [99, 0, 0, 0], [5, h, seed, 0]);
        st.box(side * (w / 2 + 0.4), 3.4, bz, 0.8, 6.8, 0.9);
        st.box(side * (w / 2 + 0.28), 7.6, bz, 0.56, 3.0, 0.62);
        st.box(side * (w / 2 + 0.25), 9.2, bz, 0.5, 0.3, 0.7);
      }
    }
    for (let i = 0; i < bayN; i++) {
      const zc = z0 + bayL * i;
      const ww = 1.5, wh = 5.6;
      const sgn = side;
      const origin: V3 = [sgn * (w / 2 + 0.03), 1.6, zc + (sgn > 0 ? ww / 2 : -ww / 2)];
      const right = FACE_R[f];
      win.setAttrs([ctx.rng(), 4, 2, 6], [ww, wh, 0, 0], [3, 1, 1, 0]);
      win.convexPoly(origin, right, [0, 1, 0], pointedArch(ww, wh), ww, wh);
    }
  }
  // west end rose window + door
  {
    const ang: [number, number][] = [];
    const R = 2.2;
    for (let i = 0; i < 28; i++) ang.push([R + Math.cos((i / 28) * Math.PI * 2) * R, R + Math.sin((i / 28) * Math.PI * 2) * R]);
    win.setAttrs([0.3, 4, 2, 6], [R * 2, R * 2, 0, 0], [3, 1, 1, 0]);
    win.convexPoly([-R, 5.6, d / 2 + 0.03], [1, 0, 0], [0, 1, 0], ang, R * 2, R * 2);
    // lancets
    for (const x of [-2.6, 2.6]) {
      win.setAttrs([ctx.rng(), 4, 2, 6], [1.0, 4.2, 0, 0], [3, 1, 1, 0]);
      win.convexPoly([x - 0.5, 1.2, d / 2 + 0.03], [1, 0, 0], [0, 1, 0], pointedArch(1.0, 4.2), 1.0, 4.2);
    }
    setPaint(pnt, 0x20140c, 0, 0.5);
    pnt.box(0, 1.6, d / 2 + 0.06, 1.8, 3.2, 0.1);
    setPaint(pnt, 0x2a1a08, 0.2, 0.5, 0xffb060, 4);
    for (const x of [-1.3, 1.3]) pnt.box(x, 2.8, d / 2 + 0.2, 0.2, 0.3, 0.2);
    ctx.spills.push({ x: spec.x, z: spec.z + d / 2 + 2, color: [0.5, 0.35, 0.2], weight: 0.4, radius: 6 });
  }
  // --- tower
  const tz = -d / 2 + 4.5;
  const towerH = 26;
  for (const f of [0, 1, 2, 3] as Face[]) {
    st.setAttrs([0.95, 0.95, 0.95, 0.8], [99, 0, 0, 0], [5, towerH, seed, 0]);
    st.box(0, towerH / 2, tz, 9, towerH, 9, 63 & ~FACE_BIT[f]);
  }
  if (ctx.geo >= 1) {
    st.setAttrs([1, 1, 1, 0.7], [99, 0, 0, 0], [5, towerH, seed, 0]);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) st.box(sx * 4.6, 8, tz + sz * 4.6, 0.9, 16, 0.9);
    for (const y of [10, 17, 24.5]) st.box(0, y, tz, 9.5, 0.4, 9.5);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      st.box(sx * 4.2, towerH + 1.0, tz + sz * 4.2, 0.6, 2.0, 0.6);
      ctx.b.slate.setAttrs(undefined, undefined, [0, 0, 0.3, 0]);
      ctx.b.slate.pyramid(sx * 4.2, towerH + 2.0, tz + sz * 4.2, 0.6, 0.6, 1.6);
    }
  }
  // belfry louvres (tall pointed, dark) + clock
  const tfc = (f: Face, u: number, y: number, out: number): V3 => {
    switch (f) {
      case 0: return [u, y, tz + 4.5 + out];
      case 1: return [u, y, tz - 4.5 - out];
      case 2: return [4.5 + out, y, tz + u];
      default: return [-4.5 - out, y, tz + u];
    }
  };
  for (const f of [0, 1, 2, 3] as Face[]) {
    setPaint(pnt, 0x0a0a0c, 0, 0.9);
    for (const u of [-1.5, 1.5]) {
      const p = tfc(f, u, 21.3, 0.03);
      const right = FACE_R[f];
      const o: V3 = [p[0] - right[0] * 0.55, p[1], p[2] - right[2] * 0.55];
      pnt.convexPoly(o, right, [0, 1, 0], pointedArch(1.1, 3.4), 1.1, 3.4);
    }
    const lp = tfc(f, 0, 14, 0.0);
    win.setAttrs([ctx.rng(), 4, 2, 6], [0.8, 2.4, 0, 0], [3, 1, 1, 0]);
    const right = FACE_R[f];
    win.convexPoly([lp[0] - right[0] * 0.4 + FACE_N[f][0] * 0.03, lp[1], lp[2] - right[2] * 0.4 + FACE_N[f][2] * 0.03], right, [0, 1, 0], pointedArch(0.8, 2.4), 0.8, 2.4);
  }
  // spire (slender pyramid)
  const spireH = 18;
  st.setAttrs([0.8, 0.82, 0.85, 0.7], [99, 0, 0, 0], [5, 60, seed, 0]);
  const sp = ctx.b.slate;
  sp.setAttrs(undefined, undefined, [0, 0, 0.9, 0]);
  sp.pyramid(0, towerH, tz, 8.2, 8.2, spireH, 0.0, 0.0);
  setPaint(pnt, 0xa8803a, 0.8, 0.35);
  pnt.cylinder(0, towerH + spireH, tz, 0.07, 0.05, 2.4, 6, true);
  pnt.box(0, towerH + spireH + 1.7, tz, 0.9, 0.08, 0.08);
  pnt.box(0, towerH + spireH + 1.45, tz, 0.08, 0.08, 0.9);
  st.clearFrame();
  win.clearFrame();
}

// ------------------------------------------------------------------ multi-storey car park

function buildCarPark(spec: BuildingSpec, ctx: BuildCtx): void {
  const { width: w, depth: d, floors, floorHeight: fh, height: h } = spec;
  const cc = ctx.b.concrete;
  const pnt = ctx.b.paint;
  const seed = 0.58;
  cc.setFrame(spec.x, spec.z, spec.yaw);
  const attrs = (): unknown => cc.setAttrs([0.8, 0.8, 0.8, 0.7], [6, -w / 2, 0, 0], [fh, h, seed, 0]);
  attrs();
  const slabT = 0.3;
  const parH = 1.05;
  // slabs and parapet bands per level (open between them)
  for (let fl = 0; fl <= floors; fl++) {
    const y = fl * fh;
    if (fl > 0) cc.box(0, y - slabT / 2, 0, w, slabT, d);
    else cc.box(0, 0.05, 0, w, 0.1, d);
    if (fl < floors) {
      const t = 0.3;
      cc.box(0, y + parH / 2, d / 2 - t / 2, w, parH, t);
      cc.box(0, y + parH / 2, -d / 2 + t / 2, w, parH, t);
      cc.box(w / 2 - t / 2, y + parH / 2, 0, t, parH, d - 2 * t);
      cc.box(-w / 2 + t / 2, y + parH / 2, 0, t, parH, d - 2 * t);
    }
  }
  // columns every 7.5 m
  const nx = Math.round(w / 7.5), nz = Math.round(d / 7.2);
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      const x = -w / 2 + 0.3 + (i * (w - 0.6)) / nx;
      const z = -d / 2 + 0.3 + (j * (d - 0.6)) / nz;
      cc.box(x, h / 2, z, 0.6, h, 0.6, FACE.NY);
    }
  }
  // roof parapet
  cc.box(0, h + 0.5, d / 2 - 0.15, w, 1.0, 0.3);
  cc.box(0, h + 0.5, -d / 2 + 0.15, w, 1.0, 0.3);
  cc.box(w / 2 - 0.15, h + 0.5, 0, 0.3, 1.0, d - 0.6);
  cc.box(-w / 2 + 0.15, h + 0.5, 0, 0.3, 1.0, d - 0.6);
  // stair core (matches the collider block)
  cc.setAttrs([0.9, 0.9, 0.9, 0.6], [6, 0, 0, 0], [3.5, 40, seed, 0]);
  cc.box(-w / 2 + 5, h + 1.75, -d / 2 + 5, 7, 3.5, 7, FACE.NY);
  // interior: sodium strip lights under each slab, a few lit, yellow painted edge band on the parapet
  if (ctx.geo >= 1) {
    for (let fl = 0; fl < floors; fl++) {
      const y = (fl + 1) * fh - slabT - 0.08;
      setPaint(pnt, 0x222222, 0, 0.5, 0xffa040, 4.5);
      const rows = Math.max(2, nz);
      for (let j = 0; j < rows; j++) {
        const z = -d / 2 + 3 + (j * (d - 6)) / (rows - 1);
        for (let i = 0; i < 4; i++) {
          if (((i * 7 + j * 3 + fl * 5) % 5) === 0) continue;
          const x = -w / 2 + 6 + (i * (w - 12)) / 3;
          pnt.box(x, y, z, 1.8, 0.08, 0.25);
        }
      }
    }
    // coloured level markers + signage
    setPaint(pnt, 0xe0b020, 0, 0.5);
    for (let fl = 1; fl < floors; fl++) pnt.box(0, fl * fh + parH + 0.0, d / 2 + 0.01, w * 0.98, 0.04, 0.04);
    // lit CAR PARK sign above the entrance
    const sg = ctx.b.signs;
    sg.setFrame(spec.x, spec.z, spec.yaw);
    sg.setAttrs(undefined, [3.0, 0, 0.2, 0]);
    sg.plane([-w / 2 + 12, h - 1.4, d / 2 + 0.05], [1, 0, 0], [0, 1, 0], 6, 1.5, ctx.atlas.rect('carPark'));
  }
  // parked-car hints on the deck edge: dim tail-lights
  if (ctx.geo >= 2) {
    setPaint(pnt, 0x300000, 0, 0.5, 0xff1010, 2.5);
    for (let fl = 0; fl < floors; fl++) {
      for (let i = 0; i < 5; i++) {
        const x = -w / 2 + 4 + ((i * 13 + fl * 7) % 11) * (w - 8) / 11;
        const z = d / 2 - 1.2;
        pnt.box(x, fl * fh + 0.7, z, 0.25, 0.1, 0.05);
        pnt.box(x + 1.3, fl * fh + 0.7, z, 0.25, 0.1, 0.05);
      }
    }
  }
  cc.clearFrame();
}

// ------------------------------------------------------------------ gasholder + substation

function buildGasholder(spec: BuildingSpec, ctx: BuildCtx): void {
  const r = spec.width / 2;
  const h = spec.height;
  const rs = ctx.b.rust;
  const pnt = ctx.b.paint;
  const seed = 0.44;
  rs.setFrame(spec.x, spec.z, 0);
  // drum (the telescoped bell) a little inside the guide frame, with a visible lift line
  rs.setAttrs([0, 0, 0, 0.05], [0, 0, 0, 0], [0, 0, seed, 0]);
  rs.cylinder(0, 0, 0, r - 0.4, r - 0.4, h * 0.82, 28, false);
  rs.setAttrs([0, 0, 0, 0.1], [0, 0, 0, 0], [0, 0, seed + 0.2, 0]);
  rs.cylinder(0, h * 0.82, 0, r - 0.55, r - 1.4, 1.4, 28, true);
  // guide frame: columns + rings + diagonal bracing
  const nCol = 16;
  setPaint(pnt, 0x3a4a44, 0.6, 0.6);
  pnt.setFrame(spec.x, spec.z, 0);
  const levels = [0, h * 0.25, h * 0.5, h * 0.75, h];
  for (let i = 0; i < nCol; i++) {
    const a = (i / nCol) * Math.PI * 2;
    const x = Math.cos(a) * (r + 0.25), z = Math.sin(a) * (r + 0.25);
    pnt.box(x, h / 2, z, 0.7, h + 0.4, 0.7);
  }
  if (ctx.geo >= 1) {
    for (const y of levels) {
      for (let i = 0; i < nCol; i++) {
        const a0 = (i / nCol) * Math.PI * 2, a1 = ((i + 1) / nCol) * Math.PI * 2;
        const x0 = Math.cos(a0) * (r + 0.25), z0 = Math.sin(a0) * (r + 0.25);
        const x1 = Math.cos(a1) * (r + 0.25), z1 = Math.sin(a1) * (r + 0.25);
        const len = Math.hypot(x1 - x0, z1 - z0);
        const yaw = Math.atan2(-(z1 - z0), x1 - x0);
        pnt.boxRot((x0 + x1) / 2, y + 0.1, (z0 + z1) / 2, len, 0.5, 0.4, yaw);
      }
    }
  }
  if (ctx.geo >= 2) {
    for (let k = 0; k < levels.length - 1; k++) {
      const y0 = levels[k], y1 = levels[k + 1];
      for (let i = 0; i < nCol; i++) {
        const a0 = (i / nCol) * Math.PI * 2, a1 = ((i + 1) / nCol) * Math.PI * 2;
        const x0 = Math.cos(a0) * (r + 0.25), z0 = Math.sin(a0) * (r + 0.25);
        const x1 = Math.cos(a1) * (r + 0.25), z1 = Math.sin(a1) * (r + 0.25);
        const len = Math.hypot(x1 - x0, z1 - z0);
        const dyy = y1 - y0;
        const diag = Math.hypot(len, dyy);
        const yaw = Math.atan2(-(z1 - z0), x1 - x0);
        const tilt = Math.atan2(dyy, len) * (i % 2 === 0 ? 1 : -1);
        pnt.boxRot((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, diag, 0.18, 0.18, yaw, tilt);
      }
    }
    // ladder + warning light on the top ring
    setPaint(pnt, 0x330000, 0, 0.5, 0xff2a18, 5);
    pnt.box(r + 0.3, h + 0.5, 0, 0.25, 0.25, 0.25);
  }
  rs.clearFrame();
  pnt.clearFrame();
}

function buildSubstation(spec: BuildingSpec, ctx: BuildCtx): void {
  const { width: w, depth: d, height: h } = spec;
  const cc = ctx.b.concrete;
  const pnt = ctx.b.paint;
  cc.setFrame(spec.x, spec.z, spec.yaw);
  const seed = (spec.id * 0.6180339) % 1;
  for (const f of [0, 1, 2, 3] as Face[]) {
    cc.setAttrs([0.7, 0.72, 0.74, 0.55], [2.5, -faceInfo(spec, f).len / 2, 0, 0], [3, h, seed, 0]);
    wallFace(cc, spec, f, 0, h);
  }
  cc.setAttrs([0.5, 0.5, 0.52, 0.4], [99, 0, 0, 0], [3, h, seed, 0]);
  cc.box(0, h + 0.2, 0, w + 0.6, 0.4, d + 0.6);
  pnt.setFrame(spec.x, spec.z, spec.yaw);
  // roller door, vents, hazard light
  setPaint(pnt, 0x1d3a26, 0.4, 0.5);
  pnt.box(0, 1.6, d / 2 + 0.05, 3.2, 3.2, 0.1);
  setPaint(pnt, 0x111418, 0.6, 0.5);
  for (const x of [-w / 2 + 1.8, w / 2 - 1.8]) pnt.box(x, 3.6, d / 2 + 0.05, 1.4, 1.2, 0.1);
  setPaint(pnt, 0x401000, 0, 0.5, 0xff7a20, 5);
  pnt.box(0, 3.6, d / 2 + 0.2, 0.3, 0.2, 0.2);
  setPaint(pnt, 0xe8c020, 0, 0.5);
  pnt.box(w / 2 - 0.3, 1.5, d / 2 + 0.03, 0.5, 0.5, 0.04);
  if (ctx.geo >= 1) {
    // yard: transformer with cooling fins, insulators
    setPaint(pnt, 0x4a5258, 0.6, 0.5);
    pnt.box(w / 2 + 3.0, 1.6, 0, 3.2, 2.4, 2.4);
    for (let i = -4; i <= 4; i++) pnt.box(w / 2 + 3.0 + 1.7, 1.5, i * 0.25, 0.1, 1.8, 0.12);
    setPaint(pnt, 0x8a8a84, 0.1, 0.4);
    for (const z of [-0.7, 0, 0.7]) pnt.cylinder(w / 2 + 3.0, 2.8, z, 0.12, 0.08, 0.9, 6, true);
    // fenced compound (palisade strips)
    setPaint(pnt, 0x273a2c, 0.5, 0.5);
    pnt.box(w / 2 + 5.0, 1.3, 0, 0.08, 2.6, d + 2);
  }
  cc.clearFrame();
  pnt.clearFrame();
}

// ------------------------------------------------------------------ dispatcher

export function buildBuildingVisual(spec: BuildingSpec, ctx: BuildCtx): void {
  // Every builder shares the spec frame; frame-specific helpers set it themselves where needed.
  const set = (): void => {
    for (const m of Object.values(ctx.b)) (m as MeshBuilder).setFrame(spec.x, spec.z, spec.yaw);
  };
  set();
  switch (spec.type) {
    case 'terrace':
    case 'cornerShop': buildTerrace(spec, ctx); break;
    case 'tower': buildTower(spec, ctx); break;
    case 'office': buildOffice(spec, ctx); break;
    case 'townHall': buildTownHall(spec, ctx); break;
    case 'church': buildChurch(spec, ctx); break;
    case 'carPark': buildCarPark(spec, ctx); break;
    case 'gasholder': buildGasholder(spec, ctx); break;
    case 'substation': buildSubstation(spec, ctx); break;
  }
  for (const m of Object.values(ctx.b)) (m as MeshBuilder).clearFrame();
}

/** Static collider handles per building id, so Phase 2 can remove a building's boxes when it wakes. */
export const buildingColliders = new Map<number, unknown[]>();

/** Colliders: identical to the original blockout (same boxes per spec). */
export function addBuildingColliders(
  spec: BuildingSpec,
  physics: { addStaticBox: (c: THREE.Vector3Like, h: THREE.Vector3Like, yaw?: number) => unknown; world: unknown; RAPIER: unknown },
): void {
  const cs = Math.cos(spec.yaw);
  const sn = Math.sin(spec.yaw);
  const handles: unknown[] = [];
  buildingColliders.set(spec.id, handles);
  const box = (lx: number, baseY: number, lz: number, w: number, h: number, d: number): void => {
    const wx = spec.x + lx * cs + lz * sn;
    const wz = spec.z - lx * sn + lz * cs;
    handles.push(physics.addStaticBox({ x: wx, y: baseY + h / 2, z: wz }, { x: w / 2, y: h / 2, z: d / 2 }, spec.yaw));
  };
  const { width: w, depth: d, height: h } = spec;
  switch (spec.type) {
    case 'terrace':
    case 'cornerShop': {
      box(0, 0, 0, w, h, d);
      const alongX = w >= d;
      box(0, h, 0, alongX ? w + 0.4 : w * 0.7, 2.4, alongX ? d * 0.7 : d + 0.4);
      break;
    }
    case 'tower':
      box(0, 0, 0, w, h, d);
      box(0, h, 0, 7, 3.5, 7);
      break;
    case 'office':
      box(0, 0, 0, w, h, d);
      box(0, h, 0, w * 0.45, 3, d * 0.45);
      break;
    case 'townHall': {
      box(0, 0, 0, w, h, d);
      box(0, h, 0, w + 1, 1.2, d + 1);
      const tz = d / 2 - 6;
      const towerH = 42;
      box(0, 0, tz, 10, towerH, 10);
      const capH = 8;
      const cx = spec.x + tz * sn;
      const cz = spec.z + tz * cs;
      handles.push(physics.addStaticBox({ x: cx, y: towerH + capH / 2 - 1, z: cz }, { x: 2.5, y: capH / 2 - 1, z: 2.5 }, spec.yaw));
      break;
    }
    case 'carPark':
      box(0, 0, 0, w, h, d);
      box(-w / 2 + 5, h, -d / 2 + 5, 7, 3.5, 7);
      break;
    case 'church': {
      box(0, 0, 0, w, h, d);
      box(0, h, 0, w * 0.75, 4.5, d);
      const tz = -d / 2 + 4.5;
      const towerH = 26;
      box(0, 0, tz, 9, towerH, 9);
      const sx = spec.x + tz * sn;
      const sz = spec.z + tz * cs;
      const steps: Array<[number, number, number]> = [[3.2, 26, 6], [2.2, 32, 6], [1.2, 38, 6]];
      for (const [hw, y0, hh] of steps) handles.push(physics.addStaticBox({ x: sx, y: y0 + hh / 2, z: sz }, { x: hw, y: hh / 2, z: hw }, spec.yaw));
      break;
    }
    case 'substation':
      box(0, 0, 0, w, h, d);
      box(0, h, 0, w + 0.6, 0.4, d + 0.6);
      break;
    case 'gasholder':
      break; // cylinder collider is created by the caller (needs the RAPIER world)
  }
}

export type { V4 };
