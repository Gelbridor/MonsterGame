// Headless destruction harness: real createDestruction + real Rapier + the real town specs, null renderer.
// Build + run:  node scripts/run-harness.cjs [t1|t2|t3|t4|all]
import { createPhysics } from '../src/physics/world';
import { layoutTown } from '../src/city/town-layout';
import { addBuildingColliders, buildingColliders } from '../src/city/buildings';
import { getQualityPreset } from '../src/core/quality';
import { config } from '../src/config';
import { createDestruction, type DestructionSystem } from '../src/destruction';
import { createNullRenderer } from '../src/destruction/debug-render';
import { fractureBox } from '../src/destruction/fracture';
import { pieceWorld, type Group } from '../src/destruction/joints';
import type { QualityLevel } from '../src/core/types';
import type { BuildingSpec } from '../src/city/town-layout';

const DT = config.physics.timestep;

async function setup(level: QualityLevel) {
  const physics = await createPhysics();
  const layout = layoutTown(config.world.seed);
  const half = config.world.groundSize / 2;
  physics.addStaticBox({ x: 0, y: -1, z: 0 }, { x: half, y: 1, z: half });
  buildingColliders.clear();
  for (const s of layout.specs) addBuildingColliders(s, physics);
  const quality = getQualityPreset(level);
  const t0 = performance.now();
  const d = createDestruction({ physics, renderer: createNullRenderer(), specs: layout.specs, quality, buildingColliders });
  const initMs = performance.now() - t0;
  return { physics, layout, d, quality, initMs };
}
type Env = Awaited<ReturnType<typeof setup>>;

interface StepTimes { phys: number; sim: number; maxPhys: number; maxSim: number; n: number; physArr: number[]; simArr: number[] }
const median = (a: number[]): number => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a: number[], p: number): number => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
function stepN(env: Env, n: number, tm?: StepTimes): void {
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    env.physics.step();
    const t1 = performance.now();
    env.d.fixedUpdate(DT);
    const t2 = performance.now();
    if (tm) {
      tm.phys += t1 - t0; tm.sim += t2 - t1; tm.n++; tm.physArr.push(t1 - t0); tm.simArr.push(t2 - t1);
      tm.maxPhys = Math.max(tm.maxPhys, t1 - t0); tm.maxSim = Math.max(tm.maxSim, t2 - t1);
    }
  }
}
const newTimes = (): StepTimes => ({ phys: 0, sim: 0, maxPhys: 0, maxSim: 0, n: 0, physArr: [], simArr: [] });

function groupsOf(d: DestructionSystem, specId: number): { fixed: number; dynamic: number } {
  let fixed = 0, dynamic = 0;
  for (const G of d.sim.groups) if (G.bld.specId === specId) (G.fixed ? fixed++ : dynamic++);
  return { fixed, dynamic };
}

const tmp = new Float64Array(3);
function worldOf(d: DestructionSystem, specId: number, i: number): [number, number, number] | null {
  const b = d.sim.buildings.get(specId);
  const G = b?.group[i];
  if (!b || !G || !b.alive[i]) return null;
  pieceWorld(G, i, tmp);
  return [tmp[0], tmp[1], tmp[2]];
}

function localToWorld(spec: BuildingSpec, lx: number, ly: number, lz: number): { x: number; y: number; z: number } {
  const cs = Math.cos(spec.yaw), sn = Math.sin(spec.yaw);
  return { x: spec.x + lx * cs + lz * sn, y: ly, z: spec.z - lx * sn + lz * cs };
}

const fmt = (v: number, p = 1): string => v.toFixed(p);

