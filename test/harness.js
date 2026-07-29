// Simulation harness: runs the REAL boost_image_plotter.js draw() loop against
// mock motors that implement LEGO Wireless Protocol semantics as found in
// node-poweredup dist:
//   - rotateByDegrees sends a PortOutputCommand with startup="buffer if necessary"
//     -> if a command is executing on that motor, the new one is BUFFERED in the
//        hub and starts only after the current one completes; a second buffered
//        command replaces (discards) the first.
//   - promise resolves on EXECUTION_COMPLETED feedback (BLE latency)
//   - device.values.rotate.degrees updates from subscription notifications
//     (delta 1 degree, BLE latency)
// A virtual clock drives everything deterministically. An ink tracer records
// where the pen physically touches the paper.

'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

// ---------- virtual clock ----------
class Clock {
  constructor() { this.now = 0; this.timers = []; this.seq = 0; }
  setTimeout(fn, ms) { this.timers.push({ t: this.now + ms, seq: this.seq++, fn }); }
  sleep(ms) { return new Promise(res => this.setTimeout(res, ms)); }
  async run(done) {
    // pump until `done` resolves or no timers left
    let finished = false;
    done.then(() => { finished = true; });
    for (;;) {
      // let microtasks settle
      for (let i = 0; i < 50; i++) await Promise.resolve();
      if (finished) return;
      if (!this.timers.length) {
        // drain macrotask-ish once more, then bail if still nothing
        await new Promise(r => setImmediate(r));
        if (finished) return;
        if (!this.timers.length) throw new Error('deadlock: no timers pending but draw() not finished');
        continue;
      }
      this.timers.sort((a, b) => a.t - b.t || a.seq - b.seq);
      const next = this.timers.shift();
      this.now = next.t;
      next.fn();
    }
  }
}

// ---------- mock motor with firmware buffer semantics ----------
// Motion model: constant velocity, speedPct/100 * DEG_PER_SEC_FULL deg/s.
const DEG_PER_SEC_FULL = 1000;   // ~170 rpm BOOST motor, no load
const BLE_LATENCY = 30;          // ms, notification & feedback latency
const NOTIFY_DELTA = 1;          // degrees, subscription delta interval

class MockMotor {
  constructor(name, clock, tracer) {
    this.name = name;
    this.clock = clock;
    this.tracer = tracer;
    this.pos = 0;                // physical position now (degrees)
    this.history = [{ t: 0, pos: 0 }]; // piecewise linear motion history
    this.executing = null;       // {target, degPerMs, resolve}
    this.buffered = null;        // one firmware buffer slot
    this.reported = 0;           // last notified position (deg), updates with lag
    const self = this;
    this.values = { rotate: { get degrees() { return self.reported; } } };
  }
  // physical position of motor at time t (from piecewise-linear history)
  positionAt(t) {
    const h = [...this.history].sort((a, b) => a.t - b.t);
    if (t <= h[0].t) return h[0].pos;
    for (let i = 0; i + 1 < h.length; i++) {
      const a = h[i], b = h[i + 1];
      if (t >= a.t && t <= b.t) {
        if (b.t === a.t) return b.pos;
        return a.pos + (b.pos - a.pos) * (t - a.t) / (b.t - a.t);
      }
    }
    return h[h.length - 1].pos;
  }
  _notifyLoop(target) {
    // schedule position notifications every NOTIFY_DELTA degrees until motion end
    // simplified: schedule updates of `reported` at BLE_LATENCY after each 1-deg crossing
    const seg = this.history[this.history.length - 1];
    const prev = this.history[this.history.length - 2];
    const dur = seg.t - prev.t;
    const dist = Math.abs(seg.pos - prev.pos);
    const steps = Math.max(1, Math.floor(dist / NOTIFY_DELTA));
    for (let s = 1; s <= steps; s++) {
      const tCross = prev.t + dur * (s * NOTIFY_DELTA) / dist;
      const posAt = prev.pos + Math.sign(seg.pos - prev.pos) * s * NOTIFY_DELTA;
      this.clock.setTimeout(() => { this.reported = posAt; }, (tCross - this.clock.now) + BLE_LATENCY);
    }
    // final exact position notification
    this.clock.setTimeout(() => { this.reported = seg.pos; }, (seg.t - this.clock.now) + BLE_LATENCY);
  }
  rotateByDegrees(degrees, speed) {
    // returns promise resolving on completion feedback (like node-poweredup)
    return new Promise(resolve => {
      const cmd = { degrees, speed, resolve };
      // firmware "buffer if necessary"
      if (this.executing) {
        if (this.buffered) {
          // replace buffered; old buffered command is discarded -> feedback resolves
          const old = this.buffered;
          this.clock.setTimeout(() => old.resolve('EXECUTION_DISCARDED'), BLE_LATENCY);
        }
        this.buffered = cmd;
        this.tracer.log(`${this.name}: BUFFERED rotateByDegrees(${degrees}, ${speed}) (motor busy)`);
      } else {
        this._start(cmd);
      }
    });
  }
  _start(cmd) {
    const dir = Math.sign(cmd.speed) || 1;
    const target = this.pos + dir * Math.abs(cmd.degrees);
    const durMs = Math.abs(cmd.degrees) / (Math.abs(cmd.speed) / 100 * DEG_PER_SEC_FULL) * 1000;
    this.executing = cmd;
    this.history.push({ t: this.clock.now, pos: this.pos }); // motion start (motor was idle at this.pos until now)
    this.history.push({ t: this.clock.now + durMs, pos: target });
    this.tracer.log(`${this.name}: START rotate ${dir * Math.abs(cmd.degrees)}deg @${cmd.speed} (${this.pos} -> ${target}, ${durMs.toFixed(0)}ms)`);
    this._notifyLoop(target);
    this.clock.setTimeout(() => {
      this.pos = target;
      this.executing = null;
      this.tracer.log(`${this.name}: DONE at ${target}`);
      // completion feedback over BLE
      this.clock.setTimeout(() => cmd.resolve('EXECUTION_COMPLETED'), BLE_LATENCY);
      if (this.buffered) { const b = this.buffered; this.buffered = null; this._start(b); }
    }, durMs);
  }
  setAccelerationTime() {} setDecelerationTime() {} setMaxPower() {}
  setSpeed() { return Promise.resolve(); }
  setPower() { return Promise.resolve(); }
  brake() { return Promise.resolve(); }
}

