'use strict';

// What the watch learns from a path's own history, beyond its baseline: the
// departures it keeps making and coming back from, how long it holds one
// value, counters that show themselves by their resets and how fast they
// count, measurements that are never state codes, null as "no value", and
// day and night as an operating state of everything solar. Each case is a
// pattern a moored boat's first day of watching raised as noise.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createWatchEngine, normalizeWatchConfig } = require('../lib/watch/engine.cjs');
const monitor = require('../lib/watch/path-monitor.cjs');
const habits = require('../lib/watch/habits.cjs');
const { sunElevationDeg } = require('../lib/watch/sun.cjs');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const T0 = Date.parse('2026-06-01T08:00:00Z');
// The most operating changes a flapping gate makes before it is held.
const GATE_LIMIT = 5;

function noise(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
}

/** Samples every `stepMs`, a tick every five seconds, as the plugin does. */
function run(engine, from, to, stepMs, sample) {
  let nextTick = from;
  for (let t = from; t < to; t += stepMs) {
    for (const [path, value, source] of sample(t)) {
      engine.ingest(path, value, t, source);
    }
    if (t >= nextTick) {
      engine.tick(t);
      nextTick = t + 5 * SECOND;
    }
  }
  engine.tick(to);
  return to;
}

function newEngine(overrides = {}, now = T0) {
  return createWatchEngine(normalizeWatchConfig({ watchEnabled: true, watchLearningMinutes: 20, ...overrides }), { now });
}

function detectors(engine) {
  return engine.status().activeFindings.map((finding) => `${finding.detector}:${finding.path}`);
}

function opened(engine, detector) {
  return engine.status().incidents.flatMap((incident) => incident.findings).filter((entry) => entry.detector === detector);
}

describe('watch learning: departures a path keeps coming back from', () => {
  const path = 'networking.edgeLink.boat.packetLoss';
  // A radio link: no loss, and a minute of around 10 % loss every three
  // hours (never twice quite the same, as real loss is).
  const spike = (start, value = 0.1, lengthMs = MINUTE) => (t) => [[path, t >= start && t < start + lengthMs ? value : 0]];
  const SIZES = [0.06, 0.09, 0.13, 0.07, 0.1, 0.14, 0.08, 0.11];

  function blips(engine, from, count, options = {}) {
    let t = from;
    const seen = [];
    for (let index = 0; index < count; index += 1) {
      const start = t + 3 * HOUR;
      const value = options.value ?? SIZES[index % SIZES.length];
      t = run(engine, t, start + 50 * SECOND, 5 * SECOND, spike(start, value, options.lengthMs));
      seen.push(detectors(engine).includes(`shift:${path}`));
      t = run(engine, t, start + 30 * MINUTE, 5 * SECOND, spike(start, value, options.lengthMs));
    }
    return { t, seen };
  }

  it('reports the first spikes, then stops once they are a habit, and says so in the report', () => {
    const engine = newEngine();
    let t = run(engine, T0, T0 + 30 * MINUTE, 5 * SECOND, () => [[path, 0]]);
    const { t: after, seen } = blips(engine, t, 8);
    t = after;
    assert.deepEqual(seen.slice(0, 3), [true, true, true], 'the first spikes are news');
    assert.deepEqual(seen.slice(4), [false, false, false, false], `a habit by now: ${seen.join(', ')}`);
    const report = engine.report(t, 48);
    assert.ok(report.lines.some((line) => /Learned to expect/.test(line) && /packet loss/i.test(line)), report.lines.join('\n'));
  });

  it('still reports a spike of a new size, and says what it usually does', () => {
    const engine = newEngine();
    let t = run(engine, T0, T0 + 30 * MINUTE, 5 * SECOND, () => [[path, 0]]);
    t = blips(engine, t, 6).t;
    const start = t + 3 * HOUR;
    t = run(engine, t, start + 50 * SECOND, 5 * SECOND, spike(start, 0.6));
    const finding = engine.status().activeFindings.find((item) => item.detector === 'shift');
    assert.ok(finding, 'six times the usual loss is news');
    assert.match(finding.message, /such rises in the past/);
  });

  it('still reports a spike of the usual size that lasts far longer than usual', () => {
    const engine = newEngine();
    let t = run(engine, T0, T0 + 30 * MINUTE, 5 * SECOND, () => [[path, 0]]);
    t = blips(engine, t, 6).t;
    const start = t + 3 * HOUR;
    t = run(engine, t, start + 3 * MINUTE, 5 * SECOND, spike(start, 0.1, HOUR));
    assert.ok(!detectors(engine).includes(`shift:${path}`), 'three minutes is still about usual');
    t = run(engine, t, start + 12 * MINUTE, 5 * SECOND, spike(start, 0.1, HOUR));
    assert.ok(detectors(engine).includes(`shift:${path}`), 'twelve minutes of it is not');
  });

  it('forgets the habit when the operator says a finding on the path was useful', () => {
    const engine = newEngine();
    let t = run(engine, T0, T0 + 30 * MINUTE, 5 * SECOND, () => [[path, 0]]);
    t = blips(engine, t, 6).t;
    engine.giveFeedback(path, true, t);
    const { seen } = blips(engine, t, 1);
    assert.deepEqual(seen, [true]);
  });

  it('keeps the noise floor of a path that sits at zero at its resolution, not at 5 % of a vanishing mean', () => {
    const state = monitor.createPathState(path, T0);
    // As a decayed spike leaves it: a mean of 1e-13, a resolution of 0.002.
    Object.assign(state, { kind: 'continuous', mean: 7.5e-13, fast: 5e-14, variance: 1e-23, quantum: 0.002, allInteger: false });
    assert.equal(monitor.noiseFloor(state), 0.004);
  });

  it('takes three spikes in one bad hour for an incident, not a habit', () => {
    const state = monitor.createPathState(path, T0);
    let t = T0;
    for (let index = 0; index < 3; index += 1) {
      habits.follow(state, 'shift+', 20, true, t);
      t += MINUTE;
      habits.follow(state, 'shift+', 0, false, t);
      t += 25 * MINUTE;
    }
    assert.equal(habits.usual(state, 'shift+', t), undefined);
    // The same three, spread over a day, are.
    const spread = monitor.createPathState(path, T0);
    t = T0;
    for (let index = 0; index < 3; index += 1) {
      habits.follow(spread, 'shift+', 20, true, t);
      t += MINUTE;
      habits.follow(spread, 'shift+', 0, false, t);
      t += 4 * HOUR;
    }
    assert.equal(habits.usual(spread, 'shift+', t).count, 3);
  });
});

describe('watch learning: how long a path holds one value', () => {
  it('does not call a counter that ticks in bursts and then sits for hours stuck', () => {
    const engine = newEngine();
    const path = 'networking.edgeLink.boat.retransmissions';
    let value = 5000;
    // Six retransmissions in a row every 40 minutes, sampled every second.
    run(engine, T0, T0 + 12 * HOUR, SECOND, (t) => {
      if ((t - T0) % (40 * MINUTE) < 6 * SECOND) value += 1;
      return [[path, value]];
    });
    assert.deepEqual(opened(engine, 'frozen'), []);
  });

  it('does not call a stopped engine\'s temperature stuck, and still catches a freeze while it runs', () => {
    const engine = newEngine();
    const rpm = 'propulsion.main.revolutions';
    const path = 'propulsion.main.coolantTemperature';
    const rand = noise(4);
    // Stopped for a day: the temperature steps by a quarter of a degree
    // every half hour, as a cold engine at ambient does.
    let t = run(engine, T0, T0 + 24 * HOUR, 10 * SECOND, (now) => [
      [rpm, 0],
      [path, 288 + 0.25 * (Math.floor((now - T0) / (30 * MINUTE)) % 2)]
    ]);
    assert.deepEqual(opened(engine, 'frozen'), [], 'half an hour on one reading is how it sits when stopped');
    // Running: a lively temperature, then the sender freezes.
    t = run(engine, t, t + 2 * HOUR, 10 * SECOND, () => [[rpm, 30], [path, 353 + 0.5 * rand()]]);
    assert.deepEqual(opened(engine, 'frozen'), []);
    t = run(engine, t, t + 8 * MINUTE, 10 * SECOND, () => [[rpm, 30], [path, 353.2]]);
    assert.ok(detectors(engine).includes(`frozen:${path}`), 'what it does when stopped does not excuse a freeze while running');
    assert.match(engine.status().activeFindings.find((item) => item.detector === 'frozen').message, /normally holds a value for \d+ s at most/);
  });

  it('does not call a slow sensor stuck from an evening of watching it', () => {
    const engine = newEngine();
    const path = 'propulsion.raw_water.temperature';
    // Sea water at the dock: a quarter-degree step every few minutes in the
    // evening, then the calm of the night on one reading for fifty minutes.
    let value = 281;
    let t = run(engine, T0, T0 + 3 * HOUR, 10 * SECOND, (now) => {
      if ((now - T0) % (7 * MINUTE) === 0) value = value === 281 ? 281.25 : 281;
      return [[path, value]];
    });
    t = run(engine, t, t + 50 * MINUTE, 10 * SECOND, () => [[path, 281]]);
    assert.deepEqual(opened(engine, 'frozen'), []);
  });

  it('still reports a slow sensor stuck far longer than a day of watching says it ever holds', () => {
    const engine = newEngine();
    const path = 'propulsion.raw_water.temperature';
    let value = 281;
    let t = run(engine, T0, T0 + 30 * HOUR, 10 * SECOND, (now) => {
      if ((now - T0) % (7 * MINUTE) === 0) value = value === 281 ? 281.25 : 281;
      return [[path, value]];
    });
    t = run(engine, t, t + 3 * HOUR, 10 * SECOND, () => [[path, 281.25]]);
    assert.ok(detectors(engine).includes(`frozen:${path}`), detectors(engine).join(', '));
  });

  it('counts only watched time toward the day a long hold is judged against', () => {
    const engine = newEngine();
    const path = 'propulsion.raw_water.temperature';
    let value = 281;
    const step = (now) => {
      if ((now - T0) % (7 * MINUTE) === 0) value = value === 281 ? 281.25 : 281;
      return [[path, value]];
    };
    // Five hours: enough runs to judge a short hold, not a day of them.
    let t = run(engine, T0, T0 + 5 * HOUR, 10 * SECOND, step);
    // Three days down, then fifty minutes on one reading: still an evening's
    // watching, not a day's.
    const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
    const later = t + 3 * 24 * HOUR;
    const restarted = newEngine({}, later);
    restarted.importState(saved, later);
    t = run(restarted, later, later + 50 * MINUTE, 10 * SECOND, () => [[path, 281]]);
    assert.deepEqual(opened(restarted, 'frozen'), []);
  });

  it('does not take a run that an outage interrupted for a value held', () => {
    const state = monitor.createPathState('environment.inside.cabin.temperature', T0);
    const options = { minIntervalMs: 1000, dropoutMinMs: 30000, dropoutFactor: 10 };
    let t = T0;
    for (let index = 0; index < 100; index += 1) monitor.observe(state, 290 + (index % 2), (t += SECOND), options);
    // Silent for two hours, then back with a new value.
    monitor.observe(state, 300, (t += 2 * HOUR), options);
    monitor.observe(state, 301, (t += SECOND), options);
    const record = state.runRecords[''];
    assert.equal(record.bins.slice(10).reduce((sum, value) => sum + value, 0), 0, 'no run of an hour or more');
  });
});