/** Print the most heavily used bonds of the building's biggest fixed group. */
function dumpUtil(env: Env, specId: number, top = 8): void {
  const b = env.d.sim.buildings.get(specId)!;
  let G: Group | null = null;
  for (const x of env.d.sim.groups) if (x.bld === b && x.fixed && (!G || x.pieces.length > G.pieces.length)) G = x;
  if (!G) { console.log('  (no fixed group)'); return; }
  const s = env.d.sim.solver;
  const g = b.graph;
  s.util.fill(0);
  const tS = performance.now();
  const res = s.solve(g, b.alive, b.bondAlive, G.pieces, G.pieces.length, 0, -9.81, 0, true, null, 0, null, config.destruction.bondStrengthScale, null, 1e9, 1e-6);
  const tE = performance.now() - tS;
  console.log(`  cold solve: ${res.iterations} iterations in ${fmt(tE, 2)} ms, residual ${res.residual.toExponential(1)}, max util ${fmt(s.maxUtil, 2)}`);
  const arr: Array<[number, number]> = [];
  for (let k = 0; k < g.bonds.length; k++) if (b.bondAlive[k] && s.util[k] > 0) arr.push([s.util[k], k]);
  arr.sort((x, y) => y[0] - x[0]);
  const pc = (i: number): string => (i < 0 ? 'ground' : `${g.pieces[i].kind}/f${g.pieces[i].floor}`);
  console.log(`  util top (group ${G.pieces.length} pieces, ${arr.length} loaded bonds, over ${arr.filter((a) => a[0] >= 1).length}): ` + arr.slice(0, top).map(([u, k]) => `${fmt(u, 2)}:${pc(g.ba[k])}-${pc(g.bb[k])}`).join('  '));
}

// ------------------------------------------------------------------ test 1
async function t1(): Promise<void> {
  console.log('\n=== TEST 1: punch on a terrace wall (high tier) ===');
  const env = await setup('high');
  const spec = env.layout.specs[0];
  console.log(`terrace id ${spec.id}: ${fmt(spec.width)} x ${fmt(spec.depth)} x ${fmt(spec.height)} m, ${spec.floors} floors, yaw ${spec.yaw}`);
  const p = localToWorld(spec, 5, 4.5, spec.depth / 2 + 0.5);
  env.d.applyDamage({ shape: { kind: 'sphere', center: p, radius: config.destruction.punchRadius }, damage: config.destruction.punchDamage, impulse: config.destruction.punchImpulse });
  const b = env.d.sim.buildings.get(spec.id)!;
  const g = b.graph;
  const total = g.pieces.length;
  dumpUtil(env, spec.id);
  const killed: string[] = [];
  for (let i = 0; i < total; i++) if (!b.alive[i]) killed.push(`${g.pieces[i].kind}/${g.pieces[i].material}@(${g.pieces[i].center.map((v) => fmt(v)).join(',')})`);
  console.log(`graph: ${total} pieces, ${g.bonds.length} bonds (${g.info.levels} levels, bay ${g.info.bay}); after punch: ${b.livePieces} pieces alive, ${b.liveBonds} bonds alive`);
  console.log(`destroyed ${killed.length}: ${killed.join('  ')}`);
  const tm = newTimes();
  const before = b.livePieces;
  for (let s = 0; s < 10; s++) {
    stepN(env, 60, tm);
    const gr = groupsOf(env.d, spec.id);
    const st = env.d.stats();
    console.log(`t=${s + 1}s fixedGroups=${gr.fixed} dynamicGroups=${gr.dynamic} alive=${b.livePieces} bonds=${b.liveBonds} chunks=${st.activeChunks} rubble=${st.rubbleBodies}`);
  }
  const gr = groupsOf(env.d, spec.id);
  let wasNeighbourWoken = env.d.sim.buildings.size - 1;
  console.log(`RESULT: pieces lost beyond the punch after 10 s = ${before - b.livePieces}; dynamic building groups = ${gr.dynamic}; other buildings woken = ${wasNeighbourWoken}`);
}

// ------------------------------------------------------------------ test 2
interface Sample { t: number; groups: number; chunks: number; bonds: number; topY: number; topOff: number; maxY: number }

function topPiece(env: Env, specId: number): number {
  const g = env.d.sim.buildings.get(specId)!.graph;
  let best = 0;
  for (let i = 0; i < g.pieces.length; i++) if (g.cen[i * 3 + 1] + g.pieces[i].halfExtents[1] > g.cen[best * 3 + 1] + g.pieces[best].halfExtents[1]) best = i;
  return best;
}