// ---------- tracer ----------
class Tracer {
  constructor(clock) { this.clock = clock; this.events = []; this.verbose = false; }
  log(msg) { this.events.push(`[${this.clock.now.toFixed(0).padStart(7)}ms] ${msg}`); if (this.verbose) console.log(this.events[this.events.length - 1]); }
}

// ---------- ink reconstruction ----------
// After the run, walk the merged motion histories of X, Y, Z and emit ink
// wherever Z (pen) position is below touch threshold while X or Y moves.
function reconstructInk(mx, my, mz, touchZ, pxX, pxY) {
  // collect all breakpoints
  const ts = new Set();
  for (const m of [mx, my, mz]) for (const h of m.history) ts.add(h.t);
  const times = [...ts].sort((a, b) => a - b);
  const strokes = []; // {t0,t1,x0,x1,row}
  for (let i = 0; i + 1 < times.length; i++) {
    const t0 = times[i], t1 = times[i + 1];
    if (t1 - t0 <= 0) continue;
    // sample the segment at both ends and midpoint for touch state
    const zm = mz.positionAt((t0 + t1) / 2);
    if (zm > touchZ) continue; // pen up (z<=touchZ means touching; down = negative)
    const x0 = mx.positionAt(t0) / pxX, x1 = mx.positionAt(t1) / pxX;
    const y0 = my.positionAt(t0) / pxY, y1 = my.positionAt(t1) / pxY;
    strokes.push({ t0, t1, x0, x1, y0, y1 });
  }
  return strokes;
}

// ---------- DOM / environment stubs ----------
function makeEnv(bitmap, W, H) {
  const clock = new Clock();
  const tracer = new Tracer(clock);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = bitmap[i] ? 0 : 255; // 1 = black pixel
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    fillRect() {}, drawImage() {}, clearRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray(data) }),
    putImageData() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  };
  const canvas = {
    width: W, height: H, style: {}, getContext: () => ctx,
    getBoundingClientRect: () => ({ x: 0, y: 0 }), addEventListener() {},
  };
  const elements = new Proxy({}, {
    get(t, id) {
      if (!t[id]) t[id] = id === 'canvas' ? canvas :
        { style: {}, disabled: false, innerHTML: '', innerText: '', checked: true, value: '1', addEventListener() {} };
      return t[id];
    }
  });
  const sandbox = {
    document: { getElementById: id => elements[id] },
    window: { alert() {} },
    console: { log() {} },
    PoweredUP: {
      PoweredUP: class { on() {} scan() {} },
      isWebBluetooth: false,
      Consts: { Color: { RED: 9, GREEN: 6 }, DeviceType: { HUB_LED: 23 } },
    },
    Image: class { },
    Date: Date,
    Math, JSON,
    $: () => ({ trigger() {} }),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, "..", "boost_image_plotter.js"), 'utf8');
  vm.runInContext(src, sandbox);

  // wire mocks in place of real hub/motors
  const motorX = new MockMotor('X', clock, tracer);
  const motorY = new MockMotor('Y', clock, tracer);
  const motorZ = new MockMotor('Z', clock, tracer);
  const plotter = {
    batteryLevel: 100,
    sleep: ms => clock.sleep(ms),
    wait: ps => Promise.all(ps),
  };
  const led = { setColor() {} };
  Object.assign(sandbox, { motorX, motorY, motorZ, plotter, led });
  vm.runInContext('motorX = globalThis.motorX; motorY = globalThis.motorY; motorZ = globalThis.motorZ; plotter = globalThis.plotter; led = globalThis.led; X0 = 0; Y0 = 0; Z0 = 0; connected = true; penSize = 1;', sandbox);
  return { sandbox, clock, tracer, motorX, motorY, motorZ };
}