describe('watch learning: counters that show themselves by their resets', () => {
  it('takes a count no name says is one, that restarts from zero, for a counter, and stops judging its climb', () => {
    const engine = newEngine();
    const path = 'plugins.link.frames';
    let value = 1e6;
    let t = run(engine, T0, T0 + 30 * MINUTE, SECOND, () => [[path, (value += 1)]]);
    const kind = () => engine.inventory(t).paths.find((item) => item.path === path).kind;
    assert.notEqual(kind(), 'counter', 'a climb alone is never a counter');
    value = 0;
    t = run(engine, t, t + 10 * MINUTE, SECOND, () => [[path, (value += 1)]]);
    assert.equal(kind(), 'counter');
    t = run(engine, t, t + 2 * HOUR, SECOND, () => [[path, (value += 1)]]);
    assert.ok(!detectors(engine).some((key) => key.endsWith(path)), detectors(engine).join(', '));
  });

  it('does not take a reading that glitches to zero and comes straight back for a counter', () => {
    const state = monitor.createPathState('plugins.example.reading', T0);
    let t = T0;
    for (let index = 0; index < 100; index += 1) monitor.observe(state, 50 + index, (t += MINUTE), {});
    monitor.observe(state, 0, (t += MINUTE), {});
    for (let index = 0; index < 10; index += 1) monitor.observe(state, 151 + index, (t += MINUTE), {});
    assert.equal(monitor.isCounterState(state), false);
    assert.equal(state.resets, 0);
  });

  it('does not take a reading that drops to zero and stays there for a counter', () => {
    const state = monitor.createPathState('plugins.example.reading', T0);
    let t = T0;
    for (let index = 0; index < 100; index += 1) monitor.observe(state, 50 + index, (t += MINUTE), {});
    for (let index = 0; index < 20; index += 1) monitor.observe(state, 0, (t += MINUTE), {});
    assert.equal(monitor.isCounterState(state), false);
  });

  it('never takes a measurement, or a state code, for a counter by its resets', () => {
    for (const path of ['electrical.solar.main.panelPower', 'networking.lte.rssi', 'plugins.example.chargerState']) {
      const state = monitor.createPathState(path, T0);
      Object.assign(state, { kind: 'continuous', n: 100, rose: true, monotonic: false, resets: 2, falls: 0 });
      assert.equal(monitor.isCounterState(state), false, path);
    }
  });

  it('starts the evidence afresh for a save from before resets were told from falls', () => {
    const saved = { path: 'plugins.link.frames', kind: 'continuous', n: 5000, rose: true, monotonic: false, rises: 4999 };
    const state = monitor.importPathState(saved, T0);
    assert.equal(state.falls, 0);
    assert.equal(state.resets, 0);
    assert.equal(monitor.isCounterState(state), false);
  });
});

describe('watch learning: resets seen on a moored boat\'s link and modem', () => {
  it('takes a sequence number that restarts somewhere other than zero for a counter, without a level finding', () => {
    const engine = newEngine();
    const path = 'plugins.link.seq';
    let value = 1.7e9;
    let t = run(engine, T0, T0 + 30 * MINUTE, SECOND, () => [[path, (value += 7)]]);
    value = 1.1e9;
    t = run(engine, t, t + 30 * MINUTE, SECOND, () => [[path, (value += 7)]]);
    assert.equal(engine.inventory(t).paths.find((item) => item.path === path).kind, 'counter');
    assert.deepEqual(opened(engine, 'shift'), [], 'the restart is not a drop');
  });

  it('waits for a slow count that restarts from zero to tick again, rather than reporting the drop', () => {
    const engine = newEngine();
    const path = 'plugins.link.resends';
    let value = 5000;
    // One more every two minutes, then the link restarts: zero, and the next
    // one forty minutes later.
    let t = run(engine, T0, T0 + 2 * HOUR, 10 * SECOND, (now) => [[path, (now - T0) % (2 * MINUTE) === 0 ? (value += 1) : value]]);
    value = 0;
    t = run(engine, t, t + 40 * MINUTE, 10 * SECOND, () => [[path, value]]);
    t = run(engine, t, t + 30 * MINUTE, 10 * SECOND, (now) => [[path, (now - t) % (10 * MINUTE) === 0 ? (value += 1) : value]]);
    assert.deepEqual(opened(engine, 'shift'), []);
    assert.equal(engine.inventory(t).paths.find((item) => item.path === path).kind, 'counter');
  });

  it('takes a count that only climbs through a whole day for a counter, whatever its name', () => {
    const engine = newEngine();
    const path = 'networking.modem.usage.rx';
    let value = 3e8;
    let t = run(engine, T0, T0 + 20 * HOUR, MINUTE, () => [[path, (value += 15000)]]);
    const kind = () => engine.inventory(t).paths.find((item) => item.path === path).kind;
    assert.notEqual(kind(), 'counter', 'twenty hours of climbing are not yet a day');
    t = run(engine, t, t + 5 * HOUR, MINUTE, () => [[path, (value += 15000)]]);
    assert.equal(kind(), 'counter');
  });

  it('does not take a reading that climbs all day, with its noise, for a counter', () => {
    const state = monitor.createPathState('plugins.example.reading', T0);
    let t = T0;
    const rand = noise(67);
    // Climbing, as a measurement does: with its noise, now and then down.
    for (let index = 0; index < 26 * 60; index += 1) monitor.observe(state, 12 + index * 0.001 + 0.004 * rand(), (t += MINUTE), {});
    assert.equal(monitor.isCounterState(state), false);
  });

  it('learns again whether a saved counter falls, once', () => {
    const state = monitor.importPathState({ path: 'networking.lte.dataTotal', kind: 'continuous', n: 9000, rose: true, monotonic: false, rises: 8900 }, T0);
    assert.equal(state.monotonic, true);
    assert.equal(monitor.isCounterState(state), true);
    const again = monitor.importPathState(JSON.parse(JSON.stringify(monitor.exportPathState({ ...state, monotonic: false }))), T0);
    assert.equal(again.monotonic, false, 'a fall learned since is kept');
  });

  it('learns a daily figure\'s midnight step as its habit, without being told what the path is', () => {
    const engine = newEngine();
    const path = 'electrical.solar.main.maximumPowerYesterday';
    const rand = noise(66);
    // Yesterday's best power: one value all day, a new one each midnight.
    const values = Array.from({ length: 10 }, () => Math.round(200 + 150 * rand()));
    const daily = (now) => [[path, values[Math.floor((now - T0) / (24 * HOUR))]]];
    let t = run(engine, T0, T0 + 7 * 24 * HOUR, 2 * MINUTE, daily);
    const early = opened(engine, 'shift').filter((entry) => entry.path === path).length;
    assert.ok(early >= 1, 'its first steps are news');
    t = run(engine, t, t + 3 * 24 * HOUR, 2 * MINUTE, daily);
    assert.equal(opened(engine, 'shift').filter((entry) => entry.path === path).length, early, 'by now a step of its usual size is its habit');
  });

  it('gets used to a sensor that has spells of no value, and still reports one that lasts far longer', () => {
    const engine = newEngine();
    const path = 'environment.inside.bedroom.temperature';
    const rand = noise(10);
    // Out of range for eight minutes every three hours.
    const sample = (spellMs) => (now) => [[path, (now - T0) % (3 * HOUR) >= HOUR && (now - T0) % (3 * HOUR) < HOUR + spellMs ? null : 293 + 0.2 * rand()]];
    let t = run(engine, T0, T0 + 3 * HOUR + HOUR + 7 * MINUTE, 10 * SECOND, sample(8 * MINUTE));
    assert.ok(detectors(engine).includes(`dropout:${path}`), 'the first spell is reported');
    t = run(engine, t, T0 + 6 * 3 * HOUR, 10 * SECOND, sample(8 * MINUTE));
    const before = opened(engine, 'dropout').length;
    t = run(engine, t, t + 3 * 3 * HOUR, 10 * SECOND, sample(8 * MINUTE));
    assert.equal(opened(engine, 'dropout').length, before, 'later spells of the usual length are not');
    const start = T0 + Math.ceil((t - T0) / (3 * HOUR)) * 3 * HOUR + HOUR;
    t = run(engine, t, start + 40 * MINUTE, 10 * SECOND, (now) => [[path, now >= start ? null : 293 + 0.2 * rand()]]);
    const finding = engine.status().activeFindings.find((item) => item.detector === 'dropout');
    assert.ok(finding, 'forty minutes of it is news');
    assert.match(finding.message, /spells of no value/);
  });
});

describe('watch learning: how fast a counter counts', () => {
  const path = 'networking.modem.rxTotal';

  function steady(engine, from, to, perTenSeconds) {
    let value = 1e9;
    const t = run(engine, from, to, 10 * SECOND, (now) => {
      // Busier in the evening than at night, as traffic is.
      const hour = new Date(now).getUTCHours();
      value += perTenSeconds * (hour >= 16 && hour < 22 ? 1.5 : 0.5);
      return [[path, value]];
    });
    return { t, value };
  }

  it('says nothing for a week-normal pace, and reports a count far beyond its fastest', () => {
    const engine = newEngine();
    let { t, value } = steady(engine, T0, T0 + 26 * HOUR, 20000);
    assert.deepEqual(opened(engine, 'rate'), []);
    assert.deepEqual(opened(engine, 'shift'), [], 'a counter climbing is not a level shift');
    t = run(engine, t, t + 15 * MINUTE, 10 * SECOND, () => [[path, (value += 400000)]]);
    const finding = engine.status().activeFindings.find((item) => item.detector === 'rate');
    assert.ok(finding, detectors(engine).join(', '));
    assert.match(finding.title, /counting unusually fast/);
    assert.match(finding.message, /the fastest it counted in the past week/);
    // Back to its pace: cleared.
    t = run(engine, t, t + 30 * MINUTE, 10 * SECOND, () => [[path, (value += 10000)]]);
    assert.ok(!detectors(engine).includes(`rate:${path}`));
  });

  it('judges nothing before it has a day of the counter\'s pace', () => {
    const engine = newEngine();
    let { t, value } = steady(engine, T0, T0 + 3 * HOUR, 20000);
    run(engine, t, t + 15 * MINUTE, 10 * SECOND, () => [[path, (value += 400000)]]);
    assert.deepEqual(opened(engine, 'rate'), []);
  });
});