function runCollapse(env: Env, spec: BuildingSpec, mode: 'cols' | 'side' | 'all' | 'punch', seconds: number, every: number, log: boolean): { samples: Sample[]; tm: StepTimes; maxChunks: number } {
  env.d.wakeBuilding(spec.id);
  const b = env.d.sim.buildings.get(spec.id)!;
  const g = b.graph;
  const killedIdx: number[] = [];
  const grounded = new Uint8Array(g.pieces.length);
  for (let k = 0; k < g.bonds.length; k++) if (g.bb[k] < 0) grounded[g.ba[k]] = 1;
  for (let i = 0; i < g.pieces.length; i++) {
    const p = g.pieces[i];
    if (mode === 'cols') {
      // every ground-floor column (the cladding walls are left to carry the load, if they can)
      if (p.kind === 'column' && p.floor === 0) killedIdx.push(i);
    } else if (grounded[i] && (mode === 'all' || p.center[0] < -0.5)) {
      // every ground support, or every ground support on the -x half
      killedIdx.push(i);
    }
  }
  const top = topPiece(env, spec.id);
  const top0 = worldOf(env.d, spec.id, top)!;
  if (mode === 'punch') {
    // what a player does: punch along every face of the ground floor, a step apart
    const W = spec.width, D = spec.depth;
    const pts: Array<[number, number]> = [];
    for (let x = -W / 2; x <= W / 2 + 0.01; x += 4) pts.push([x, -D / 2 - 0.5], [x, D / 2 + 0.5]);
    for (let z = -D / 2 + 4; z <= D / 2 - 3.99; z += 4) pts.push([-W / 2 - 0.5, z], [W / 2 + 0.5, z]);
    for (const [lx, lz] of pts) {
      for (let k = 0; k < 2; k++) {
        env.d.applyDamage({ shape: { kind: 'sphere', center: localToWorld(spec, lx, 1.6, lz), radius: config.destruction.punchRadius }, damage: config.destruction.punchDamage, impulse: config.destruction.punchImpulse });
      }
    }
    for (let i = 0; i < g.pieces.length; i++) if (!b.alive[i]) killedIdx.push(i);
  }
  // removed as if by demolition charges: pulverised, so the debris cannot carry what it held
  for (const i of killedIdx) env.d.killPiece(spec.id, i, true);
  if (process.env.TRACE) env.d.sim.trace = (m) => console.log('    ' + m);
  if (log) {
    console.log(`removed ${killedIdx.length} ground-floor pieces (${mode}); graph ${g.pieces.length}p/${g.bonds.length}b (${g.info.levels} levels, bay ${g.info.bay}), bonds alive ${b.liveBonds}`);
    dumpUtil(env, spec.id, 12);
  }
  const samples: Sample[] = [];
  const tm = newTimes();
  let maxChunks = 0;
  const steps = Math.round(seconds / DT);
  const per = Math.max(1, Math.round((Number(process.env.EVERY) || every) / DT));
  for (let s = 1; s <= steps; s++) {
    stepN(env, 1, tm);
    maxChunks = Math.max(maxChunks, env.d.stats().activeChunks);
    if (s % per === 0) {
      const st = env.d.stats();
      const w = worldOf(env.d, spec.id, top);
      const gr = groupsOf(env.d, spec.id);
      let maxY = 0;
      for (const G of env.d.sim.groups) if (G.bld === b) maxY = Math.max(maxY, G.cur[1]);
      const sm: Sample = {
        t: s * DT, groups: gr.fixed + gr.dynamic, chunks: st.activeChunks, bonds: st.liveBonds,
        topY: w ? w[1] : NaN, topOff: w ? Math.hypot(w[0] - top0[0], w[2] - top0[2]) : NaN, maxY,
      };
      samples.push(sm);
      if (log) {
        const sv = env.d.sim.solver as unknown as { itersRun: number; solves?: number };
        const gs = env.d.sim.groups.filter((G) => G.bld === b);
        const parts = gs.filter((G) => G.pieces.length > 2).map((G) => `${G.fixed ? 'F' : G.body.isSleeping() ? 'z' : 'd'}${G.pieces.length}@y${fmt(G.cur[1], 0)}`).join(' ');
        let mh = 0, mm = 0;
        for (const G of gs) for (const i of G.pieces) { pieceWorld(G, i, tmp); mh += g.mass[i] * tmp[1]; mm += g.mass[i]; }
        console.log(`   intact-mass height ${fmt(mm ? mh / mm : 0)} m (${fmt(mm / 1000, 0)} t in pieces, ${gs.length} groups) | crushed ${env.d.sim.crushedTotal} impact-killed ${env.d.sim.impactKillsTotal} baked ${env.d.sim.bakedRestTotal}/${env.d.sim.bakedCapTotal}cap chunks ${env.d.stats().activeChunks} | cg ${sv.itersRun} it / ${sv.solves ?? '?'} solves | ${parts}`);
        sv.itersRun = 0; sv.solves = 0;
      }
      if (log) console.log(`t=${fmt(sm.t)}s groups=${sm.groups} (dyn ${gr.dynamic}) chunks=${sm.chunks} bonds=${sm.bonds} rubble=${st.rubbleBodies} roofY=${fmt(sm.topY)} (start ${fmt(top0[1])}) roofOffset=${fmt(sm.topOff)}m step ${fmt(tm.phys / tm.n, 2)}+${fmt(tm.sim / tm.n, 2)}ms`);
    }
  }
  if (log) {
    const w = env.physics.world;
    for (const G of env.d.sim.groups) {
      if (G.bld !== b || G.fixed || G.pieces.length < 3) continue;
      const bd = G.body;
      const lv = bd.linvel();
      const touching = new Map<string, number>();
      for (const i of G.pieces) {
        const c = b.collider[i];
        if (!c) continue;
        w.contactPairsWith(c, (o) => {
          const code = env.d.sim.owners.get(o.handle);
          const par = o.parent();
          const key = code === undefined ? `untracked(${par ? (par.isFixed() ? 'fixed' : 'dyn') : 'none'})` : code >= 2_000_000 ? 'static' : code >= 1_000_000 ? 'shard' : (Math.floor(code / 4096) === b.specId && b.group[code % 4096] === G ? 'self' : 'piece');
          touching.set(key, (touching.get(key) ?? 0) + 1);
        });
      }
      console.log(`  group ${G.pieces.length}p y=${fmt(G.cur[1])} v=(${fmt(lv.x, 2)},${fmt(lv.y, 2)},${fmt(lv.z, 2)}) type=${bd.bodyType()} enabled=${bd.isEnabled()} gs=${bd.gravityScale()} mass=${fmt(bd.mass() / 1000, 0)}t(G ${fmt(G.mass / 1000, 0)}t) sleeping=${bd.isSleeping()} ccd=${bd.isCcdEnabled()} contacts: ${[...touching].map(([k, v]) => `${k}:${v}`).join(' ')}`);
    }
  }
  return { samples, tm, maxChunks };
}

