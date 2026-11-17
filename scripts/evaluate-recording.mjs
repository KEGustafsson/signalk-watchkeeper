#!/usr/bin/env node
// How well the watch does on a real recording (record-stream.mjs): known
// faults are injected into the recorded data - a step, a drift, a frozen
// sender, a dropout, each on a path whose own data can show it - and the
// recording is replayed through the engine as the plugin feeds it (self
// only, receive time, $source and connection, a tick every 5 s, an engine
// restart wherever the recorded stream closed and opened). It reports which
// faults were found and how fast, and every other finding: on a recording
// without known faults of its own, those are what the crew would have been
// told about - false alarms, or real events to judge by hand.
//
//   node scripts/evaluate-recording.mjs <recording.ndjson> [options]
//     --lib <dir>         the plugin to evaluate (default: this checkout)
//     --fault-lib <dir>   the plugin whose exclusions choose the fault paths
//                         (default: --lib); give two versions the same one
//                         to compare them on the same faults
//     --state <file>      start from a saved watch-state.json
//     --faults <n>        how many faults to inject (default 24; 0 for none)
//     --seed <n>          which faults, where (default 1)
//     --size <k>          a step's size in the path's own spreads (default 8)
//     --learn-hours <h>   no fault in the first hours (default 2)
//     --json <file>       write the results as JSON too
//
// The same seed injects the same faults into the same recording, so two
// versions of the plugin can be compared on exactly the same data.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { faults: 24, seed: 1, size: 8, learnHours: 2, lib: path.resolve(here, '..') };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[(index += 1)];
    if (arg === '--lib') args.lib = path.resolve(next());
    else if (arg === '--fault-lib') args.faultLib = path.resolve(next());
    else if (arg === '--state') args.state = next();
    else if (arg === '--faults') args.faults = Number(next());
    else if (arg === '--seed') args.seed = Number(next());
    else if (arg === '--size') args.size = Number(next());
    else if (arg === '--learn-hours') args.learnHours = Number(next());
    else if (arg === '--json') args.json = next();
    else rest.push(arg);
  }
  args.recording = rest[0];
  return args;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

async function* records(file) {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A line cut short when the recorder stopped.
    }
  }
}

function selfOf(record, self) {
  if (self) return self;
  const hello = record.d && record.d.self;
  if (typeof hello !== 'string') return undefined;
  return hello.startsWith('vessels.') ? hello : `vessels.${hello}`;
}

function isSelf(delta, self) {
  return !delta.context || delta.context === 'vessels.self' || delta.context === self;
}

function sourceOf(update) {
  if (typeof update.$source === 'string') return update.$source;
  const source = update.source;
  return source && typeof source === 'object' ? [source.label, source.src].filter(Boolean).join('.') || undefined : undefined;
}

function connectionOf(update) {
  const source = update.source;
  return source && typeof source === 'object' && typeof source.label === 'string' && source.label ? source.label : undefined;
}

/** What each numeric path of the recording looks like: enough to choose faults it can show. */
async function survey(file, isExcluded) {
  const paths = new Map();
  let self;
  let first;
  let last;
  for await (const record of records(file)) {
    self = selfOf(record, self);
    if (!record.d || !Array.isArray(record.d.updates) || !isSelf(record.d, self)) continue;
    first = first ?? record.t;
    last = record.t;
    for (const update of record.d.updates) {
      for (const entry of (update && update.values) || []) {
        if (!entry || typeof entry.path !== 'string' || typeof entry.value !== 'number' || !Number.isFinite(entry.value)) continue;
        if (isExcluded(entry.path)) continue;
        let item = paths.get(entry.path);
        if (!item) {
          item = { path: entry.path, n: 0, changes: 0, rises: 0, gapSum: 0, last: undefined, lastAt: undefined, sample: [], minutes: new Set() };
          paths.set(entry.path, item);
        }
        item.n += 1;
        if (item.last !== undefined && entry.value !== item.last) item.changes += 1;
        if (item.last !== undefined && entry.value > item.last) item.rises += 1;
        if (item.lastAt !== undefined) item.gapSum += record.t - item.lastAt;
        item.last = entry.value;
        item.lastAt = record.t;
        // The minutes it was heard in: a fault is put only where it reads.
        item.minutes.add(Math.floor(record.t / MINUTE));
        // A sample of the values, every 20th: enough for a median and a spread.
        if (item.n % 20 === 1 && item.sample.length < 2000) item.sample.push(entry.value);
      }
    }
  }
  for (const item of paths.values()) {
    const sorted = item.sample.slice().sort((a, b) => a - b);
    item.median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const deviations = sorted.map((value) => Math.abs(value - item.median)).sort((a, b) => a - b);
    item.spread = 1.4826 * (deviations[Math.floor(deviations.length / 2)] ?? 0);
    // A path that sits at one value (packet loss at 0) has no spread: its
    // faults are sized by the range it does move over.
    const low = sorted[Math.floor(0.01 * (sorted.length - 1))] ?? 0;
    const high = sorted[Math.floor(0.99 * (sorted.length - 1))] ?? 0;
    item.range = high - low;
    // Counting, not measuring: almost every change a rise.
    item.counter = item.changes >= 5 && item.rises >= 0.98 * item.changes;
    item.changeRatio = item.n > 1 ? item.changes / (item.n - 1) : 0;
    item.meanGap = item.n > 1 ? item.gapSum / (item.n - 1) : Infinity;
  }
  return { paths, self, first, last };
}

