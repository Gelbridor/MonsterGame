// Bundle and run the headless destruction harness:  node scripts/run-harness.cjs [t1|t2|t3|t4|all]
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const rd = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'rolldown.cmd' : 'rolldown');
const out = path.join(root, 'scripts', '.out', 'destruction-harness.mjs');
const b = spawnSync(rd, ['scripts/destruction-harness.ts', '--format', 'esm', '--platform', 'node', '-o', out], { cwd: root, stdio: 'inherit', shell: true });
if (b.status !== 0) process.exit(b.status || 1);
const r = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
process.exit(r.status || 0);
