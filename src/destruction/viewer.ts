// Dev-only destruction viewer. Open
//   /src/destruction/viewer.html?webgl&quality=low[&town]
// It renders a mock grid tower with the real renderer, so the piece materials,
// fracture, hideBuilding and rubble baking can be checked without the
// simulation. Shards are moved by a tiny scripted integrator (gravity, ground
// bounce, settle), not Rapier. `?town` also builds the real merged town and
// puts the mock tower beside it (hideBuilding is then demonstrable on a real
// building through mb.hide(id)).
//
// window.mb: build(), wake(), collapse(), run(seconds), bake(), cam(...), shot(),
// spawnShards(n), stats(), hide(id), town.

import * as THREE from 'three/webgpu';
import { detectQuality, getQualityPreset } from '../core/quality';
import { createRenderer } from '../render/renderer';
import { createPhysics } from '../physics/world';
import { buildTown } from '../city/town-layout';
import { createDestructionRenderer } from './piece-render';
import { fractureBox } from './fracture';
import type { BuildingGraph, DMaterial, PieceDef, PieceKind, RenderHandle, FractureResult } from './types';

function mockTower(floors: number, w: number, d: number, x: number, z: number, yaw: number): BuildingGraph {
  const pieces: PieceDef[] = [];
  const fh = 3.2;
  const slabT = 0.3;
  let seed = 1000;
  const add = (kind: PieceKind, material: DMaterial, c: [number, number, number], h: [number, number, number], floor: number): void => {
    pieces.push({
      index: pieces.length, kind, material, center: c, halfExtents: h, mass: 8 * h[0] * h[1] * h[2] * 2000, maxHealth: 100, floor, seed: (seed += 7919),
    });
  };
  for (let f = 0; f < floors; f++) {
    const y0 = f * fh;
    add('slab', 'concrete', [0, y0 + slabT / 2, 0], [w / 2, slabT / 2, d / 2], f);
    const ch = (fh - slabT) / 2;
    const cy = y0 + slabT + ch;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add('column', 'concrete', [sx * (w / 2 - 0.4), cy, sz * (d / 2 - 0.4)], [0.4, ch, 0.4], f);
    // brick wall bays with a glass pane each: sill / lintel brick, window between
    const bayRow = (len: number, nBays: number, fixedAxis: 'x' | 'z', fixed: number): void => {
      const bw = (len - 1.6) / nBays;
      for (let i = 0; i < nBays; i++) {
        const o = -len / 2 + 0.8 + bw * (i + 0.5);
        const mk = (y: number, hh: number, mat: DMaterial, kind: PieceKind, th: number): void => {
          const c: [number, number, number] = fixedAxis === 'z' ? [o, y, fixed] : [fixed, y, o];
          const he: [number, number, number] = fixedAxis === 'z' ? [bw / 2, hh, th] : [th, hh, bw / 2];
          add(kind, mat, c, he, f);
        };
        const sill = 0.9, win = 1.5, lint = fh - slabT - sill - win;
        mk(y0 + slabT + sill / 2, sill / 2, 'brick', 'wall', 0.2);
        mk(y0 + slabT + sill + win / 2, win / 2, 'glass', 'window', 0.03);
        mk(y0 + slabT + sill + win + lint / 2, lint / 2, 'brick', 'wall', 0.2);
      }
    };
    bayRow(w, 3, 'z', d / 2 - 0.2);
    bayRow(w, 3, 'z', -(d / 2 - 0.2));
    bayRow(d, 2, 'x', w / 2 - 0.2);
    bayRow(d, 2, 'x', -(w / 2 - 0.2));
  }
  add('roof', 'stone', [0, floors * fh + 0.15, 0], [w / 2 + 0.3, 0.15, d / 2 + 0.3], floors);
  return { specId: 9999, x, z, yaw, pieces, bonds: [] };
}

interface Body {
  h: RenderHandle;
  p: THREE.Vector3;
  q: THREE.Quaternion;
  v: THREE.Vector3;
  w: THREE.Vector3;
  r: number;
  rest: boolean;
  shard: boolean;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const quality = getQualityPreset(detectQuality());
  const container = document.getElementById('app')!;
  const [ctx, physics] = await Promise.all([createRenderer(container, quality), createPhysics()]);
  const scene = ctx.scene;
  const withTown = params.has('town');

