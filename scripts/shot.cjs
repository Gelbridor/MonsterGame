// Visual check harness: open the game in headless Chromium and save a screenshot.
//
//   node scripts/shot.cjs <url> <out.png> [options]
//
// Options:
//   --size 1280x720        viewport (default 1280x720)
//   --phone                emulate an iPhone 13 (390x844, touch)
//   --wait 9000            ms to wait after the game reports ready (default 9000)
//   --keys "KeyW:1500,ArrowLeft:600"   hold keys in sequence (code:ms) before the shot
//   --eval "mb.config.camera.pitch = 0.2"  run JS in the page after load (mb = window.mb)
//
// Notes:
// - Headless here has no GPU: WebGPU is broken, so ALWAYS pass ?webgl in the URL.
//   Software WebGL runs at a few fps, so effects that accumulate over time
//   (TRAA, auto-exposure) need the longer --wait.
// - Console errors and warnings are printed so you can catch shader failures.

const { chromium, devices } = require('playwright');

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
if (!url || !out) {
  console.error('usage: node scripts/shot.cjs <url> <out.png> [--size WxH] [--phone] [--wait ms] [--keys ...] [--eval js]');
  process.exit(1);
}
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(name);

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let context;
  if (flag('--phone')) {
    context = await browser.newContext({ ...devices['iPhone 13'] });
  } else {
    const [w, h] = opt('--size', '1280x720').split('x').map(Number);
    context = await browser.newContext({ viewport: { width: w, height: h } });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(240000);
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || /renderer|Monster Brawl/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(url);
  await page.waitForFunction(() => window.mb, null, { timeout: 120000 });
  const evalJs = opt('--eval', null);
  if (evalJs) await page.evaluate((src) => new Function('mb', src)(window.mb), evalJs);

  const keys = opt('--keys', null);
  if (keys) {
    for (const part of keys.split(',')) {
      const [code, ms] = part.split(':');
      await page.keyboard.down(code);
      await page.waitForTimeout(Number(ms || 500));
      await page.keyboard.up(code);
    }
  }
  await page.waitForTimeout(Number(opt('--wait', '9000')));
  await page.screenshot({ path: out, timeout: 240000 });
  const stats = await page.evaluate(() => document.querySelector('.mb-stats')?.textContent ?? '');
  console.log(stats);
  console.log(logs.slice(0, 40).join('\n'));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