const TYPES = ['step', 'drift', 'freeze', 'dropout'];

/** Faults each path can show, at random times after the learning hours. */
function chooseFaults(surveyed, args) {
  const rand = random(args.seed);
  // A counter is not a level that steps, drifts or sticks; it can drop out.
  const candidates = [...surveyed.paths.values()].filter((item) => item.n >= 300 && item.meanGap <= 60000);
  const from = surveyed.first + args.learnHours * HOUR;
  const to = surveyed.last - HOUR;
  const faults = [];
  if (to <= from || candidates.length === 0) return faults;
  // A type no path can show (no path changes often enough to freeze) is
  // given up after this many tries, and the others carry on.
  const failures = new Map();
  const unavailable = new Set();
  for (let index = 0; faults.length < args.faults && index < args.faults * 50; index += 1) {
    const types = TYPES.filter((name) => !unavailable.has(name));
    if (types.length === 0) break;
    const type = types[faults.length % types.length];
    const item = candidates[Math.floor(rand() * candidates.length)];
    const reject = () => {
      failures.set(type, (failures.get(type) || 0) + 1);
      if (failures.get(type) >= 20 * candidates.length) unavailable.add(type);
    };
    // A sensor that rarely changes cannot show a freeze; one that rarely
    // reports cannot show a dropout in a quarter of an hour.
    if (type === 'freeze' && item.changeRatio < 0.3) { reject(); continue; }
    if (item.counter && type !== 'dropout') { reject(); continue; }
    if (type === 'dropout' && item.meanGap > 20000) { reject(); continue; }
    // A path that never moved in the recording (a stopped engine's
    // revolutions, a packet loss of zero all along) gives nothing to size a
    // step or a drift by: a millionth of a unit would be a fault no sensor
    // could show, and missing it says nothing of the watch.
    if ((type === 'step' || type === 'drift') && !(item.spread > 0 || item.range > 0 || item.median !== 0)) { reject(); continue; }
    const durationMs = type === 'drift' ? 40 * MINUTE : type === 'freeze' ? 30 * MINUTE : type === 'dropout' ? 15 * MINUTE : 20 * MINUTE;
    const start = from + rand() * Math.max(0, to - from - durationMs);
    if (faults.some((fault) => fault.path === item.path && Math.abs(fault.start - start) < 2 * HOUR)) continue;
    // Only where the path reads, most minutes of the fault: a fault in a
    // stretch where it was silent anyway changes nothing, and would be
    // counted missed (or, as a dropout, found for a silence of its own).
    let heard = 0;
    const minutes = Math.ceil(durationMs / MINUTE);
    for (let minute = Math.floor(start / MINUTE); minute < Math.floor(start / MINUTE) + minutes; minute += 1) if (item.minutes.has(minute)) heard += 1;
    if (heard < 0.5 * minutes) continue;
    const scale = Math.max(item.spread, 0.1 * item.range, 0.02 * Math.abs(item.median), 1e-6);
    const sign = rand() < 0.5 ? -1 : 1;
    faults.push({ id: faults.length + 1, type, path: item.path, start, end: start + durationMs, delta: sign * args.size * scale });
  }
  return faults.sort((a, b) => a.start - b.start);
}

function inject(faults, pathName, value, t, held) {
  for (const fault of faults) {
    if (fault.path !== pathName || t < fault.start || t >= fault.end) continue;
    if (fault.type === 'dropout') return { drop: true };
    if (typeof value !== 'number') return { value };
    if (fault.type === 'step') return { value: value + fault.delta };
    if (fault.type === 'drift') return { value: value + fault.delta * Math.min(1, (t - fault.start) / (30 * MINUTE)) };
    if (fault.type === 'freeze') {
      if (!held.has(fault.id)) held.set(fault.id, value);
      return { value: held.get(fault.id) };
    }
  }
  return { value };
}