describe('watch learning: measurements are never state codes', () => {
  it('does not report a signal strength\'s new whole value as a new state', () => {
    const engine = newEngine();
    const path = 'networking.lte.rssi';
    // -42 and -43 dBm for the first hour: few values, all whole.
    let t = run(engine, T0, T0 + 60 * MINUTE, 10 * SECOND, (now) => [[path, (now / (10 * SECOND)) % 7 === 0 ? -43 : -42]]);
    t = run(engine, t, t + MINUTE, 10 * SECOND, () => [[path, -36]]);
    assert.deepEqual(opened(engine, 'newState'), []);
    assert.equal(engine.inventory(t).paths.find((item) => item.path === path).kind, 'continuous');
  });

  it('takes a path with a measurement unit for a measurement, from its metadata', () => {
    const engine = newEngine();
    const path = 'plugins.example.reading';
    engine.ingest(path, 3, T0, 'x');
    engine.setMeta(path, { units: 'dBm' });
    const t = run(engine, T0 + SECOND, T0 + 40 * MINUTE, 10 * SECOND, (now) => [[path, (now / (10 * SECOND)) % 3 === 0 ? 3 : 4]]);
    assert.equal(engine.inventory(t).paths.find((item) => item.path === path).kind, 'continuous');
  });

  it('moves a measurement a save had decided discrete to continuous', () => {
    const state = monitor.importPathState(
      { path: 'networking.lte.rsrp', kind: 'discrete', n: 500, distinct: [-70, -75], allInteger: true, seen: { '-70': 300, '-75': 200 } },
      T0
    );
    monitor.observe(state, -80, T0 + SECOND, { minIntervalMs: 1000 });
    assert.equal(state.kind, 'continuous');
  });

  it('still keeps the new-state check for a whole-number state code', () => {
    const engine = newEngine();
    const path = 'electrical.chargers.house.chargingState';
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, (now) => [[path, (now - T0) % (4 * MINUTE) < 2 * MINUTE ? 3 : 4]]);
    t = run(engine, t, t + MINUTE, 10 * SECOND, () => [[path, 9]]);
    assert.ok(detectors(engine).includes(`newState:${path}`), detectors(engine).join(', '));
  });
});

describe('watch learning: null is "no value"', () => {
  it('does not report a sensor that briefly sends null as changing to a new state', () => {
    const engine = newEngine();
    const rand = noise(6);
    const paths = ['environment.inside.bedroom.rssi', 'electrical.solar.main.yieldTotal', 'electrical.solar.main.load'];
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, () => [
      [paths[0], Math.round(-70 + 3 * rand())],
      [paths[1], 1378296000],
      [paths[2], 'on']
    ]);
    // A charger reconnecting sends null for everything once.
    t = run(engine, t, t + 10 * SECOND, 10 * SECOND, () => paths.map((path) => [path, null]));
    t = run(engine, t, t + 5 * MINUTE, 10 * SECOND, () => [
      [paths[0], Math.round(-70 + 3 * rand())],
      [paths[1], 1378296000],
      [paths[2], 'on']
    ]);
    assert.deepEqual(opened(engine, 'newState'), []);
    assert.deepEqual(detectors(engine), []);
  });

  it('reports a sensor that keeps sending null as having no value, and clears when it reads again', () => {
    const engine = newEngine();
    const path = 'environment.inside.bedroom.temperature';
    const rand = noise(8);
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, () => [[path, 293 + 0.2 * rand()]]);
    t = run(engine, t, t + 5 * MINUTE, 10 * SECOND, () => [[path, null]]);
    const finding = engine.status().activeFindings.find((item) => item.detector === 'dropout');
    assert.ok(finding, detectors(engine).join(', '));
    assert.match(finding.title, /has no value/);
    assert.match(finding.message, /null/);
    run(engine, t, t + MINUTE, 10 * SECOND, () => [[path, 293 + 0.2 * rand()]]);
    assert.ok(!detectors(engine).includes(`dropout:${path}`));
  });

  it('forgets null as a state from a save made before', () => {
    const state = monitor.importPathState(
      { path: 'electrical.solar.main.load', kind: 'discrete', n: 500, seen: { on: 499, null: 1 }, lastValue: 'null' },
      T0
    );
    assert.deepEqual(state.seen, { on: 499 });
    assert.equal(state.lastValue, undefined);
  });
});

describe('watch learning: day and night for everything solar', () => {
  const position = { latitude: 60.28, longitude: 25.0 };
  const panel = 'electrical.solar.main.panelVoltage';
  // Open-circuit voltage comes with the first light, well before sunrise,
  // and is near its full value long before the sun is up.
  const voltage = (t, rand) => {
    const elevation = sunElevationDeg(position.latitude, position.longitude, t);
    if (elevation < -6) return 0;
    return 19.5 * Math.min(1, (elevation + 6) / 3) + 0.05 * rand();
  };

  it('works out the sun from the position: noon, night, and a midsummer night that is barely dark', () => {
    assert.ok(Math.abs(sunElevationDeg(60.28, 25, Date.parse('2026-11-16T10:20:00Z')) - 10.9) < 0.5);
    assert.ok(sunElevationDeg(60.28, 25, Date.parse('2026-11-16T22:00:00Z')) < -40);
    const midsummer = sunElevationDeg(60.28, 25, Date.parse('2026-06-21T22:00:00Z'));
    assert.ok(midsummer > -7 && midsummer < -5, String(midsummer));
  });

  it('does not report the panels waking at dawn and sleeping at dusk', () => {
    const start = Date.parse('2026-11-15T16:00:00Z');
    const engine = newEngine({}, start);
    const rand = noise(12);
    const t = run(engine, start, start + 26 * HOUR, 10 * SECOND, (now) => [
      ['navigation.position', position, 'gps'],
      [panel, voltage(now, rand)]
    ]);
    const labels = engine.status().regimeChanges.map((change) => change.label);
    assert.ok(labels.includes('Twilight') && labels.includes('Sun up') && labels.includes('Sun down'), labels.join(', '));
    assert.deepEqual(engine.status().incidents.flatMap((incident) => incident.findings).filter((entry) => entry.path === panel), []);
    assert.equal(engine.inventory(t).capabilities.find((item) => item.id === 'regimes').available, true);
  });

  it('still reports panels that go dead in the middle of the day', () => {
    const start = Date.parse('2026-11-16T07:00:00Z');
    const engine = newEngine({}, start);
    const rand = noise(13);
    let t = run(engine, start, Date.parse('2026-11-16T10:00:00Z'), 10 * SECOND, (now) => [
      ['navigation.position', position, 'gps'],
      [panel, voltage(now, rand)]
    ]);
    t = run(engine, t, t + 2 * MINUTE, 10 * SECOND, () => [['navigation.position', position, 'gps'], [panel, 0.4]]);
    assert.ok(detectors(engine).includes(`shift:${panel}`), detectors(engine).join(', '));
  });
});

describe('watch learning: across a restart', () => {
  it('keeps the habits and the runs it learned', () => {
    const engine = newEngine();
    const path = 'environment.inside.cabin.temperature';
    const rand = noise(3);
    let t = run(engine, T0, T0 + 40 * MINUTE, 5 * SECOND, () => [[path, 293 + 0.3 * rand()]]);
    const state = engine.exportState(t).paths.find((item) => item.path === path);
    habits.follow(state, 'shift+', 9, true, t - 20 * HOUR);
    habits.follow(state, 'shift+', 0, false, t - 19 * HOUR);
    const saved = JSON.parse(JSON.stringify({ ...engine.exportState(t), paths: [state] }));
    const restarted = newEngine();
    restarted.importState(saved, t);
    t = run(restarted, t, t + 6 * MINUTE, 5 * SECOND, () => [[path, 293.123]]);
    const again = restarted.exportState(t).paths.find((item) => item.path === path);
    assert.equal(again.habits['shift+'].past.length, 1);
    assert.ok(again.runRecords[''].count >= 30);
    assert.ok(detectors(restarted).includes(`frozen:${path}`), 'the runs it learned before the restart judge a freeze after it');
  });
});

