// Regression test: the plotter must lay ink ONLY inside expected black runs.
// Runs the real boost_image_plotter.js draw() against the firmware-faithful
// motor mocks. Exit 0 = pass, 1 = fail.
'use strict';
const { runScenario } = require('./harness');

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

async function main() {
  const scenarios = [];

  // S1: handcrafted rows with short segments (the killer case)
  {
    const W = 96, H = 20, bmp = new Uint8Array(W * H);
    for (let c = 10; c <= 12; c++) bmp[3 * W + c] = 1;
    for (let c = 40; c <= 60; c++) bmp[3 * W + c] = 1;
    for (let c = 5; c <= 30; c++) bmp[6 * W + c] = 1;
    for (let c = 70; c <= 71; c++) bmp[6 * W + c] = 1;
    for (let c = 8; c <= 20; c++) bmp[9 * W + c] = 1;
    scenarios.push(['short-segments', bmp, W, H]);
  }

  // S2: content reaching the right canvas edge + next row starting left
  {
    const W = 96, H = 12, bmp = new Uint8Array(W * H);
    for (let c = 80; c <= 95; c++) bmp[2 * W + c] = 1;   // ends at edge
    for (let c = 4; c <= 9; c++) bmp[3 * W + c] = 1;     // next row far left
    for (let c = 90; c <= 91; c++) bmp[5 * W + c] = 1;   // short seg near edge
    for (let c = 20; c <= 50; c++) bmp[6 * W + c] = 1;
    scenarios.push(['edge-rows', bmp, W, H]);
  }

  // S3: random dense dithered rows (stress, deterministic seed)
  {
    const W = 96, H = 16, bmp = new Uint8Array(W * H);
    const rnd = mulberry32(42);
    for (let r = 2; r < H - 2; r++) {
      let c = 2;
      while (c < W - 2) {
        const run = 1 + Math.floor(rnd() * 6);
        const gap = 2 + Math.floor(rnd() * 10);
        for (let k = 0; k < run && c + k < W - 2; k++) bmp[r * W + c + k] = 1;
        c += run + gap;
      }
    }
    scenarios.push(['dither-stress', bmp, W, H]);
  }

  let failed = 0;
  for (const [name, bmp, W, H] of scenarios) {
    const { artifacts, virtualMs } = await runScenario(name, bmp, W, H);
    const status = artifacts.length === 0 ? 'PASS' : 'FAIL';
    if (artifacts.length) failed++;
    console.log(`${status}  ${name}: ${artifacts.length} spurious-ink artifact(s), plot time ${(virtualMs / 1000).toFixed(1)}s`);
    for (const a of artifacts.slice(0, 8)) console.log('       ', JSON.stringify(a));
  }
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