  let town: ReturnType<typeof buildTown> | null = null;
  let townProxy: { group: THREE.Group; buildingRanges: never[] } = { group: new THREE.Group(), buildingRanges: [] };
  if (withTown) {
    town = buildTown(scene, physics, quality);
    townProxy = town as never;
  } else {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.8 }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    const grid = new THREE.GridHelper(200, 40, 0x667788, 0x2a3038);
    grid.position.y = 0.02;
    scene.add(grid);
    // The town's lamps are missing here: two stand-ins so the pieces are readable.
    for (const [lx, lz, col] of [[-9, 14, 0xffa860], [11, 12, 0xb4c8ff]] as Array<[number, number, number]>) {
      const l = new THREE.PointLight(col, 900, 60, 2);
      l.position.set(lx, 7, lz);
      scene.add(l);
    }
  }
  const R = createDestructionRenderer(scene, townProxy, quality);

  // Mock building placed beside the spawn point (town) or at the origin.
  const bx = withTown ? town!.spawn.x : 0;
  const bz = withTown ? town!.spawn.z + 18 : 0;
  const graph = mockTower(5, 10, 8, bx, bz, 0);

  const rand = ((): (() => number) => {
    let a = 12345;
    return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  })();
  const bodies: Body[] = [];
  const handles: RenderHandle[] = [];
  const pieceHandles = new Map<number, RenderHandle>();
  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), graph.yaw);

  function worldOf(c: [number, number, number], out: THREE.Vector3): THREE.Vector3 {
    return out.set(c[0], c[1], c[2]).applyQuaternion(yawQ).add(tmpV.set(graph.x, 0, graph.z));
  }

  function wake(): void {
    for (const p of graph.pieces) {
      const h = R.addPiece(graph, p);
      pieceHandles.set(p.index, h);
      const pos = worldOf(p.center, new THREE.Vector3());
      R.setTransform(h, pos, yawQ);
    }
  }

  /** Detach a piece: fracture it, replace it with shards flying outward from `from`. */
  function shatter(p: PieceDef, from: THREE.Vector3, speed: number, count: number): number {
    const fr: FractureResult = R.fracture(p, count);
    const h0 = pieceHandles.get(p.index);
    if (h0 !== undefined) R.remove(h0);
    pieceHandles.delete(p.index);
    const base = worldOf(p.center, new THREE.Vector3());
    let n = 0;
    for (let i = 0; i < fr.shards.length; i++) {
      const s = fr.shards[i];
      const h = R.addShard(p, fr, i);
      if (h < 0) continue;
      const local = tmpV.set(s.center[0], s.center[1], s.center[2]).applyQuaternion(yawQ);
      const pos = base.clone().add(local);
      let minHalf = 1e9;
      for (const ax of [0, 1, 2]) {
        let lo = 1e9, hi = -1e9;
        for (let k = ax; k < s.hull.length; k += 3) { lo = Math.min(lo, s.hull[k]); hi = Math.max(hi, s.hull[k]); }
        minHalf = Math.min(minHalf, (hi - lo) / 2);
      }
      const dir = pos.clone().sub(from);
      dir.y = Math.abs(dir.y) * 0.4 + 0.5;
      dir.normalize().multiplyScalar(speed * (0.6 + rand() * 0.8));
      bodies.push({
        h, p: pos, q: yawQ.clone(), v: dir, w: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(8),
        r: Math.max(0.02, minHalf), rest: false, shard: true,
      });
      handles.push(h);
      n++;
    }
    return n;
  }

  /** Shatter every piece of floors >= `fromFloor` (a collapse), shock centre at the building's middle. */
  function collapse(fromFloor: number, speed = 4, countMax = 9): number {
    const centre = new THREE.Vector3(graph.x, 6, graph.z);
    let n = 0;
    for (const p of graph.pieces) {
      if (p.floor < fromFloor) continue;
      const c = p.material === 'glass' ? 8 : p.material === 'brick' ? 7 : countMax;
      n += shatter(p, centre, speed, c);
    }
    return n;
  }

  /** Shatter one piece by kind/floor (for close-ups). */
  function shatterWhere(pred: (p: PieceDef) => boolean, speed = 3, count = 9): number {
    const centre = new THREE.Vector3(graph.x, 3, graph.z);
    let n = 0;
    for (const p of graph.pieces) if (pred(p) && pieceHandles.has(p.index)) n += shatter(p, centre, speed, count);
    return n;
  }

  const G = -9.8;
  function stepBodies(dt: number): void {
    const dq = new THREE.Quaternion();
    for (const b of bodies) {
      if (b.rest) continue;
      b.v.y += G * dt;
      b.p.addScaledVector(b.v, dt);
      const wl = b.w.length();
      if (wl > 1e-4) {
        dq.setFromAxisAngle(tmpV.copy(b.w).divideScalar(wl), wl * dt);
        b.q.premultiply(dq).normalize();
      }
      if (b.p.y - b.r < 0) {
        b.p.y = b.r;
        b.v.y = -b.v.y * 0.28;
        b.v.x *= 0.72;
        b.v.z *= 0.72;
        b.w.multiplyScalar(0.55);
        if (b.v.lengthSq() < 0.15 && b.w.lengthSq() < 0.2) {
          b.rest = true;
          b.v.set(0, 0, 0);
          b.w.set(0, 0, 0);
        }
      }
      R.setTransform(b.h, b.p, b.q);
    }
  }
  function run(seconds: number): void {
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n; i++) stepBodies(1 / 60);
    R.update();
  }

  function bake(): number {
    const rest = bodies.filter((b) => b.rest);
    R.bakeToRubble(rest.map((b) => b.h));
    for (const b of rest) bodies.splice(bodies.indexOf(b), 1);
    R.update();
    return rest.length;
  }

  /** N shards sprayed in a cloud, to count draw calls. */
  function spawnShards(n: number): number {
    const mats: DMaterial[] = ['concrete', 'brick', 'stone', 'glass', 'steel', 'wood'];
    let made = 0;
    for (let i = 0; made < n; i++) {
      const m = mats[i % mats.length];
      const p: PieceDef = {
        index: 90000 + i, kind: m === 'glass' ? 'window' : 'wall', material: m, center: [0, 0, 0],
        halfExtents: m === 'glass' ? [0.7, 0.7, 0.03] : [0.8, 0.5, 0.2], mass: 100, maxHealth: 100, floor: 0, seed: 5000 + i,
      };
      const fr = R.fracture(p, 9);
      for (let k = 0; k < fr.shards.length && made < n; k++) {
        const h = R.addShard(p, fr, k);
        if (h < 0) continue;
        tmpV.set(bx + (rand() - 0.5) * 30, 0.3 + rand() * 6, bz + (rand() - 0.5) * 30);
        tmpQ.set(rand(), rand(), rand(), rand()).normalize();
        R.setTransform(h, tmpV, tmpQ);
        made++;
      }
    }
    R.update();
    return made;
  }

  function cam(cx: number, cy: number, cz: number, tx: number, ty: number, tz: number, fov = 45): void {
    ctx.camera.fov = fov;
    ctx.camera.updateProjectionMatrix();
    ctx.camera.position.set(cx, cy, cz);
    ctx.camera.lookAt(tx, ty, tz);
    ctx.setShadowFocus(tmpV.set(tx, ty, tz));
  }

  function shot(): void {
    R.update();
    ctx.render();
  }

  function onResize(): void {
    ctx.camera.aspect = window.innerWidth / window.innerHeight;
    ctx.camera.updateProjectionMatrix();
  }
  onResize();

  // Default view: the mock tower from the street.
  cam(bx + 18, 9, bz + 26, bx, 8, bz, 50);
  wake();
  ctx.render();
  function loop(): void {
    requestAnimationFrame(loop);
    if (params.has('live')) {
      stepBodies(1 / 60);
      R.update();
      ctx.render();
    }
  }
  loop();

  Object.assign(window, {
    mb: {
      ctx, quality, R, town, graph, bx, bz, wake, collapse, shatterWhere, run, bake, cam, shot, spawnShards,
      hide: (id: number) => R.hideBuilding(id),
      stats: () => ({ ...R.stats(), ...ctx.info(), bodies: bodies.length, resting: bodies.filter((b) => b.rest).length }),
      fractureBench: (n: number) => {
        const t = performance.now();
        for (let i = 0; i < n; i++) fractureBox(1.5, 1.5, 0.15, 'concrete', 'wall', i * 31 + 1, 9);
        return (performance.now() - t) / n;
      },
    },
  });
}

main().catch((e) => console.error(e));