async function replay(args, surveyed, faults) {
  const { createWatchEngine, normalizeWatchConfig } = require(path.join(args.lib, 'lib/watch/engine.cjs'));
  const monitor = require(path.join(args.lib, 'lib/watch/path-monitor.cjs'));
  // What the watch made of each fault's path halfway through it: to see why
  // a fault was missed.
  const traced = new Map();
  const trace = (target, t) => {
    for (const fault of faults) {
      if (traced.has(fault.id) || t < (fault.start + fault.end) / 2) continue;
      const state = target.exportState(t).paths.find((item) => item.path === fault.path);
      if (!state) {
        traced.set(fault.id, { watched: false });
        continue;
      }
      // The export leaves the 10 s series out; the check reads it for a slope only.
      state.recent = state.recent || [];
      const shift = monitor.evaluateShift(state, t, target.options, false);
      const frozen = monitor.evaluateFrozen(state, t, target.options);
      const dropout = monitor.evaluateDropout(state, t, target.options);
      traced.set(fault.id, {
        path: fault.path,
        dropoutActive: dropout ? dropout.active : undefined,
        silentS: dropout ? Math.round(dropout.evidence.silentFor / 1000) : undefined,
        limitS: dropout ? Math.round(dropout.evidence.limit / 1000) : undefined,
        usualRunS: frozen && frozen.evidence ? Math.round((frozen.evidence.usualRunMs || 0) / 1000) : undefined,
        kind: state.kind,
        counter: monitor.isCounterState(state),
        relearning: t < state.relearnUntil,
        z: shift ? Number(shift.evidence.z.toFixed(2)) : undefined,
        departure: shift && Number.isFinite(shift.evidence.departure) ? Number(shift.evidence.departure.toFixed(2)) : undefined,
        shiftActive: shift ? shift.active : undefined,
        habitLimit: shift && shift.evidence.usual ? Number((shift.evidence.usual.peakLimit || 0).toFixed(2)) : undefined,
        frozenActive: frozen ? frozen.active : undefined,
        regime: state.regimeKey || undefined
      });
    }
  };
  const config = normalizeWatchConfig({ watchEnabled: true });
  const startState = args.state ? JSON.parse(fs.readFileSync(args.state, 'utf8')) : undefined;
  let engine;
  let nextTick;
  let closedAt;
  let saved;
  let self = surveyed.self;
  const restarts = [];
  const held = new Map();
  const all = [];
  const collect = (target, upTo) => {
    for (const incident of target.status(upTo).incidents) {
      for (const finding of incident.findings) all.push(finding);
    }
  };
  // The engine keeps a bounded history of incidents: what it found is
  // collected as the replay goes, before the oldest are let go.
  const COLLECT_TICKS = 120;
  const advance = (upTo) => {
    while (nextTick <= upTo) {
      engine.tick(nextTick);
      nextTick += 5000;
      ticks += 1;
      if (ticks % COLLECT_TICKS === 0) collect(engine, nextTick - 5000);
    }
  };
  let ticks = 0;
  for await (const record of records(args.recording)) {
    const t = record.t;
    if (record.event === 'close' && engine && closedAt === undefined) {
      // The silence before the close is watched, as it was live.
      advance(t);
      closedAt = t;
      saved = JSON.parse(JSON.stringify(engine.exportState(t)));
      collect(engine, t);
      continue;
    }
    if (record.event === 'open' && closedAt !== undefined) {
      engine = createWatchEngine(config, { now: t });
      engine.importState(saved, t);
      restarts.push(t);
      nextTick = t;
      closedAt = undefined;
      continue;
    }
    if (closedAt !== undefined) continue;
    self = selfOf(record, self);
    if (!record.d || !Array.isArray(record.d.updates)) continue;
    if (!engine) {
      engine = createWatchEngine(config, { now: t });
      if (startState) engine.importState(startState, t);
      nextTick = t;
    }
    advance(t);
    if (faults.length > 0) trace(engine, t);
    if (!isSelf(record.d, self)) continue;
    for (const update of record.d.updates) {
      if (!update) continue;
      const source = sourceOf(update);
      const connection = connectionOf(update);
      for (const entry of update.values || []) {
        if (!entry || typeof entry.path !== 'string') continue;
        const injected = faults.length > 0 ? inject(faults, entry.path, entry.value, t, held) : { value: entry.value };
        if (injected.drop) continue;
        engine.ingest(entry.path, injected.value, t, source, connection);
      }
      for (const entry of update.meta || []) {
        if (entry && typeof entry.path === 'string') engine.setMeta(entry.path, entry.value);
      }
    }
  }
  if (engine) {
    engine.tick(nextTick);
    collect(engine, nextTick);
  }
  // A finding carried over a restart is in both engines' incidents: once.
  const unique = new Map();
  for (const finding of all) {
    const key = `${finding.key}@${finding.openedAt}`;
    const known = unique.get(key);
    if (!known || (finding.clearedAt ?? Infinity) < (known.clearedAt ?? Infinity)) unique.set(key, finding);
  }
  return { findings: [...unique.values()].sort((a, b) => a.openedAt - b.openedAt), restarts, ticks, end: nextTick, traced };
}