async function t2(): Promise<void> {
  const level: QualityLevel = (process.env.LEVEL as QualityLevel) || 'high';
  for (const mode of ((process.env.MODES ?? 'cols,side,all,punch').split(',') as Array<'cols' | 'side' | 'all' | 'punch'>)) {
    console.log(`\n=== TEST 2 (${mode}): tower block, remove ground-floor supports (${level}) ===`);
    const env = await setup(level);
    const spec = env.layout.specs.find((s) => s.type === 'tower')!;
    console.log(`tower id ${spec.id}: ${fmt(spec.width)} x ${fmt(spec.depth)} x ${fmt(spec.height)} m, ${spec.floors} floors`);
    runCollapse(env, spec, mode, 14, 0.5, true);
  }
}

// ------------------------------------------------------------------ test 3
async function t3(): Promise<void> {
  console.log('\n=== TEST 3: stability, every building woken, untouched, 60 s ===');
  const level: QualityLevel = (process.env.LEVEL as QualityLevel) || 'ultra';
  const env = await setup(level);
  const t0 = performance.now();
  let n = 0;
  for (const s of env.layout.specs) if (env.d.wakeBuilding(s.id)) n++;
  console.log(`woke ${n} buildings in ${fmt(performance.now() - t0, 0)} ms (pool init ${fmt(env.initMs, 0)} ms); bonds alive ${env.d.stats().liveBonds}`);
  let dynamicAtWake = 0;
  for (const G of env.d.sim.groups) if (!G.fixed) dynamicAtWake++;
  console.log(`dynamic groups right after wake: ${dynamicAtWake}`);
  const tm = newTimes();
  const bonds0 = env.d.stats().liveBonds;
  for (let s = 0; s < 6; s++) {
    stepN(env, 600, tm);
    const st = env.d.stats();
    console.log(`t=${(s + 1) * 10}s bonds=${st.liveBonds}/${bonds0} chunks=${st.activeChunks} rubble=${st.rubbleBodies} step ${fmt(tm.phys / tm.n, 3)}+${fmt(tm.sim / tm.n, 3)} ms (max ${fmt(tm.maxPhys, 2)}+${fmt(tm.maxSim, 2)})`);
  }
  let dyn = 0, lost = 0;
  for (const G of env.d.sim.groups) if (!G.fixed) dyn++;
  for (const b of env.d.sim.buildings.values()) lost += b.graph.pieces.length - b.livePieces;
  console.log(`RESULT: bonds lost ${bonds0 - env.d.stats().liveBonds}, pieces lost ${lost}, dynamic groups ${dyn}`);
}

