'use strict';

/**
 * How each source comes back after a restart, learned from the restarts.
 *
 * After the server restarts, every plugin announces itself again, at its
 * own pace: a GNSS receiver within seconds, a Bluetooth plugin after it has
 * scanned for its sensors (minutes), an under-keel plugin once it has its
 * first depth. How long a path is given to be heard again, how long a state
 * path's detour may last, how long the watch keeps quiet while it starts up
 * and how long a finding open before the restart waits to come back - all
 * follow from how long the sources have taken before: half again the
 * longest of their last few restarts. Until a source has been through a
 * restart, the defaults hold.
 *
 * Plain JSON, saved with the engine's state.
 */

const MINUTE_MS = 60 * 1000;
const KEEP = 8;
const DEFAULT_WINDOW_MS = 15 * MINUTE_MS;
const MIN_WINDOW_MS = MINUTE_MS;
const MAX_WINDOW_MS = 60 * MINUTE_MS;
const DEFAULT_STARTUP_MS = 2 * MINUTE_MS;
const MAX_STARTUP_MS = 5 * MINUTE_MS;
const DEFAULT_CARRY_MS = 20 * MINUTE_MS;
// A carried finding needs its persistence after its path is heard again.
const CARRY_MARGIN_MS = 5 * MINUTE_MS;
const MAX_SOURCES = 200;

function createRestarts() {
  return { sources: {} };
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/** One source came back `ms` after a restart: heard again (`reacquire`), or a state path back where it was (`detour`). */
function note(restarts, source, kind, ms) {
  if (!(ms >= 0)) return;
  const key = source || 'default';
  const entry = restarts.sources[key] || (restarts.sources[key] = { reacquire: [], detour: [] });
  const list = entry[kind] || (entry[kind] = []);
  list.push(Math.round(ms));
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
  const keys = Object.keys(restarts.sources);
  if (keys.length > MAX_SOURCES) delete restarts.sources[keys[0]];
}

/** How long a path of this source is given to come back after a restart. */
function windowFor(restarts, source, kind) {
  const entry = restarts.sources[source || 'default'];
  const list = entry && entry[kind];
  if (!Array.isArray(list) || list.length === 0) return DEFAULT_WINDOW_MS;
  return clamp(1.5 * Math.max(...list), MIN_WINDOW_MS, MAX_WINDOW_MS);
}

/**
 * How long a path of this source is in its start-up after a restart: until
 * its source is usually heard again, and the settling after that (a link
 * reconnecting spikes its round-trip time once it is heard) - never shorter
 * than the default.
 */
function startupFor(restarts, source) {
  const entry = restarts.sources[source || 'default'];
  const list = entry && Array.isArray(entry.reacquire) ? entry.reacquire.slice().sort((a, b) => a - b) : [];
  if (list.length === 0) return DEFAULT_STARTUP_MS;
  return Math.min(MAX_WINDOW_MS, list[Math.floor(list.length / 2)] + DEFAULT_STARTUP_MS);
}

/** Each source's usual time to come back: the median of its restarts. */
function typicalBySource(restarts) {
  return Object.values(restarts.sources)
    .map((entry) => (Array.isArray(entry.reacquire) ? entry.reacquire.slice().sort((a, b) => a - b) : []))
    .filter((list) => list.length > 0)
    .map((list) => list[Math.floor(list.length / 2)]);
}

/**
 * How long what is not one path's - gates, the feed, GNSS - waits while the
 * watch starts up: the default, or the settling after the quicker sources
 * are heard again (their lower quartile), if that is longer. A slow source
 * does not stretch it for every other: its own paths have their own
 * start-up (startupFor()).
 */
function startupMs(restarts) {
  const typical = typicalBySource(restarts).sort((a, b) => a - b);
  if (typical.length === 0) return DEFAULT_STARTUP_MS;
  return clamp(typical[Math.floor(0.25 * (typical.length - 1))] + DEFAULT_STARTUP_MS, DEFAULT_STARTUP_MS, MAX_STARTUP_MS);
}

/** How long a finding open before the restart waits to come back: until its slowest source is heard, and its persistence after. */
function carryMs(restarts) {
  const sources = Object.keys(restarts.sources);
  if (sources.length === 0) return DEFAULT_CARRY_MS;
  const slowest = Math.max(...sources.map((source) => windowFor(restarts, source, 'reacquire')), MIN_WINDOW_MS);
  return slowest + CARRY_MARGIN_MS;
}

function summary(restarts) {
  return Object.entries(restarts.sources).map(([source, entry]) => ({
    source,
    reacquireMs: windowFor(restarts, source, 'reacquire'),
    detourMs: windowFor(restarts, source, 'detour'),
    restarts: (entry.reacquire || []).length
  }));
}

function importRestarts(saved) {
  const restarts = createRestarts();
  if (!saved || typeof saved !== 'object' || !saved.sources || typeof saved.sources !== 'object') return restarts;
  for (const [source, entry] of Object.entries(saved.sources)) {
    if (!entry || typeof entry !== 'object') continue;
    const list = (value) => (Array.isArray(value) ? value.filter((ms) => Number.isFinite(ms) && ms >= 0).slice(-KEEP) : []);
    restarts.sources[source] = { reacquire: list(entry.reacquire), detour: list(entry.detour) };
  }
  return restarts;
}

module.exports = {
  DEFAULT_CARRY_MS,
  DEFAULT_STARTUP_MS,
  DEFAULT_WINDOW_MS,
  carryMs,
  createRestarts,
  importRestarts,
  note,
  startupFor,
  startupMs,
  summary,
  windowFor
};