function score(args, surveyed, faults, result) {
  const grace = 10 * MINUTE;
  const matched = new Set();
  const outcomes = faults.map((fault) => {
    const hits = result.findings.filter((finding) => finding.path === fault.path && finding.openedAt >= fault.start && finding.openedAt <= fault.end + grace);
    for (const hit of hits) matched.add(hit);
    const firstHit = hits[0];
    return {
      ...fault,
      found: Boolean(firstHit),
      detector: firstHit && firstHit.detector,
      latencyMs: firstHit ? firstHit.openedAt - fault.start : undefined,
      midway: result.traced && result.traced.get(fault.id)
    };
  });
  const watchedFrom = surveyed.first + args.learnHours * HOUR;
  const others = result.findings.filter((finding) => !matched.has(finding) && finding.openedAt >= watchedFrom);
  const hours = Math.max(1e-9, (result.end - watchedFrom) / HOUR);
  return { outcomes, others, hours };
}

function clock(t) {
  return new Date(t).toISOString().slice(11, 19);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.recording) {
    console.error('usage: node scripts/evaluate-recording.mjs <recording.ndjson> [--lib dir] [--state file] [--faults n] [--seed n] [--size k] [--learn-hours h] [--json file]');
    process.exit(1);
  }
  const { compileGlob, normalizeWatchConfig } = require(path.join(args.faultLib || args.lib, 'lib/watch/engine.cjs'));
  const excluders = normalizeWatchConfig({ watchEnabled: true }).exclude.map(compileGlob);
  const isExcluded = (name) => name.startsWith('notifications') || excluders.some((match) => match(name));
  const surveyed = await survey(args.recording, isExcluded);
  const faults = chooseFaults(surveyed, args);
  const result = await replay(args, surveyed, faults);
  const { outcomes, others, hours } = score(args, surveyed, faults, result);

  console.log(`recording ${clock(surveyed.first)}-${clock(surveyed.last)} UTC, ${(((surveyed.last - surveyed.first) / HOUR)).toFixed(1)} h, ${result.restarts.length} restarts, ${surveyed.paths.size} numeric paths`);
  console.log(`plugin ${args.lib}`);
  if (faults.length > 0) {
    console.log(`\nfaults (seed ${args.seed}, steps of ${args.size} spreads):`);
    for (const type of TYPES) {
      const of = outcomes.filter((item) => item.type === type);
      if (of.length === 0) continue;
      const found = of.filter((item) => item.found);
      const latencies = found.map((item) => item.latencyMs).sort((a, b) => a - b);
      const median = latencies.length ? `${(latencies[Math.floor(latencies.length / 2)] / MINUTE).toFixed(1)} min` : '-';
      console.log(`  ${type.padEnd(8)} ${found.length}/${of.length} found, median ${median} after it began`);
    }
    const found = outcomes.filter((item) => item.found).length;
    console.log(`  all      ${found}/${outcomes.length} found (${((100 * found) / outcomes.length).toFixed(0)} %)`);
    for (const item of outcomes.filter((entry) => !entry.found)) {
      console.log(`    missed ${item.type} on ${item.path} at ${clock(item.start)}${item.midway ? ` - midway ${JSON.stringify(item.midway)}` : ''}`);
    }
  }
  console.log(`\nother findings: ${others.length} in ${hours.toFixed(1)} h (${(others.length / hours).toFixed(2)} per hour)`);
  for (const finding of others.slice(0, 40)) {
    console.log(`  ${clock(finding.openedAt)} ${finding.detector.padEnd(9)} ${finding.path}`);
  }
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({ args, faults: outcomes, others, hours, restarts: result.restarts }, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