// ------------------------------------------------------------------ test 4
async function t4(): Promise<void> {
  console.log('\n=== TEST 4: physics cost during a full tower collapse, per tier ===');
  for (const level of ['low', 'medium', 'high', 'ultra'] as QualityLevel[]) {
    const env = await setup(level);
    const spec = env.layout.specs.find((s) => s.type === 'tower')!;
    const r = runCollapse(env, spec, 'all', 20, 1, false);
    const cap = env.quality.maxActiveChunks;
    const last = r.samples[r.samples.length - 1];
    const g = env.d.sim.buildings.get(spec.id)!.graph;
    console.log(`${level}: tower ${g.pieces.length}p/${g.bonds.length}b | step avg ${fmt(r.tm.phys / r.tm.n, 2)} ms physics + ${fmt(r.tm.sim / r.tm.n, 2)} ms destruction (max ${fmt(r.tm.maxPhys, 1)} + ${fmt(r.tm.maxSim, 1)}) | max chunks ${r.maxChunks} / cap ${cap} ${r.maxChunks <= cap ? 'OK' : 'OVER'} | end: rubble ${env.d.stats().rubbleBodies}, bonds ${last.bonds}`);
  }
}

// ------------------------------------------------------------------ diagnostics
async function t0(): Promise<void> {
  const level: QualityLevel = (process.env.LEVEL as QualityLevel) || 'high';
  const env = await setup(level);
  let tm = newTimes();
  stepN(env, 100);
  stepN(env, 120, tm);
  console.log(`asleep, nothing woken: median ${fmt(median(tm.physArr), 3)} ms/step`);
  for (const s of env.layout.specs) env.d.wakeBuilding(s.id);
  console.log(`dynamic groups after wake:`);
  for (const G of env.d.sim.groups) {
    if (G.fixed) continue;
    const g = G.bld.graph;
    console.log(`  spec ${G.bld.specId} (${G.bld.spec.type}) ${G.pieces.length} pieces: ` + G.pieces.slice(0, 4).map((i) => `${g.pieces[i].kind}/${g.pieces[i].material}@${g.pieces[i].center.map((v) => fmt(v)).join(',')} hs ${g.pieces[i].halfExtents.map((v) => fmt(v, 2)).join(',')}`).join(' | '));
  }
  stepN(env, 100);
  tm = newTimes();
  stepN(env, 120, tm);
  console.log(`woken: median ${fmt(median(tm.physArr), 3)} ms/step (p95 ${fmt(pct(tm.physArr, 0.95), 2)}); bodies ${env.physics.stats().bodies} colliders ${env.physics.stats().colliders} active ${env.physics.stats().activeBodies}`);
}

async function t5(): Promise<void> {
  console.log('\n=== TEST 5: stress solve cost (repeat cold solves) ===');
  const env = await setup((process.env.LEVEL as QualityLevel) || 'high');
  for (const type of ['tower', 'terrace', 'office', 'townHall']) {
    const spec = env.layout.specs.find((s) => s.type === type);
    if (!spec) continue;
    const b = env.d.wakeBuilding(spec.id)!;
    const g = b.graph;
    let G: Group | null = null;
    for (const x of env.d.sim.groups) if (x.bld === b && x.fixed && (!G || x.pieces.length > G.pieces.length)) G = x;
    if (!G) continue;
    const s = env.d.sim.solver;
    const times: number[] = [];
    let it = 0;
    for (let k = 0; k < 30; k++) {
      const t0 = performance.now();
      const r = s.solve(g, b.alive, b.bondAlive, G.pieces, G.pieces.length, 0, -9.81, 0, true, null, 0, null, 1, null, 1e9, 1e-4);
      times.push(performance.now() - t0);
      it = r.iterations;
    }
    const med = median(times.slice(5));
    console.log(`${type}: ${g.pieces.length}p/${g.bonds.length}b, ${it} it, median ${fmt(med, 3)} ms/solve = ${fmt((med * 1e6) / (it * (g.bonds.length + g.pieces.length)), 0)} ns per bond-iteration (first ${fmt(times[0], 2)} ms)`);
  }
}