describe('watch learning: a restart is not news', () => {
  function restart(engine, t, gapMs = MINUTE) {
    const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
    const later = t + gapMs;
    const next = newEngine({}, later);
    assert.equal(next.importState(saved, later), true);
    return { engine: next, t: later };
  }

  it('carries an open finding over a restart as the same finding, in the same incident', () => {
    const rand = noise(21);
    const path = 'electrical.batteries.house.voltage';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 12.9 + 0.02 * rand()]]);
    t = run(engine, t, t + MINUTE, SECOND, () => [[path, 11.9 + 0.02 * rand()]]);
    const before = engine.status().activeFindings.find((item) => item.detector === 'shift');
    assert.ok(before);
    ({ engine, t } = restart(engine, t));
    t = run(engine, t, t + MINUTE, SECOND, () => [[path, 11.9 + 0.02 * rand()]]);
    const after = engine.status().activeFindings.find((item) => item.detector === 'shift');
    assert.ok(after, 'still low, still reported');
    assert.equal(after.openedAt, before.openedAt);
    assert.equal(after.incidentId, before.incidentId);
    assert.equal(engine.status().incidents.length, 1, 'not a second incident');
    assert.equal(engine.notificationStates().get(path).state, 'alert', 'its notification is raised again');
    assert.equal(engine.report(t).findings, 1);
  });

  it('closes a carried finding that does not come back, as of the restart', () => {
    const rand = noise(22);
    const path = 'electrical.batteries.house.voltage';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 12.9 + 0.02 * rand()]]);
    t = run(engine, t, t + MINUTE, SECOND, () => [[path, 11.9 + 0.02 * rand()]]);
    let restartedAt;
    ({ engine, t } = restart(engine, t));
    restartedAt = t;
    t = run(engine, t, t + 22 * MINUTE, SECOND, () => [[path, 12.9 + 0.02 * rand()]]);
    const incident = engine.status().incidents[0];
    assert.equal(incident.status, 'resolved');
    assert.equal(incident.interrupted, true);
    assert.equal(incident.findings[0].clearedAt, restartedAt);
    assert.equal(engine.report(t).findings, 1, 'the report counts it, once');
  });

  it('opens a new incident for a finding back after a long time down', () => {
    const rand = noise(23);
    const path = 'electrical.batteries.house.voltage';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 12.9 + 0.02 * rand()]]);
    t = run(engine, t, t + MINUTE, SECOND, () => [[path, 11.9 + 0.02 * rand()]]);
    ({ engine, t } = restart(engine, t, 45 * MINUTE));
    assert.equal(engine.status().incidents[0].status, 'resolved', 'three quarters of an hour down: what was open then is closed');
    assert.equal(engine.report(t).findings, 1, 'and logged, so the report counts it');
    t = run(engine, t, t + 3 * MINUTE, SECOND, () => [[path, 11.9 + 0.02 * rand()]]);
    assert.equal(engine.status().incidents.length, 2);
  });

  it('does not count states re-announced at start-up as switching, restart after restart', () => {
    const path = 'control.remoteController.hh.linkUp';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 7 * HOUR, 10 * SECOND, () => [[path, true]]);
    for (let index = 0; index < 3; index += 1) {
      ({ engine, t } = restart(engine, t));
      // The link reads down until it has connected.
      t = run(engine, t, t + 20 * SECOND, 5 * SECOND, (now) => [[path, now - t < 10 * SECOND ? false : true]]);
      t = run(engine, t, t + 5 * MINUTE, 10 * SECOND, () => [[path, true]]);
    }
    assert.deepEqual(opened(engine, 'cycling'), []);
  });

  it('reports a new state seen at start-up only if the path still holds it afterward', () => {
    const camera = 'vision.system.activeCamera';
    const link = 'plugins.link.status';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, () => [[camera, 'aft'], [link, 'up']]);
    ({ engine, t } = restart(engine, t));
    t = run(engine, t, t + 30 * SECOND, 5 * SECOND, (now) => [[camera, 'forward'], [link, now - t < 15 * SECOND ? 'connecting' : 'up']]);
    assert.deepEqual(detectors(engine), [], 'nothing during start-up');
    t = run(engine, t, t + 3 * MINUTE, 10 * SECOND, () => [[camera, 'forward'], [link, 'up']]);
    assert.deepEqual(detectors(engine), [], 'nor while the camera may still go back to where it was');
    t = run(engine, t, t + 13 * MINUTE, 10 * SECOND, () => [[camera, 'forward'], [link, 'up']]);
    assert.deepEqual(detectors(engine), [`newState:${camera}`], 'the camera that stayed is news; the link that passed through "connecting" is not');
  });

  it('does not report a link that reconnects after a restart, and still reports one that stays bad', () => {
    const rand = noise(24);
    const rtt = 'networking.edgeLink.boat.rtt';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[rtt, 0.05 + 0.002 * rand()]]);
    ({ engine, t } = restart(engine, t));
    const start = t;
    // A minute of high round-trip time while the link comes back.
    t = run(engine, t, t + 3 * MINUTE, SECOND, (now) => [[rtt, now - start < MINUTE ? 0.4 : 0.05 + 0.002 * rand()]]);
    assert.deepEqual(opened(engine, 'shift'), []);
    ({ engine, t } = restart(engine, t));
    // It has been seen to settle within a minute or so of being heard
    // again: its start-up now allows for that, and is still over in
    // minutes.
    const saved = engine.exportState(t);
    const restartLearning = require('../lib/watch/restarts.cjs');
    const startup = restartLearning.startupFor(saved.restarts, 'default', saved.paths.find((item) => item.path === rtt).restartSettles);
    assert.ok(startup > 2 * MINUTE && startup < 4 * MINUTE, String(startup));
    t = run(engine, t, t + startup + MINUTE, SECOND, () => [[rtt, 0.4 + 0.002 * rand()]]);
    assert.ok(detectors(engine).includes(`shift:${rtt}`), 'still bad once start-up is over: reported');
  });

  it('does not count a plugin that takes minutes to settle after a restart as switching', () => {
    const path = 'navigation.underKeel.state';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 7 * HOUR, 10 * SECOND, () => [[path, 'alarm']]);
    const before = engine.exportState(t).paths.find((item) => item.path === path).transitionTotal;
    for (let index = 0; index < 3; index += 1) {
      ({ engine, t } = restart(engine, t));
      const start = t;
      // "off" until it has worked out its first clearance, five minutes in.
      t = run(engine, t, t + 12 * MINUTE, 10 * SECOND, (now) => [[path, now - start < 5 * MINUTE ? 'off' : 'alarm']]);
    }
    assert.equal(engine.exportState(t).paths.find((item) => item.path === path).transitionTotal, before);
    assert.deepEqual(opened(engine, 'cycling'), []);
  });

  it('counts one change for a state path that does not go back after a restart', () => {
    const path = 'electrical.charger.house.chargingMode';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, () => [[path, 'bulk']]);
    const before = engine.exportState(t).paths.find((item) => item.path === path).transitionTotal;
    ({ engine, t } = restart(engine, t));
    // Restarted again while still on the detour: it is judged from "bulk", not "off".
    t = run(engine, t, t + 5 * MINUTE, 10 * SECOND, () => [[path, 'off']]);
    ({ engine, t } = restart(engine, t));
    t = run(engine, t, t + 20 * MINUTE, 10 * SECOND, () => [[path, 'off']]);
    assert.equal(engine.exportState(t).paths.find((item) => item.path === path).transitionTotal, before + 1);
  });

  it('says how long a sensor has had no value, across a restart', () => {
    const rand = noise(25);
    const path = 'navigation.underKeel.clearance';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, () => [[path, 3 + 0.05 * rand()]]);
    t = run(engine, t, t + 30 * MINUTE, 10 * SECOND, () => [[path, null]]);
    ({ engine, t } = restart(engine, t));
    // Reported once reacquiring after the restart is over (15 minutes).
    t = run(engine, t, t + 16 * MINUTE, 10 * SECOND, () => [[path, null]]);
    const finding = engine.status().activeFindings.find((item) => item.detector === 'dropout');
    assert.ok(finding, detectors(engine).join(', '));
    assert.match(finding.message, /No reading for 4[67] min/);
  });

  it('does not learn a link\'s reconnection at every restart as a habit of the link', () => {
    const rand = noise(26);
    const rtt = 'networking.edgeLink.boat.rtt';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[rtt, 0.05 + 0.002 * rand()]]);
    for (let index = 0; index < 6; index += 1) {
      ({ engine, t } = restart(engine, t));
      const start = t;
      t = run(engine, t, t + 2 * HOUR, 5 * SECOND, (now) => [[rtt, now - start < 75 * SECOND ? 0.4 : 0.05 + 0.002 * rand()]]);
    }
    const state = engine.exportState(t).paths.find((item) => item.path === rtt);
    assert.equal(habits.usual(state, 'shift+', t), undefined, 'the restarts\' spikes are not the link\'s');
    const start = t;
    t = run(engine, t, t + 2 * MINUTE, SECOND, (now) => [[rtt, now - start < 90 * SECOND ? 0.4 : 0.05]]);
    assert.ok(opened(engine, 'shift').some((entry) => entry.path === rtt), 'the same spike without a restart is still news');
  });

  it('carries a finding whose condition came back just before the deadline and needed its persistence after it', () => {
    const rand = noise(56);
    const path = 'electrical.batteries.house.voltage';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 12.9 + 0.02 * rand()]]);
    t = run(engine, t, t + MINUTE, SECOND, () => [[path, 11.9 + 0.02 * rand()]]);
    const before = engine.status().activeFindings.find((item) => item.detector === 'shift');
    ({ engine, t } = restart(engine, t));
    const restartedAt = t;
    // Normal until five seconds before the 20 minutes are up, then low again.
    t = run(engine, t, restartedAt + 20 * MINUTE - 5 * SECOND, SECOND, () => [[path, 12.9 + 0.02 * rand()]]);
    t = run(engine, t, t + MINUTE, SECOND, () => [[path, 11.9 + 0.02 * rand()]]);
    const after = engine.status().activeFindings.find((item) => item.detector === 'shift');
    assert.ok(after);
    assert.equal(after.openedAt, before.openedAt, 'the same finding');
    assert.equal(engine.status().incidents.length, 1);
  });

  it('keeps a departure that a short restart cut in two as one episode', () => {
    const state = monitor.createPathState('networking.edgeLink.boat.jitter', T0);
    habits.follow(state, 'shift+', 9, true, T0);
    const saved = JSON.parse(JSON.stringify(monitor.exportPathState(state)));
    const restored = monitor.importPathState(saved, T0 + MINUTE, { savedAt: T0 });
    habits.follow(restored, 'shift+', 12, true, T0 + 2 * MINUTE);
    habits.follow(restored, 'shift+', 0, false, T0 + 3 * MINUTE);
    assert.deepEqual(restored.habits['shift+'].past, [[T0 + 3 * MINUTE, 12, 3 * MINUTE]]);
    const late = monitor.importPathState(saved, T0 + 2 * HOUR, { savedAt: T0 });
    assert.equal(late.habits && late.habits['shift+'] && late.habits['shift+'].open, undefined, 'after a long time down it is not known to be the same one');
  });

  it('applies an operating state as it stands when start-up is over, not each value on the way', () => {
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, () => [['navigation.state', 'moored']]);
    ({ engine, t } = restart(engine, t));
    t = run(engine, t, t + 20 * SECOND, 5 * SECOND, (now) => [['navigation.state', now - t < 10 * SECOND ? 'motoring' : 'moored']]);
    t = run(engine, t, t + 3 * MINUTE, 10 * SECOND, () => [['navigation.state', 'moored']]);
    assert.deepEqual(engine.status().regimeChanges, []);
  });
});

describe('watch learning: review of the fourth commit', () => {
  function restart(engine, t, gapMs = MINUTE) {
    const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
    const later = t + gapMs;
    const next = newEngine({}, later);
    next.importState(saved, later);
    return { engine: next, t: later };
  }

  it('does not call a sensor stuck while it sends no value, or while it is silent', () => {
    for (const quiet of [null, undefined]) {
      const engine = newEngine();
      const rand = noise(51);
      const path = 'environment.inside.engineRoom.temperature';
      let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 310 + 0.3 * rand()]]);
      t = run(engine, t, t + 40 * SECOND, SECOND, () => [[path, 310.5]]);
      t = run(engine, t, t + 15 * MINUTE, SECOND, () => (quiet === null ? [[path, null]] : []));
      assert.deepEqual(opened(engine, 'frozen'), [], quiet === null ? 'no value' : 'silent');
      assert.ok(detectors(engine).includes(`dropout:${path}`), 'its dropout reports it');
    }
  });

  it('clears a stuck finding when the sensor then falls silent, and reports the silence', () => {
    const engine = newEngine();
    const rand = noise(52);
    const path = 'environment.inside.engineRoom.temperature';
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 310 + 0.3 * rand()]]);
    t = run(engine, t, t + 7 * MINUTE, SECOND, () => [[path, 310.5]]);
    assert.ok(detectors(engine).includes(`frozen:${path}`), 'stuck while it repeats');
    t = run(engine, t, t + 3 * MINUTE, SECOND, () => []);
    assert.ok(!detectors(engine).includes(`frozen:${path}`), 'not while it is silent');
    assert.ok(detectors(engine).includes(`dropout:${path}`));
  });

  it('keeps following an episode carried over a restart after start-up', () => {
    const rand = noise(53);
    const path = 'networking.edgeLink.boat.jitter';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 5 + rand()]]);
    // A departure in progress when the plugin restarts, which grows after.
    t = run(engine, t, t + MINUTE, SECOND, () => [[path, 15 + rand()]]);
    const before = engine.exportState(t).paths.find((item) => item.path === path).habits['shift+'].open.peak;
    ({ engine, t } = restart(engine, t));
    t = run(engine, t, t + 5 * MINUTE, SECOND, () => [[path, 40 + rand()]]);
    const after = engine.exportState(t).paths.find((item) => item.path === path).habits['shift+'].open.peak;
    assert.ok(after > before, `${after} > ${before}`);
  });

  it('carries a long-dead sensor\'s dropout over a restart, rather than reporting it anew', () => {
    const rand = noise(55);
    const path = 'navigation.underKeel.clearance';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, () => [[path, 3 + 0.05 * rand()]]);
    t = run(engine, t, t + 30 * MINUTE, 10 * SECOND, () => [[path, null]]);
    const before = engine.status().activeFindings.find((item) => item.detector === 'dropout');
    assert.ok(before);
    ({ engine, t } = restart(engine, t));
    t = run(engine, t, t + 25 * MINUTE, 10 * SECOND, () => [[path, null]]);
    const after = engine.status().activeFindings.find((item) => item.detector === 'dropout');
    assert.ok(after);
    assert.equal(after.openedAt, before.openedAt, 'the same finding');
    assert.equal(engine.status().incidents.length, 1, 'not a new incident');
  });

  it('waits for a sensor a plugin takes minutes to hear again after a restart, and reports one that never comes back', () => {
    const rand = noise(54);
    const slow = 'environment.inside.bedroom.temperature';
    const dead = 'environment.inside.cabin.temperature';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, () => [[slow, 280 + 0.1 * rand()], [dead, 290 + 0.1 * rand()]]);
    ({ engine, t } = restart(engine, t));
    const start = t;
    // The server re-announces both sensors' last values as it starts; then
    // the bedroom sensor sends no value for six minutes and the cabin's never
    // reads again.
    const last = engine.exportState(t).paths;
    const cached = (path) => last.find((item) => item.path === path).last;
    engine.ingest(slow, cached(slow), t, 'bedroom');
    engine.ingest(dead, cached(dead), t, 'cabin');
    t = run(engine, t + SECOND, t + 12 * MINUTE, 10 * SECOND, (now) => [[slow, now - start < 6 * MINUTE ? null : 280 + 0.1 * rand()]]);
    assert.deepEqual(opened(engine, 'dropout'), [], 'nothing while they are reacquired');
    t = run(engine, t, start + 16 * MINUTE, 10 * SECOND, () => [[slow, 280 + 0.1 * rand()]]);
    assert.deepEqual(detectors(engine), [`dropout:${dead}`], 'the one that never came back is reported once reacquiring is over');
  });

  it('still reports a new state seen on a restart detour after another restart', () => {
    const camera = 'vision.system.activeCamera';
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, () => [[camera, 'aft']]);
    ({ engine, t } = restart(engine, t));
    t = run(engine, t, t + 5 * MINUTE, 10 * SECOND, () => [[camera, 'forward']]);
    ({ engine, t } = restart(engine, t));
    t = run(engine, t, t + 20 * MINUTE, 10 * SECOND, () => [[camera, 'forward']]);
    assert.ok(opened(engine, 'newState').some((entry) => entry.path === camera), detectors(engine).join(', '));
  });
});