// ---------- expected ink from bitmap ----------
function expectedRuns(bitmap, W, H) {
  const runs = {}; // row -> [[c0,c1],...]
  for (let r = 0; r < H; r++) {
    runs[r] = [];
    let start = -1;
    for (let c = 0; c < W; c++) {
      const b = bitmap[r * W + c];
      if (b && start < 0) start = c;
      if (!b && start >= 0) { runs[r].push([start, c - 1]); start = -1; }
    }
    if (start >= 0) runs[r].push([start, W - 1]);
  }
  return runs;
}

// ---------- artifact detection ----------
function analyze(strokes, runs, W, H) {
  const artifacts = [];
  // group pen-down strokes by row (nearest int of y, only when y is ~constant)
  for (const s of strokes) {
    if (Math.abs(s.y1 - s.y0) > 0.4) {
      if (Math.abs(s.x1 - s.x0) > 0.4) artifacts.push({ type: 'DIAGONAL_SPUR', ...s });
      else artifacts.push({ type: 'VERTICAL_SPUR', ...s });
      continue;
    }
    const row = Math.round((s.y0 + s.y1) / 2);
    const lo = Math.min(s.x0, s.x1), hi = Math.max(s.x0, s.x1);
    if (hi - lo < 0.6) continue; // dot, ignore
    const rowRuns = runs[row] || [];
    // does [lo,hi] fit within some expected run (+1px tolerance for the
    // off-by-one moveX(colEnd) which targets the first white pixel)?
    const ok = rowRuns.some(([a, b]) => lo >= a - 1.6 && hi <= b + 1.6);
    if (!ok) {
      const rightmost = rowRuns.length ? rowRuns[rowRuns.length - 1][1] : -1;
      const type = hi > rightmost + 1.6 ? 'RIGHT_OVERRUN' : 'GAP_FILL_OR_SPUR';
      artifacts.push({ type, row, lo: +lo.toFixed(1), hi: +hi.toFixed(1), dir: s.x1 >= s.x0 ? 'R' : 'L', t0: +s.t0.toFixed(0) });
    }
  }
  return artifacts;
}

// ---------- main ----------
async function runScenario(name, bitmap, W, H, { touchZ = -20 } = {}) {
  const { sandbox, clock, tracer, motorX, motorY, motorZ } = makeEnv(bitmap, W, H);
  const done = vm.runInContext('draw(true)', sandbox);
  await clock.run(done.then(() => {})); // eject etc included
  const strokes = reconstructInk(motorX, motorY, motorZ, touchZ, 5, 6);
  const runs = expectedRuns(bitmap, W, H);
  const artifacts = analyze(strokes.filter(s => s.t0 > 0), runs, W, H);
  return { strokes, runs, artifacts, tracer, virtualMs: clock.now };
}

module.exports = { runScenario, expectedRuns };

if (require.main === module) {
  (async () => {
    // Scenario 1: one row, short segment then a second segment further right
    const W = 96, H = 20;
    const bmp = new Uint8Array(W * H);
    // row 3: short run [10..12], then [40..60]
    for (let c = 10; c <= 12; c++) bmp[3 * W + c] = 1;
    for (let c = 40; c <= 60; c++) bmp[3 * W + c] = 1;
    // row 6: long run [5..30], short run [70..71]
    for (let c = 5; c <= 30; c++) bmp[6 * W + c] = 1;
    for (let c = 70; c <= 71; c++) bmp[6 * W + c] = 1;
    // row 9: starts left [8..20]
    for (let c = 8; c <= 20; c++) bmp[9 * W + c] = 1;
    const { artifacts, tracer, virtualMs } = await runScenario('two-segments', bmp, W, H);
    console.log(`virtual time: ${(virtualMs / 1000).toFixed(1)}s`);
    console.log('ARTIFACTS:', JSON.stringify(artifacts, null, 1));
    fs.writeFileSync(__dirname + '/trace.log', tracer.events.join('\n'));
    console.log('trace written to sim/trace.log (' + tracer.events.length + ' events)');
  })().catch(e => { console.error(e); process.exit(1); });
}