async function t6(): Promise<void> {
  // replay a punch at a world point: PUNCH=x,y,z LEVEL=low
  const env = await setup((process.env.LEVEL as QualityLevel) || 'low');
  const [x, y, z] = (process.env.PUNCH || '-5,8,-59.5').split(',').map(Number);
  // warm the JIT on a far building first so the timing below is steady-state
  env.d.wakeBuilding(env.layout.specs[env.layout.specs.length - 1].id);
  const tw0 = performance.now();
  env.d.applyDamage({ shape: { kind: 'sphere', center: { x, y, z }, radius: config.destruction.punchRadius }, damage: config.destruction.punchDamage, impulse: config.destruction.punchImpulse, direction: { x: 0, y: 0, z: -1 } });
  for (const b of env.d.sim.buildings.values()) {
    const g = b.graph;
    const dead: string[] = [];
    for (let i = 0; i < g.pieces.length; i++) if (!b.alive[i]) dead.push(`${g.pieces[i].kind}/${g.pieces[i].material}`);
    const s = b.spec;
    console.log(`woke ${s.type} ${s.id} at (${fmt(s.x)}, ${fmt(s.z)}) ${fmt(s.width)}x${fmt(s.depth)}x${fmt(s.height)} yaw ${fmt(s.yaw, 2)}: ${g.pieces.length}p/${g.bonds.length}b, destroyed ${dead.length}: ${dead.join(' ')}`);
  }
  console.log(`applyDamage (wake + damage + shards): ${fmt(performance.now() - tw0, 1)} ms`);
  const tm = newTimes();
  const W = env.physics.world as unknown as Record<string, (...a: unknown[]) => number>;
  if (process.env.PROF) {
    (env.physics.world as unknown as { profilerEnabled: boolean }).profilerEnabled = true;
    for (let k = 0; k < 4; k++) {
      stepN(env, 1, tm);
      const f = (n: string): string => `${n.replace('timing', '')} ${fmt(W[n].call(env.physics.world), 1)}`;
      console.log(`  step ${k}: ` + ['timingStep', 'timingUserChanges', 'timingBroadPhase', 'timingNarrowPhase', 'timingIslandConstruction', 'timingSolver', 'timingVelocityAssembly', 'timingVelocityResolution', 'timingCcd'].map(f).join(' | '));
    }
  }
  stepN(env, 120, tm);
  console.log(`next 120 steps: physics avg ${fmt(tm.phys / tm.n, 2)} max ${fmt(tm.maxPhys, 1)} ms, destruction avg ${fmt(tm.sim / tm.n, 2)} max ${fmt(tm.maxSim, 1)} ms; first 10 steps: ` + tm.physArr.slice(0, 10).map((v, i) => fmt(v + tm.simArr[i], 1)).join(' '));
  {
    const w = env.physics.world;
    const R = env.physics.RAPIER;
    let pairs = 0, manifolds = 0, pts = 0, shards = 0;
    w.forEachCollider((c) => {
      const code = env.d.sim.owners.get(c.handle);
      if (code !== undefined && code >= 1_000_000 && code < 2_000_000) shards++;
    });
    w.narrowPhase && w.forEachCollider((c) => {
      w.contactPairsWith(c, (o) => {
        pairs++;
        w.contactPair(c, o, (m) => { manifolds++; pts += m.numContacts(); });
      });
    });
    const st = env.physics.stats();
    console.log(`world: bodies ${st.bodies} active ${st.activeBodies} colliders ${st.colliders}; shard colliders ${shards}; contact pairs ${pairs / 2} manifolds ${manifolds / 2} points ${pts / 2}`);
    const t = newTimes();
    stepN(env, 30, t);
    console.log(`  30 steps baseline: phys ${fmt(median(t.physArr), 2)} ms median`);
    if (process.env.EXP) {
      w.forEachCollider((c) => { c.setActiveEvents(R.ActiveEvents.NONE); });
      const t2 = newTimes();
      stepN(env, 30, t2);
      console.log(`  30 steps, all contact-force events off: phys ${fmt(median(t2.physArr), 2)} ms median`);
    }
  }
  if (process.env.LONG) {
    for (let sec = 3; sec <= 20; sec++) {
      const t = newTimes();
      stepN(env, 60, t);
      const st = env.d.stats();
      const ps = env.physics.stats();
      console.log(`t=${sec}s chunks ${st.activeChunks} rubble ${st.rubbleBodies} bonds ${st.liveBonds} colliders ${ps.colliders} active ${ps.activeBodies} | phys avg ${fmt(t.phys / t.n, 2)} max ${fmt(t.maxPhys, 1)} sim avg ${fmt(t.sim / t.n, 2)} | crushed ${env.d.sim.crushedTotal} impact ${env.d.sim.impactKillsTotal}`);
    }
  }
  console.log(`after 2 s: chunks ${env.d.stats().activeChunks}, rubble ${env.d.stats().rubbleBodies}, bonds ${env.d.stats().liveBonds}`);
}