describe('watch learning: a charger as this boat names it, and one that flaps', () => {
  const mode = 'electrical.charger.house.chargingMode';
  const voltage = 'electrical.victron.dcdc.voltageIn';

  it('takes electrical.charger.<id>.chargingMode for an operating state of the electrical paths', () => {
    const engine = newEngine();
    const rand = noise(31);
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, () => [[mode, 'bulk'], [voltage, 13.9 + 0.02 * rand()]]);
    // The charger stops at dusk and the battery settles lower: expected.
    t = run(engine, t, t + 20 * MINUTE, 10 * SECOND, () => [[mode, 'off'], [voltage, 13.3 + 0.02 * rand()]]);
    assert.ok(engine.status().regimeChanges.some((change) => change.path === mode && change.to === 'off'));
    assert.deepEqual(opened(engine, 'shift'), []);
  });

  it('does not keep the electrical paths re-learning all day while the charger hunts', () => {
    const engine = newEngine();
    const rand = noise(32);
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, () => [[mode, 'off'], [voltage, 13.3 + 0.02 * rand()]]);
    // Hunting between bulk and off every 20 s, for three hours.
    t = run(engine, t, t + 3 * HOUR, 10 * SECOND, (now) => [[mode, Math.floor(now / (20 * SECOND)) % 2 ? 'bulk' : 'off'], [voltage, 13.6 + 0.02 * rand()]]);
    const changes = engine.status().regimeChanges.filter((change) => change.path === mode).length;
    assert.ok(changes <= GATE_LIMIT, `${changes} operating changes`);
    assert.equal(engine.inventory(t).paths.find((item) => item.path === voltage).role, 'watching', 'still watched while the charger hunts');
    // It settles: bulk for good, applied once it has held.
    t = run(engine, t, t + 15 * MINUTE, 10 * SECOND, () => [[mode, 'bulk'], [voltage, 13.9 + 0.02 * rand()]]);
    assert.equal(engine.status().regimeChanges[0].to, 'bulk');
  });
});

describe('watch learning: review of the first two commits', () => {
  it('forms a habit of a minute\'s spike every quarter of an hour', () => {
    const state = monitor.createPathState('networking.edgeLink.boat.packetLoss', T0);
    let t = T0;
    for (let index = 0; index < 60; index += 1) {
      habits.follow(state, 'shift+', 20, true, t);
      habits.follow(state, 'shift+', 0, false, t + MINUTE);
      t += 15 * MINUTE;
    }
    const usual = habits.usual(state, 'shift+', t);
    assert.ok(usual, 'fifteen hours of it is a habit');
    habits.follow(state, 'shift+', 20, true, t);
    assert.equal(habits.judge(state, 'shift+', 20, t).beyond, false);
  });

  it('reports a sensor that comes back from an outage stuck on the value it had', () => {
    const engine = newEngine();
    const rand = noise(41);
    const path = 'environment.inside.engineRoom.temperature';
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 310 + 0.3 * rand()]]);
    t = run(engine, t, t + 2 * SECOND, SECOND, () => [[path, 310.5]]);
    t = run(engine, t, t + 3 * MINUTE, SECOND, () => []);
    t = run(engine, t, t + 8 * MINUTE, SECOND, () => [[path, 310.5]]);
    assert.ok(detectors(engine).includes(`frozen:${path}`), detectors(engine).join(', '));
  });

  it('judges a value held across an operating change from the change, not never', () => {
    const engine = newEngine();
    const rand = noise(42);
    const rpm = 'propulsion.main.revolutions';
    const path = 'propulsion.main.oilPressure';
    let t = run(engine, T0, T0 + 60 * MINUTE, SECOND, () => [[rpm, 30], [path, 300000 + 2000 * rand()]]);
    t = run(engine, t, t + 2 * SECOND, SECOND, () => [[rpm, 30], [path, 301234]]);
    // The engine is stopped and started again around the frozen reading.
    t = run(engine, t, t + 30 * SECOND, SECOND, () => [[rpm, 0], [path, 301234]]);
    t = run(engine, t, t + 30 * MINUTE, SECOND, () => [[rpm, 30], [path, 301234]]);
    assert.ok(detectors(engine).includes(`frozen:${path}`), detectors(engine).join(', '));
  });

  it('follows one receiver for day and night, not a faulty second one', () => {
    const start = Date.parse('2026-11-16T10:00:00Z');
    const engine = newEngine({}, start);
    const home = { latitude: 60.28, longitude: 25.0 };
    // A second receiver that places the boat on the far side of the world.
    const away = { latitude: 60.28, longitude: -155.0 };
    run(engine, start, start + 2 * HOUR, 10 * SECOND, () => [
      ['navigation.position', home, 'gps1'],
      ['navigation.position', away, 'gps2']
    ]);
    const changes = engine.status().regimeChanges.filter((change) => change.path === 'watchkeeper.daylight');
    assert.deepEqual(changes, [], 'it stays day at home');
  });

  it('reports a counter that counts after a week of not counting at all', () => {
    // Listed, so it is a counter before it has ever moved.
    const path = 'plugins.example.pumpCount';
    const engine = newEngine({ watchCounterPaths: [path] });
    let value = 12;
    let t = run(engine, T0, T0 + 26 * HOUR, MINUTE, () => [[path, value]]);
    t = run(engine, t, t + 15 * MINUTE, 10 * SECOND, () => [[path, (value += 1)]]);
    const finding = engine.status().activeFindings.find((item) => item.detector === 'rate');
    assert.ok(finding, detectors(engine).join(', '));
    assert.match(finding.message, /after not counting at all in the past week/);
  });
});

