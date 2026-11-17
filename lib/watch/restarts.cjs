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
 * follow from how long the sources have taken before: the time a restart
 * of that source exceeds only once in a hundred, fitted to its last few
 * as the habits are (log-normal, its scatter shrunk toward a prior while
 * there are few), so a source that always takes ten seconds is given
 * little more and one that takes anything from one to five minutes is
 * given well over five. Until a source has been through a restart, the
 * defaults hold.
 *
 * Plain JSON, saved with the engine's state.
 */

const { limitOf } = require('./habits.cjs');

const MINUTE_MS = 60 * 1000;
const KEEP = 8;
// How seldom a restart of a source may take longer than it is given.
const OVERRUN_CHANCE = 0.01;
const DEFAULT_WINDOW_MS = 15 * MINUTE_MS;
const MIN_WINDOW_MS = MINUTE_MS;
const MAX_WINDOW_MS = 60 * MINUTE_MS;
// The settling after a source is heard again, until its own is learned.
const DEFAULT_STARTUP_MS = 2 * MINUTE_MS;
// The longest that counts as settling: a departure lasting longer after a
// restart is a fault that began then, not the restart's, and must not keep
// its source's paths quiet after every restart to come.
const MAX_SETTLE_MS = DEFAULT_WINDOW_MS;
const MAX_STARTUP_MS = 5 * MINUTE_MS;
const DEFAULT_CARRY_MS = 20 * MINUTE_MS;
// A carried finding needs its persistence after its path is heard again.
const CARRY_MARGIN_MS = 5 * MINUTE_MS;
const MAX_SOURCES = 200;

// Keyed by source names, which a plugin chooses: no inherited keys.
function createRestarts() {
  return { sources: Object.create(null) };
}

function createEntry() {
  return { reacquire: [], detour: [], at: {} };
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * One path of a source came back `ms` after the restart at `restartAt`:
 * heard again (`reacquire`), or a state path back where it was (`detour`).
 * A source has one observation per restart, its slowest path's: its paths
 * share its window, and eight paths quick this time do not replace the
 * slow restarts before.
 */
function note(restarts, source, kind, ms, restartAt) {
  if (!(ms >= 0)) return;
  // Heard again later than any window reaches - a connection unplugged
  // for a day after the restart - is an outage, not the source's pace.
  if (ms > MAX_WINDOW_MS) return;
  const key = source || 'default';
  const entry = restarts.sources[key] || (restarts.sources[key] = createEntry());
  const list = entry[kind] || (entry[kind] = []);
  if (!entry.at) entry.at = {};
  if (Number.isFinite(restartAt) && entry.at[kind] === restartAt && list.length > 0) {
    list[list.length - 1] = Math.max(list[list.length - 1], Math.round(ms));
    return;
  }
  list.push(Math.round(ms));
  entry.at[kind] = Number.isFinite(restartAt) ? restartAt : undefined;
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
  const keys = Object.keys(restarts.sources);
  if (keys.length > MAX_SOURCES) delete restarts.sources[keys[0]];
}

/** How long a path of this source is given to come back after a restart. */
function windowFor(restarts, source, kind) {
  const entry = restarts.sources[source || 'default'];
  const list = entry && entry[kind];
  if (!Array.isArray(list) || list.length === 0) return DEFAULT_WINDOW_MS;
  return clamp(limitOf(list.map((ms) => Math.max(ms, 1000)), OVERRUN_CHANCE), MIN_WINDOW_MS, MAX_WINDOW_MS);
}

/** A path's own settling after a restart, kept with the path: the last few, none past the longest that counts. */
function noteSettle(settles, ms) {
  const list = Array.isArray(settles) ? settles.filter((value) => Number.isFinite(value) && value >= 0 && value <= MAX_SETTLE_MS) : [];
  if (ms >= 0 && ms <= MAX_SETTLE_MS) list.push(Math.round(ms));
  return list.slice(-KEEP);
}

/**
 * How long a path of this source is in its start-up after a restart: until
 * its source is usually heard again, and the settling after that (a link
 * reconnecting spikes its round-trip time once it is heard) - as long as
 * the path's own departures after restarts (`settles`) have lasted, fitted
 * as the windows are, and never shorter than the default. The path's own,
 * not its source's: a battery's voltage on the plugin whose link spikes at
 * every restart has nothing to settle, and a fault of it just after a
 * restart is still news.
 */
function startupFor(restarts, source, settles = []) {
  const entry = restarts.sources[source || 'default'];
  const list = entry && Array.isArray(entry.reacquire) ? entry.reacquire.slice().sort((a, b) => a - b) : [];
  settles = Array.isArray(settles) ? settles.filter((ms) => Number.isFinite(ms) && ms >= 0 && ms <= MAX_SETTLE_MS) : [];
  const settle = settles.length > 0 ? Math.max(DEFAULT_STARTUP_MS, Math.min(MAX_SETTLE_MS, limitOf(settles.map((ms) => Math.max(ms, 1000)), OVERRUN_CHANCE))) : DEFAULT_STARTUP_MS;
  const heard = list.length > 0 ? list[Math.floor(list.length / 2)] : 0;
  return Math.min(MAX_WINDOW_MS, heard + settle);
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
  for (const source of Object.keys(saved.sources)) {
    const entry = saved.sources[source];
    if (!entry || typeof entry !== 'object') continue;
    const list = (value, most) => (Array.isArray(value) ? value.filter((ms) => Number.isFinite(ms) && ms >= 0 && ms <= most).slice(-KEEP) : []);
    const at = {};
    for (const kind of ['reacquire', 'detour']) {
      if (entry.at && typeof entry.at === 'object' && Number.isFinite(entry.at[kind])) at[kind] = entry.at[kind];
    }
    // Saved before a restart was one observation, and an outage was told
    // from a restart: what is left past the longest window is dropped.
    restarts.sources[source] = {
      reacquire: list(entry.reacquire, MAX_WINDOW_MS),
      detour: list(entry.detour, MAX_WINDOW_MS),
      at
    };
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
  noteSettle,
  startupFor,
  startupMs,
  summary,
  windowFor
};