async function t7(): Promise<void> {
  const env = await setup((process.env.LEVEL as QualityLevel) || 'medium');
  stepN(env, 30);
  const time = (label: string, f: () => void): void => { const t0 = performance.now(); f(); console.log(`  ${label}: ${fmt(performance.now() - t0, 1)} ms`); };
  const one = (label: string): void => time(label, () => stepN(env, 1));
  one('step, idle');
  env.d.wakeBuilding(env.layout.specs[env.layout.specs.length - 1].id); one('step after waking a far building (JIT warm-up)');
  one('step');
  const spec = env.layout.specs.find((x) => x.id === 19)!;
  time('wake terrace 19', () => env.d.wakeBuilding(spec.id));
  one('first step after wake'); one('second step');
  const b = env.d.sim.buildings.get(spec.id)!;
  let k = -1;
  for (let i = 0; i < b.graph.pieces.length; i++) if (b.graph.pieces[i].kind === 'wall' && b.graph.pieces[i].floor === 0) { k = i; break; }
  time('kill one wall piece (fracture + shard bodies)', () => env.d.killPiece(spec.id, k));
  one('first step after shards'); one('second step'); one('third step');
  for (let r = 0; r < 3; r++) one('step');
}

async function t8(): Promise<void> {
  // three punches on three terraces: is the first-step spike a one-off (warm-up) or per punch?
  const env = await setup((process.env.LEVEL as QualityLevel) || 'medium');
  stepN(env, 30);
  const terr = env.layout.specs.filter((x) => x.type === 'terrace').slice(0, 3);
  for (const spec of terr) {
    const p = localToWorld(spec, 0, 4, spec.depth / 2 + 0.5);
    const t0 = performance.now();
    env.d.applyDamage({ shape: { kind: 'sphere', center: p, radius: config.destruction.punchRadius }, damage: config.destruction.punchDamage, impulse: config.destruction.punchImpulse });
    const tm = newTimes();
    stepN(env, 60, tm);
    console.log(`terrace ${spec.id}: punch ${fmt(performance.now() - t0 - tm.phys - tm.sim, 1)} ms; first 6 steps (phys+sim): ` + tm.physArr.slice(0, 6).map((v, i) => fmt(v + tm.simArr[i], 1)).join(' ') + ` | max ${fmt(tm.maxPhys, 1)}+${fmt(tm.maxSim, 1)}`);
  }
}

async function t9(): Promise<void> {
  const env = await setup('low');
  const b = env.d.wakeBuilding(19)!;
  for (const i of [3, 16, 17, 4, 6, 18, 30, 25]) {
    const p = b.graph.pieces[i];
    for (const n of [7, 12]) {
      const r = fractureBox(p.halfExtents[0], p.halfExtents[1], p.halfExtents[2], p.material, p.kind, p.seed, n);
      console.log(`piece ${i} ${p.kind}/${p.material} ${p.halfExtents.map((v) => fmt(v, 2)).join('x')} count ${n} -> ${r.shards.length} shards`);
    }
  }
}

const which = process.argv[2] ?? 'all';
(async () => {
  if (which === 't0') await t0();
  if (which === 't5') await t5();
  if (which === 't6') await t6();
  if (which === 't7') await t7();
  if (which === 't8') await t8();
  if (which === 't9') await t9();
  if (which === 't1' || which === 'all') await t1();
  if (which === 't2' || which === 'all') await t2();
  if (which === 't3' || which === 'all') await t3();
  if (which === 't4' || which === 'all') await t4();
})().catch((e) => { console.error(e); process.exit(1); });

export type { Group };