describe('watch learning: a transponder that rounds its own position', () => {
  it('does not take a fix rounded to a few decimals, between precise ones, for a jump', () => {
    const engine = newEngine();
    const precise = { latitude: 60.28056333333333, longitude: 22.28656 };
    let t = run(engine, T0, T0 + 10 * MINUTE, SECOND, () => [['navigation.position', precise, 'Arabella AIS.AI']]);
    // As it starts: 60.28, 22.285 - 106 m from the boat by its rounding alone.
    engine.ingest('navigation.position', { latitude: 60.28, longitude: 22.285 }, t + 10, 'Arabella AIS.AI');
    engine.ingest('navigation.position', precise, t + 30, 'Arabella AIS.AI');
    t = run(engine, t + SECOND, t + MINUTE, SECOND, () => [['navigation.position', precise, 'Arabella AIS.AI']]);
    assert.deepEqual(opened(engine, 'gnss.jump'), []);
  });

  it('still reports a jump between fixes that only look rounded, once the next fix stays there', () => {
    // As numbers, "60.0000" and "60.0100" are 60 and 60.01: no rounding is to be read into that.
    const engine = newEngine();
    let t = run(engine, T0, T0 + 10 * MINUTE, SECOND, () => [['navigation.position', { latitude: 60, longitude: 22.123456 }, 'gps']]);
    t = run(engine, t, t + 30 * SECOND, SECOND, () => [['navigation.position', { latitude: 60.01, longitude: 22.123456 }, 'gps']]);
    assert.ok(opened(engine, 'gnss.jump').length > 0, detectors(engine).join(', '));
  });

  it('still reports an eastward jump from a fix with a coarse latitude', () => {
    const engine = newEngine();
    let t = run(engine, T0, T0 + 10 * MINUTE, SECOND, () => [['navigation.position', { latitude: 60.28, longitude: 22.123456 }, 'gps']]);
    t = run(engine, t, t + 30 * SECOND, SECOND, () => [['navigation.position', { latitude: 60.280001, longitude: 22.132456 }, 'gps']]);
    assert.ok(opened(engine, 'gnss.jump').length > 0, detectors(engine).join(', '));
    assert.match(opened(engine, 'gnss.jump')[0].message, /49\d m between fixes/, 'the whole distance, not a reduced one');
  });

  it('reports a jump whose source then falls silent', () => {
    const engine = newEngine();
    let t = run(engine, T0, T0 + 10 * MINUTE, SECOND, () => [['navigation.position', { latitude: 60.28056333333333, longitude: 22.28656 }, 'gps']]);
    engine.ingest('navigation.position', { latitude: 60.29056333333333, longitude: 22.28656 }, t + SECOND, 'gps');
    t = run(engine, t + 2 * SECOND, t + 20 * SECOND, SECOND, () => []);
    assert.ok(opened(engine, 'gnss.jump').length > 0, detectors(engine).join(', '));
  });

  it('keeps each receiver\'s jump to itself', () => {
    const engine = newEngine();
    const home = { latitude: 60.28056333333333, longitude: 22.28656 };
    const away = { latitude: 60.29056333333333, longitude: 22.28656 };
    let t = run(engine, T0, T0 + 10 * MINUTE, SECOND, () => [['navigation.position', home, 'a'], ['navigation.position', home, 'b']]);
    // a jumps and stays; b jumps too before a's next fix, then comes back.
    engine.ingest('navigation.position', away, t, 'a');
    engine.ingest('navigation.position', away, t + 100, 'b');
    engine.ingest('navigation.position', home, t + 200, 'b');
    t = run(engine, t + SECOND, t + 30 * SECOND, SECOND, () => [['navigation.position', away, 'a'], ['navigation.position', home, 'b']]);
    const jumps = opened(engine, 'gnss.jump');
    assert.ok(jumps.length > 0, 'a\'s jump is reported');
  });

  it('reports a jump whose next fix stays put after the wait, whichever comes first, the fix or the tick', () => {
    const gnss = require('../lib/watch/gnss.cjs');
    const options = { gnssJumpMinMetres: 100, gnssMaxSpeedKn: 40, eventHoldMs: 10 * MINUTE };
    for (const tickFirst of [false, true]) {
      const state = gnss.createGnssState();
      gnss.observeGnss(state, 'navigation.position', { latitude: 0, longitude: 0 }, T0, 'gps', options);
      gnss.observeGnss(state, 'navigation.position', { latitude: 0.001, longitude: 0 }, T0 + SECOND, 'gps', options);
      // The next fix, 6.1 s on, repeats the jumped position: from the first
      // fix that is "only" 35 kn, but the vessel did not come back.
      const at = T0 + 7100;
      if (tickFirst) gnss.evaluateGnss(state, at, options);
      gnss.observeGnss(state, 'navigation.position', { latitude: 0.001, longitude: 0 }, at, 'gps', options);
      const indicators = gnss.evaluateGnss(state, at + SECOND, options);
      assert.equal(indicators.jump && indicators.jump.active, true, tickFirst ? 'tick first' : 'fix first');
    }
  });

  it('waits for a slow receiver\'s own next fix before calling its bad fix a jump', () => {
    const engine = newEngine();
    const home = { latitude: 60.28056333333333, longitude: 22.28656 };
    const off = { latitude: 60.29056333333333, longitude: 22.28656 };
    // a reports every 10 s, b every second.
    let t = run(engine, T0, T0 + 10 * MINUTE, SECOND, (now) => [
      ...((now - T0) % (10 * SECOND) === 0 ? [['navigation.position', home, 'a']] : []),
      ['navigation.position', home, 'b']
    ]);
    // One bad fix from a, and its next one, 10 s later, is back home.
    const start = t + (10 * SECOND - ((t - T0) % (10 * SECOND)));
    t = run(engine, t, start + 31 * SECOND, SECOND, (now) => [
      ...((now - T0) % (10 * SECOND) === 0 ? [['navigation.position', now === start ? off : home, 'a']] : []),
      ['navigation.position', home, 'b']
    ]);
    assert.deepEqual(opened(engine, 'gnss.jump'), []);
  });

  it('learns a receiver\'s slower rate, and waits for its next fix by it', () => {
    const engine = newEngine();
    const home = { latitude: 60.28056333333333, longitude: 22.28656 };
    const off = { latitude: 60.29056333333333, longitude: 22.28656 };
    // One fix a second, then one every ten seconds for good.
    let t = run(engine, T0, T0 + 5 * MINUTE, SECOND, () => [['navigation.position', home, 'gps']]);
    t = run(engine, t, t + 10 * MINUTE, 10 * SECOND, () => [['navigation.position', home, 'gps']]);
    // One bad fix, and the next one, ten seconds later, is back home.
    engine.ingest('navigation.position', off, t, 'gps');
    t = run(engine, t + 10 * SECOND, t + 40 * SECOND, 10 * SECOND, () => [['navigation.position', home, 'gps']]);
    assert.deepEqual(opened(engine, 'gnss.jump'), []);
  });

  it('holds a jump confirmed late from when it was confirmed', () => {
    const gnss = require('../lib/watch/gnss.cjs');
    const options = { gnssJumpMinMetres: 100, gnssMaxSpeedKn: 40, eventHoldMs: 10 * MINUTE };
    const state = gnss.createGnssState();
    state.fixInterval = 5 * MINUTE;
    gnss.observeGnss(state, 'navigation.position', { latitude: 60, longitude: 22 }, T0, 'slow', options);
    gnss.observeGnss(state, 'navigation.position', { latitude: 60.1, longitude: 22 }, T0 + 5 * MINUTE, 'slow', options);
    // No next fix: confirmed after three intervals, fifteen minutes on.
    const indicators = gnss.evaluateGnss(state, T0 + 20 * MINUTE + SECOND, options);
    assert.equal(indicators.jump && indicators.jump.active, true);
    assert.equal(indicators.jump.evidence.detectedAt, T0 + 5 * MINUTE);
  });

  it('still reports a real jump between precise fixes', () => {
    const engine = newEngine();
    let t = run(engine, T0, T0 + 10 * MINUTE, SECOND, () => [['navigation.position', { latitude: 60.28056333333333, longitude: 22.28656 }, 'gps']]);
    t = run(engine, t, t + 30 * SECOND, SECOND, () => [['navigation.position', { latitude: 60.29056333333333, longitude: 22.28656 }, 'gps']]);
    assert.ok(opened(engine, 'gnss.jump').length > 0, detectors(engine).join(', '));
  });
});

describe('watch learning: a sender that rounds its readings', () => {
  it('does not report a reading rounded to whole percent stepping once', () => {
    const engine = newEngine();
    const path = 'environment.nano.sd.utilisation';
    // Disk use, sent as a ratio to two decimals: 0.29 for hours, then 0.3.
    let t = run(engine, T0, T0 + 3 * HOUR, 10 * SECOND, () => [[path, 0.29]]);
    t = run(engine, t, t + 10 * MINUTE, 10 * SECOND, () => [[path, 0.3]]);
    assert.deepEqual(opened(engine, 'shift'), []);
  });

  it('keeps the learned rounding through a floating-point artefact', () => {
    const state = monitor.createPathState('environment.nano.sd.utilisation', T0);
    let t = T0;
    for (let index = 0; index < 40; index += 1) monitor.observe(state, 0.29, (t += 10 * SECOND), { minIntervalMs: 1000 });
    monitor.observe(state, 0.29000000000000004, (t += 10 * SECOND), { minIntervalMs: 1000 });
    assert.equal(state.maxDecimals, 2);
    assert.equal(monitor.resolutionOf(state), 0.01);
  });

  it('learns no rounding from a sender most of whose readings are computed in floating point', () => {
    const state = monitor.createPathState('environment.inside.cabin.temperature', T0);
    let t = T0;
    for (let index = 0; index < 60; index += 1) monitor.observe(state, index % 2 ? 279.76 : 279.76000000000005, (t += 10 * SECOND), { minIntervalMs: 1000 });
    // Only what the decimals say: a step seen three times is its own matter.
    state.quantum = undefined;
    assert.equal(monitor.resolutionOf(state), undefined);
  });

  it('still reports a real step of a reading sent with many decimals', () => {
    const engine = newEngine();
    const rand = noise(57);
    const path = 'plugins.example.reading';
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, () => [[path, 0.29 + 0.0001 * rand()]]);
    t = run(engine, t, t + 2 * MINUTE, 10 * SECOND, () => [[path, 0.32 + 0.0001 * rand()]]);
    assert.ok(detectors(engine).includes(`shift:${path}`), detectors(engine).join(', '));
  });
});

describe('watch learning: operating states learned from the data', () => {
  const pump = 'plugins.watermaker.running';
  const current = 'electrical.batteries.house.current';

  // A watermaker nobody named: on for half an hour every two hours, and the
  // house current up by 20 A while it runs.
  function cycle(rand, offsetHours = 0) {
    return (now) => {
      const phase = (now - T0 - offsetHours * HOUR) % (2 * HOUR);
      const on = phase >= HOUR && phase < HOUR + 30 * MINUTE;
      return [[pump, on], [current, (on ? 25 : 5) + 0.2 * rand()]];
    };
  }

  it('learns that a watermaker moves the house current, and stops reporting its runs', () => {
    const engine = newEngine();
    const rand = noise(61);
    let t = run(engine, T0, T0 + 12 * HOUR, 10 * SECOND, cycle(rand));
    const runs = opened(engine, 'shift').filter((entry) => entry.path === current);
    assert.ok(runs.length >= 1, 'its first runs are news');
    const learned = engine.inventory(t).learnedStates.find((item) => item.driver === pump);
    assert.ok(learned && learned.paths.some((item) => item.path === current), JSON.stringify(engine.inventory(t).learnedStates));
    const before = runs.length;
    t = run(engine, t, t + 8 * HOUR, 10 * SECOND, cycle(rand));
    assert.equal(opened(engine, 'shift').filter((entry) => entry.path === current).length, before, 'learned: its later runs are an operating state');
  });

  it('still reports the current stepping with no change of the watermaker', () => {
    const engine = newEngine();
    const rand = noise(62);
    let t = run(engine, T0, T0 + 12 * HOUR, 10 * SECOND, cycle(rand));
    const before = opened(engine, 'shift').filter((entry) => entry.path === current).length;
    // An hour into the off part of a cycle, the current jumps on its own.
    const start = T0 + Math.ceil((t - T0) / (2 * HOUR)) * 2 * HOUR + 10 * MINUTE;
    t = run(engine, t, start, 10 * SECOND, cycle(rand));
    t = run(engine, t, t + 5 * MINUTE, 10 * SECOND, () => [[pump, false], [current, 45 + 0.2 * rand()]]);
    assert.ok(opened(engine, 'shift').filter((entry) => entry.path === current).length > before, 'a step of its own is news');
  });

  it('learns nothing from a change no path answers', () => {
    const engine = newEngine();
    const rand = noise(63);
    const t = run(engine, T0, T0 + 12 * HOUR, 10 * SECOND, (now) => [
      ['plugins.example.mode', Math.floor((now - T0) / (40 * MINUTE)) % 2 ? 'a' : 'b'],
      [current, 5 + 0.2 * rand()]
    ]);
    assert.deepEqual(engine.inventory(t).learnedStates, []);
  });

  it('keeps what it learned across a restart', () => {
    const engine = newEngine();
    const rand = noise(64);
    let t = run(engine, T0, T0 + 12 * HOUR, 10 * SECOND, cycle(rand));
    const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
    const restarted = newEngine({}, t + MINUTE);
    restarted.importState(saved, t + MINUTE);
    assert.ok(restarted.inventory(t + MINUTE).learnedStates.some((item) => item.driver === pump));
  });

  it('judges a pair against chance with the binomial tail', () => {
    const { binomialTail } = require('../lib/watch/drivers.cjs');
    assert.equal(binomialTail(0, 5, 0.3), 1);
    assert.ok(Math.abs(binomialTail(1, 1, 0.3) - 0.3) < 1e-12);
    assert.ok(Math.abs(binomialTail(2, 3, 0.5) - 0.5) < 1e-12);
    assert.ok(binomialTail(4, 4, 0.08) < 1e-3);
    assert.ok(binomialTail(1000, 1000, 0.9999) > 0.5, 'a driver in every window explains nothing');
  });

  it('learns nothing from a path that changes all the time', () => {
    const engine = newEngine();
    const rand = noise(65);
    const t = run(engine, T0, T0 + 12 * HOUR, 10 * SECOND, (now) => [
      ['plugins.example.lastUpdate', new Date(now).toISOString()],
      ...cycle(rand)(now)
    ]);
    const learned = engine.inventory(t).learnedStates;
    assert.ok(!learned.some((item) => item.driver === 'plugins.example.lastUpdate'), JSON.stringify(learned));
    assert.ok(learned.some((item) => item.driver === pump), 'the watermaker is still learned beside it');
  });
});

describe('watch learning: how each source comes back after a restart', () => {
  const ble = 'environment.inside.bedroom.temperature';
  const gps = 'navigation.speedOverGroundIndicator';
  function restartEngine(engine, t) {
    const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
    const next = newEngine({}, t + 10 * SECOND);
    next.importState(saved, t + 10 * SECOND);
    return { engine: next, t: t + 10 * SECOND };
  }
  // The Bluetooth sensor is heard six minutes after each restart; the other
  // source at once.
  const sample = (rand, since, dead = false) => (now) => [
    ...(now - since >= 6 * MINUTE ? [[ble, 290 + 0.1 * rand(), 'bt.bedroom']] : []),
    ...(dead ? [] : [[gps, 3 + 0.05 * rand(), 'nmea.gps']])
  ];

  it('learns how long each source takes, and judges each path by its own', () => {
    const rand = noise(71);
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, sample(rand, T0 - HOUR));
    for (let index = 0; index < 3; index += 1) {
      ({ engine, t } = restartEngine(engine, t));
      t = run(engine, t, t + 30 * MINUTE, 10 * SECOND, sample(rand, t));
    }
    const learned = Object.fromEntries(engine.inventory(t).restarts.map((item) => [item.source, item.reacquireMs]));
    assert.ok(learned['bt.bedroom'] >= 6 * MINUTE && learned['bt.bedroom'] <= 10 * MINUTE, JSON.stringify(learned));
    assert.ok(learned['nmea.gps'] <= 2 * MINUTE, JSON.stringify(learned));
    // Once more: the Bluetooth sensor takes its six minutes, and the other
    // source's path never comes back.
    ({ engine, t } = restartEngine(engine, t));
    const restartedAt = t;
    t = run(engine, t, t + 8 * MINUTE, 10 * SECOND, sample(rand, t, true));
    const dropouts = opened(engine, 'dropout');
    assert.ok(!dropouts.some((entry) => entry.path === ble), 'its six minutes are how it comes back');
    const dead = dropouts.find((entry) => entry.path === gps);
    assert.ok(dead && dead.openedAt - restartedAt < 5 * MINUTE, 'the quick source\'s dead path is reported in minutes, not a quarter of an hour');
  });
});

describe('watch learning: adaptive thresholds and what a number is', () => {
  it('fits how far is news to how much a path\'s episodes vary, never far past its record', () => {
    const alike = monitor.createPathState('plugins.example.alike', T0);
    const varied = monitor.createPathState('plugins.example.varied', T0);
    let t = T0;
    const sizesAlike = [10, 10.5, 9.8, 10.2, 10.1, 9.9, 10.3, 10];
    const sizesVaried = [4, 25, 9, 60, 12, 7, 30, 15];
    for (let index = 0; index < sizesAlike.length; index += 1) {
      for (const [state, size] of [[alike, sizesAlike[index]], [varied, sizesVaried[index]]]) {
        habits.follow(state, 'shift+', size, true, t);
        habits.follow(state, 'shift+', 0, false, t + MINUTE);
      }
      t += 3 * HOUR;
    }
    const limitAlike = habits.judge(alike, 'shift+', 0, t).usual.peakLimit;
    const limitVaried = habits.judge(varied, 'shift+', 0, t).usual.peakLimit;
    assert.ok(limitAlike > 10.5 && limitAlike < 15, `alike: ${limitAlike}`);
    assert.ok(limitVaried > 60 && limitVaried < 200, `varied: ${limitVaried}`);
    assert.equal(habits.judge(alike, 'shift+', 16, t).beyond, true, 'a spike half again its alike ones is news');
    assert.equal(habits.judge(varied, 'shift+', 16, t).beyond, false, 'the same is routine where spikes vary this much');
  });

  it('reports fewer routine episodes at low sensitivity than at high', () => {
    const state = monitor.createPathState('plugins.example.spiky', T0);
    let t = T0;
    const sizes = [8, 12, 9, 15, 10, 11, 13, 9, 14, 10];
    for (const size of sizes) {
      habits.follow(state, 'shift+', size, true, t);
      habits.follow(state, 'shift+', 0, false, t + MINUTE);
      t += 2 * HOUR;
    }
    const low = habits.judge(state, 'shift+', 0, t, 0.01).usual.peakLimit;
    const high = habits.judge(state, 'shift+', 0, t, 0.1).usual.peakLimit;
    assert.ok(low > high, `${low} > ${high}`);
  });

  it('does not file a baseline under an operating state while the path is away from it', () => {
    const state = monitor.createPathState('electrical.batteries.house.current', T0);
    Object.assign(state, { kind: 'continuous', mean: 5, variance: 0.04, n: 5000, firstAt: T0, relearnUntil: 0, excursionSince: T0 + HOUR });
    const options = { minSamples: 30, learningMs: 20 * MINUTE };
    assert.equal(monitor.saveRegimeBaseline(state, 'pump=on', T0 + 2 * HOUR, options), false);
    state.excursionSince = undefined;
    assert.equal(monitor.saveRegimeBaseline(state, 'pump=on', T0 + 2 * HOUR, options), true);
  });

  it('tells a whole-number reading that keeps taking new values from a state code', () => {
    const engine = newEngine();
    const reading = 'plugins.example.dailyBest';
    const code = 'plugins.example.phase';
    // The reading: a new whole number every two hours. The code: 1, 2, 1, 2.
    let t = run(engine, T0, T0 + 12 * HOUR, MINUTE, (now) => {
      const slot = Math.floor((now - T0) / (2 * HOUR));
      return [[reading, [120, 131, 117, 140, 125, 133][slot % 6]], [code, slot % 2 ? 2 : 1]];
    });
    t = run(engine, t, t + 30 * MINUTE, MINUTE, () => [[reading, 150], [code, 7]]);
    const states = opened(engine, 'newState').map((entry) => entry.path);
    assert.ok(states.includes(code), 'a code taking a value it never had is news');
    assert.ok(!states.filter((path) => path === reading).length || engine.inventory(t).paths.find((item) => item.path === reading).kind === 'continuous', 'a reading taking a new value is measuring');
  });
});

describe('watch learning: yardsticks learned from the data', () => {
  const level = 'plugins.example.level';

  it('measures a departure by how far the path\'s average usually strays, not by how its readings scatter', () => {
    // Readings that scatter by ±2 on their own, once a second: their
    // average hardly moves, and a lasting step of 2.5 is plain in it,
    // though it is little more than two of the readings' spreads.
    const engine = newEngine();
    const rand = noise(81);
    let t = run(engine, T0, T0 + 3 * HOUR, SECOND, () => [[level, 50 + 2 * rand()]]);
    assert.deepEqual(opened(engine, 'shift'), [], 'its scatter is no departure');
    t = run(engine, t, t + 3 * MINUTE, SECOND, () => [[level, 52.5 + 2 * rand()]]);
    const found = engine.status().activeFindings.find((entry) => entry.detector === 'shift' && entry.path === level);
    assert.ok(found, 'the step is reported');
    const spreads = Number(/\(([\d.]+)× its normal variation/.exec(found.message)[1]);
    assert.ok(spreads < 6, `in its readings' spreads it is small: ${found.message}`);
    assert.match(found.message, /its average usually stays within ±/);
  });

  it('does not report the same step on a path whose readings wander together', () => {
    // The same spread, but each reading close to the last: its average
    // wanders as far as its readings do, and 2.5 is within that.
    const engine = newEngine();
    const rand = noise(82);
    let wander = 0;
    const sample = (offset) => () => {
      wander = 0.995 * wander + 0.12 * rand();
      return [[level, 50 + offset + wander]];
    };
    let t = run(engine, T0, T0 + 3 * HOUR, SECOND, sample(0));
    const before = opened(engine, 'shift').length;
    const spread = Math.sqrt(engine.exportState(t).paths.find((item) => item.path === level).variance);
    t = run(engine, t, t + 3 * MINUTE, SECOND, sample(2 * spread));
    assert.equal(opened(engine, 'shift').length, before, `a step of two spreads (${spread.toFixed(2)} each) is how it wanders`);
  });

  it('judges a path saved before the yardstick was learned as it was judged then', () => {
    const engine = newEngine();
    const rand = noise(83);
    const t = run(engine, T0, T0 + 2 * HOUR, SECOND, () => [[level, 50 + 2 * rand()]]);
    const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
    const entry = saved.paths.find((item) => item.path === level);
    assert.ok(Number.isFinite(entry.devVar) && entry.devVar < entry.variance / 4, `learned: ${entry.devVar} of ${entry.variance}`);
    delete entry.devVar;
    const restarted = newEngine({}, t + SECOND);
    restarted.importState(saved, t + SECOND);
    restarted.ingest(level, 50, t + SECOND);
    const after = restarted.exportState(t + SECOND).paths.find((item) => item.path === level);
    assert.ok(Math.abs(after.devVar / after.variance - 1) < 0.05, `starts from its spread: ${after.devVar} of ${after.variance}`);
  });

  it('learns an operating state whose answer takes longer than five minutes', () => {
    // A heater nobody named: on for an hour every three, and the salon
    // twelve minutes later 6 K warmer.
    const heater = 'plugins.heater.on';
    const salon = 'environment.inside.salon.temperature';
    const engine = newEngine();
    const rand = noise(84);
    const t = run(engine, T0, T0 + 30 * HOUR, 10 * SECOND, (now) => {
      const phase = (now - T0) % (3 * HOUR);
      const on = phase >= HOUR && phase < 2 * HOUR;
      const warm = phase >= HOUR + 12 * MINUTE && phase < 2 * HOUR;
      return [[heater, on], [salon, (warm ? 297 : 291) + 0.2 * rand()]];
    });
    const learned = engine.inventory(t).learnedStates.find((item) => item.driver === heater);
    assert.ok(learned && learned.paths.some((item) => item.path === salon && item.lagMs >= 10 * MINUTE), JSON.stringify(engine.inventory(t).learnedStates));
  });

  it('keeps one entry for a path changing every second', () => {
    const learnedStates = require('../lib/watch/drivers.cjs');
    const drivers = learnedStates.createDrivers(T0);
    for (let index = 0; index < 3600; index += 1) learnedStates.noteTransition(drivers, 'plugins.example.lastUpdate', T0 + index * SECOND);
    learnedStates.noteTransition(drivers, 'plugins.watermaker.running', T0 + HOUR);
    assert.equal(Object.keys(drivers.last).length, 2);
    const { credited } = learnedStates.noteOnset(drivers, 'electrical.batteries.house.current', T0 + HOUR + MINUTE);
    assert.deepEqual(credited.sort(), ['plugins.example.lastUpdate', 'plugins.watermaker.running']);
  });

  it('gives a steady source little more than it takes after a restart, an erratic one more, and learns its settling', () => {
    const restartLearning = require('../lib/watch/restarts.cjs');
    const restarts = restartLearning.createRestarts();
    for (const ms of [30, 31, 29, 30, 32, 30].map((s) => s * SECOND)) restartLearning.note(restarts, 'steady', 'reacquire', ms);
    for (const ms of [20, 300, 60, 150].map((s) => s * SECOND)) restartLearning.note(restarts, 'erratic', 'reacquire', ms);
    assert.equal(restartLearning.windowFor(restarts, 'steady', 'reacquire'), MINUTE, 'the least window');
    assert.ok(restartLearning.windowFor(restarts, 'erratic', 'reacquire') > 1.5 * 300 * SECOND, 'its scatter widens it');
    assert.equal(restartLearning.startupFor(restarts, 'steady'), 30 * SECOND + restartLearning.DEFAULT_STARTUP_MS);
    // A path whose own departures after restarts last four minutes: so does its start-up.
    let settles = [];
    for (const ms of [230, 240, 250].map((s) => s * SECOND)) settles = restartLearning.noteSettle(settles, ms);
    const startup = restartLearning.startupFor(restarts, 'steady', settles);
    assert.ok(startup >= 30 * SECOND + 250 * SECOND && startup < 30 * SECOND + 10 * MINUTE, String(startup));
    // A departure an hour long after a restart is a fault, not settling.
    settles = restartLearning.noteSettle(settles, HOUR);
    assert.equal(restartLearning.startupFor(restarts, 'steady', settles), startup);
    // Another path of the source has nothing to settle.
    assert.equal(restartLearning.startupFor(restarts, 'steady'), 30 * SECOND + restartLearning.DEFAULT_STARTUP_MS);
  });
});

describe('review of 5d015da: what a restart teaches', () => {
  // A number its name does not say is a code, a counter or a measurement.
  const code = 'plugins.example.figure';
  function restartEngine(engine, t, gapMs = 10 * SECOND) {
    const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
    const next = newEngine({}, t + gapMs);
    next.importState(saved, t + gapMs);
    return { engine: next, t: t + gapMs };
  }

  it('does not take a restart\'s switches for the path going back to its states', () => {
    let engine = newEngine();
    let t = run(engine, T0, T0 + 2 * HOUR, 30 * SECOND, () => [[code, 5]]);
    ({ engine, t } = restartEngine(engine, t));
    // The plugin sends 0 until it has read, then its 5 again.
    t = run(engine, t, t + MINUTE, 30 * SECOND, () => [[code, 0]]);
    t = run(engine, t, t + 20 * MINUTE, 30 * SECOND, () => [[code, 5]]);
    t = run(engine, t, t + 10 * MINUTE, 30 * SECOND, () => [[code, 7]]);
    assert.deepEqual(opened(engine, 'newState').map((entry) => entry.path), [], 'a number taking new values is measuring');
  });

  it('reports a flag\'s first change made during the start-up, as it would outside it', () => {
    let engine = newEngine();
    let t = run(engine, T0, T0 + 2 * HOUR, 30 * SECOND, () => [[code, 0]]);
    ({ engine, t } = restartEngine(engine, t));
    t = run(engine, t, t + 30 * MINUTE, 30 * SECOND, () => [[code, 1]]);
    assert.deepEqual(opened(engine, 'newState').map((entry) => entry.path), [code]);
  });

  it('counts only the climbing it watched toward a counter\'s day', () => {
    const count = 'plugins.example.tally';
    let engine = newEngine();
    let value = 0;
    let t = run(engine, T0, T0 + 2 * HOUR, 30 * SECOND, () => [[count, (value += 1)]]);
    // Down for twenty-two hours: no day of climbing was seen.
    ({ engine, t } = restartEngine(engine, t, 22 * HOUR));
    t = run(engine, t, t + 10 * MINUTE, 30 * SECOND, () => [[count, (value += 1)]]);
    const state = engine.exportState(t).paths.find((item) => item.path === count);
    assert.ok(state.climbMs < 3 * HOUR, String(state.climbMs));
    assert.equal(monitor.isCounterState(state), false);
  });

  it('keeps one observation per source per restart, and none from a path heard after a day', () => {
    const restartLearning = require('../lib/watch/restarts.cjs');
    const restarts = restartLearning.createRestarts();
    restartLearning.note(restarts, 'bt', 'reacquire', 4 * MINUTE, T0);
    for (let path = 0; path < 8; path += 1) restartLearning.note(restarts, 'bt', 'reacquire', 10 * SECOND + path, T0 + HOUR);
    assert.deepEqual(restarts.sources.bt.reacquire, [4 * MINUTE, 10 * SECOND + 7], 'the slow restart before is kept');
    assert.equal(restartLearning.summary(restarts)[0].restarts, 2);
    restartLearning.note(restarts, 'bt', 'reacquire', 24 * HOUR, T0 + 2 * HOUR);
    assert.equal(restarts.sources.bt.reacquire.length, 2, 'an outage is not the source\'s pace');
    restartLearning.note(restarts, '__proto__', 'reacquire', MINUTE, T0);
    const restored = restartLearning.importRestarts(JSON.parse(JSON.stringify(restarts)));
    assert.deepEqual(restored.sources.__proto__.reacquire, [MINUTE]);
    assert.equal(Object.getPrototypeOf({}).reacquire, undefined);
  });
});

describe('watch learning: a path\'s own settling after restarts', () => {
  it('still reports a fault just after a restart on a path whose source\'s link spikes at every restart', () => {
    const rtt = 'networking.edgeLink.boat.rtt';
    const voltage = 'electrical.batteries.house.voltage';
    const rand = noise(91);
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[rtt, 0.05 + 0.002 * rand(), 'link'], [voltage, 12.9 + 0.02 * rand(), 'link']]);
    const restart = () => {
      const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
      t += 10 * SECOND;
      engine = newEngine({}, t);
      engine.importState(saved, t);
    };
    // The link's round-trip time is high for four minutes after every
    // restart: past the default start-up the first time, which is news.
    let first;
    for (let index = 0; index < 4; index += 1) {
      restart();
      const start = t;
      t = run(engine, t, t + 20 * MINUTE, SECOND, (now) => [[rtt, (now - start < 4 * MINUTE ? 0.4 : 0.05) + 0.002 * rand(), 'link'], [voltage, 12.9 + 0.02 * rand(), 'link']]);
      if (index === 0) first = opened(engine, 'shift').length;
    }
    assert.equal(opened(engine, 'shift').length, first, 'its settling is learned, and not reported again');
    const rttBefore = opened(engine, 'shift').filter((entry) => entry.path === rtt).length;
    restart();
    const start = t;
    // The battery drops three minutes after the restart, while the link is still settling.
    t = run(engine, t, t + 6 * MINUTE, SECOND, (now) => [
      [rtt, (now - start < 4 * MINUTE ? 0.4 : 0.05) + 0.002 * rand(), 'link'],
      [voltage, (now - start < 3 * MINUTE ? 12.9 : 11.2) + 0.02 * rand(), 'link']
    ]);
    const found = opened(engine, 'shift').filter((entry) => entry.path === voltage);
    assert.ok(found.length === 1 && found[0].openedAt - start < 4 * MINUTE, JSON.stringify(opened(engine, 'shift')));
    assert.equal(opened(engine, 'shift').filter((entry) => entry.path === rtt).length, rttBefore);
  });

  it('measures a settling that ends within the start-up when it ends, once per restart', () => {
    const rtt = 'networking.edgeLink.boat.rtt';
    const rand = noise(17);
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[rtt, 0.05 + 0.002 * rand(), 'link']]);
    const restart = () => {
      const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
      t += 10 * SECOND;
      engine = newEngine({}, t);
      engine.importState(saved, t);
    };
    const settles = () => engine.exportState(t).paths.find((item) => item.path === rtt).restartSettles || [];
    // High for its first 40 s after every restart, well within the start-up.
    for (let index = 0; index < 5; index += 1) {
      restart();
      const start = t;
      t = run(engine, t, t + 20 * MINUTE, SECOND, (now) => [[rtt, (now - start < 40 * SECOND ? 0.4 : 0.05) + 0.002 * rand(), 'link']]);
    }
    assert.equal(settles().length, 5, JSON.stringify(settles()));
    // The 40 s and its average's fading, not the rest of a start-up that
    // grows with every restart measured that way.
    const first = settles()[0];
    assert.ok(first < 2 * MINUTE && settles().every((ms) => Math.abs(ms - first) <= 10 * SECOND), JSON.stringify(settles()));
    // High, back for 20 s, and high again: one restart, settled at its last end.
    restart();
    const start = t;
    t = run(engine, t, t + 20 * MINUTE, SECOND, (now) => [[rtt, (now - start < 40 * SECOND || (now - start >= 60 * SECOND && now - start < 100 * SECOND) ? 0.4 : 0.05) + 0.002 * rand(), 'link']]);
    const after = settles();
    assert.equal(after.length, 6, JSON.stringify(after));
    assert.ok(after[5] >= first + 45 * SECOND && after[5] <= first + 75 * SECOND, JSON.stringify(after));
  });

  it('keeps a restart\'s departure that dips under on the start-up\'s last tick and is back on the next', () => {
    const rtt = 'networking.edgeLink.boat.rtt';
    const { detectorOptions } = require('../lib/watch/engine.cjs');
    const options = detectorOptions(normalizeWatchConfig({ watchEnabled: true, watchLearningMinutes: 20 }));
    const rand = noise(29);
    const engine = newEngine();
    const t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[rtt, 0.05 + 0.002 * rand()]]);
    const learned = () => monitor.importPathState(JSON.parse(JSON.stringify(engine.exportState(t).paths.find((item) => item.path === rtt))), t);
    const away = (state, departure) => {
      state.fast = state.mean + departure * Math.max(Math.sqrt(state.devVar), monitor.noiseFloor(state));
    };
    const tick = (state, at, departure) => {
      away(state, departure);
      monitor.learnFromTick(state, at, options);
    };
    // Ticks every 5 s; the start-up is over at t + 10 s.
    const hovering = learned();
    hovering.startupUntil = t + 10 * SECOND;
    tick(hovering, t, 10);
    tick(hovering, t + 5 * SECOND, 0);
    tick(hovering, t + 10 * SECOND, 10);
    assert.equal(hovering.startupSettledAt, undefined, 'back at once: not settled yet');
    tick(hovering, t + 15 * SECOND, 0);
    assert.equal(hovering.startupSettledAt, t + 15 * SECOND);
    // Over a tick before the start-up's last: a departure now is the path's own.
    const over = learned();
    over.startupUntil = t + 15 * SECOND;
    tick(over, t, 10);
    tick(over, t + 5 * SECOND, 0);
    tick(over, t + 10 * SECOND, 0);
    tick(over, t + 15 * SECOND, 10);
    assert.equal(over.startupSettledAt, t + 5 * SECOND);
    assert.ok(habits.isOpen(over, 'shift+'), 'followed as one of its own departures');
  });

  it('does not take a new departure just after the start-up for the restart\'s, ended a minute before', () => {
    const rtt = 'networking.edgeLink.boat.rtt';
    const restartLearning = require('../lib/watch/restarts.cjs');
    const rand = noise(23);
    let engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[rtt, 0.05 + 0.002 * rand()]]);
    const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
    t += 10 * SECOND;
    engine = newEngine({}, t);
    engine.importState(saved, t);
    const start = t;
    const startup = restartLearning.startupFor(engine.exportState(t).restarts, 'default', undefined);
    // Ticks fall every 5 s from the restart: the first one after the start-up.
    const after = start + Math.ceil(startup / (5 * SECOND)) * 5 * SECOND;
    // High for 20 s, settled well before the start-up ends, and high again
    // just after its last tick, for half a minute.
    const high = (now) => now - start < 20 * SECOND || (now >= after - 4 * SECOND && now < after + 30 * SECOND);
    t = run(engine, t, t + 15 * MINUTE, SECOND, (now) => [[rtt, (high(now) ? 0.4 : 0.05) + 0.002 * rand()]]);
    const settles = engine.exportState(t).paths.find((item) => item.path === rtt).restartSettles || [];
    assert.equal(settles.length, 1, JSON.stringify(settles));
    assert.ok(settles[0] < after - start - 20 * SECOND, `the restart's own, not the one after: ${JSON.stringify(settles)}, start-up ${startup}`);
  });
});
