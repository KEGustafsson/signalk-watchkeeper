'use strict';

/**
 * Operating states learned from the data: which paths' changes other paths
 * answer.
 *
 * The named gates (an engine's revolutions, a charger's mode, the vessel's
 * state, the sun) are what most boats have, but not all that a boat has: a
 * watermaker starting, a fridge compressor, a generator, an inverter that a
 * plugin names its own way. Rather than a list of names, the watch watches
 * what happens: every time a departure begins on a path, the watch notes
 * which paths changed state (a discrete path's new value, a gate's new
 * regime) in the minutes before. If a path's departures follow one
 * driver's changes far more often than a window that long would contain a
 * change of that driver by chance - a binomial tail, against how often the
 * driver changes at all - the pair is learned. A path that changes all the
 * time (a timestamp, a counter as text) is in every window, and so explains
 * nothing; a watermaker that starts every two hours explains the current
 * that rises each time. From then
 * on that change is an operating-state change for that path, which re-learns
 * through it (and comes back to the baseline it had in that state) instead
 * of being reported.
 *
 * Plain JSON, saved with the engine's state. Counts are bounded: pairs past
 * the cap are dropped weakest first.
 */

const MINUTE_MS = 60 * 1000;
// How long after a change a departure may begin and still be counted
// against it: the slowest answer (a battery's voltage settling after a
// charger stops) takes minutes.
const WINDOW_MS = 5 * MINUTE_MS;
// How unlikely by chance a pair must be to be learned.
const SIGNIFICANCE = 1e-3;
const MAX_PAIRS = 4000;
const MAX_RECENT = 1000;
// The settling a learned state change gives a path: half again as long as
// its answers to it have lasted, but no longer than a named gate's. An
// answer that lasts as long as the new state does (a current that stays up
// while a watermaker runs) is a new level, not a transient: the path learns
// it within the settling, and has it back the next time (the baseline it
// had in that state), so a longer settle would only blind it.
const MIN_SETTLE_MS = 2 * MINUTE_MS;
const DEFAULT_SETTLE_MS = 15 * MINUTE_MS;
const MAX_SETTLE_MS = DEFAULT_SETTLE_MS;

function createDrivers(t) {
  return { since: t, transitions: {}, onsets: {}, pairs: {}, learned: {}, recent: [] };
}

function pairKey(driver, path) {
  return `${driver}\u0000${path}`;
}

/** P(X >= k) for X binomial with n trials of chance p. */
function binomialTail(k, n, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (!(p > 0)) return 0;
  if (p >= 1) return 1;
  // Summed from the k-th term in log space: n is the departures a path
  // has had, thousands at most.
  const logP = Math.log(p);
  const logQ = Math.log1p(-p);
  let logTerm = logChoose(n, k) + k * logP + (n - k) * logQ;
  let total = 0;
  for (let i = k; i <= n; i += 1) {
    total += Math.exp(logTerm);
    logTerm += Math.log((n - i) / (i + 1)) + logP - logQ;
    if (logTerm < -745) break;
  }
  return Math.min(1, total);
}

function logChoose(n, k) {
  let result = 0;
  for (let i = 1; i <= k; i += 1) result += Math.log((n - k + i) / i);
  return result;
}

/** P(X >= k) for X Poisson with mean `mean`. */
function poissonTail(k, mean) {
  if (k <= 0) return 1;
  if (!(mean > 0)) return 0;
  let term = Math.exp(-mean);
  let below = term;
  for (let i = 1; i < k; i += 1) {
    term *= mean / i;
    below += term;
  }
  return Math.max(0, 1 - below);
}

/** A path changed state: its value, or its regime. */
function noteTransition(drivers, path, t) {
  drivers.transitions[path] = (drivers.transitions[path] || 0) + 1;
  drivers.recent.push({ path, t });
  const cutoff = t - WINDOW_MS;
  while (drivers.recent.length > 0 && (drivers.recent[0].t < cutoff || drivers.recent.length > MAX_RECENT)) drivers.recent.shift();
}

/**
 * A departure began on `path`. Returns the changes it is counted against,
 * and the drivers it has made significant just now.
 */
function noteOnset(drivers, path, t) {
  const departures = (drivers.onsets[path] = (drivers.onsets[path] || 0) + 1);
  const learnedNow = [];
  const observed = Math.max(WINDOW_MS, t - drivers.since);
  // Each driver once, with its latest change in the window before.
  const latest = new Map();
  for (const change of drivers.recent) {
    if (change.path === path || t < change.t || t - change.t > WINDOW_MS) continue;
    latest.set(change.path, change.t);
  }
  for (const [driver, at] of latest) {
    const key = pairKey(driver, path);
    const pair = drivers.pairs[key] || (drivers.pairs[key] = { k: 0, lagMs: 0 });
    pair.k += 1;
    pair.lagMs += (t - at - pair.lagMs) / pair.k;
    const learned = drivers.learned[driver] || [];
    if (learned.includes(path) || pair.k < 2) continue;
    // The chance that a window this long holds a change of the driver
    // anyway, from how often it changes.
    const chance = 1 - Math.exp(-((drivers.transitions[driver] || 0) / observed) * WINDOW_MS);
    if (pair.k / departures > chance && binomialTail(pair.k, departures, chance) < SIGNIFICANCE) {
      drivers.learned[driver] = [...learned, path];
      learnedNow.push(driver);
    }
  }
  prune(drivers);
  return { credited: [...latest.keys()], learnedNow };
}

/** A departure counted against these changes ended, after `durationMs`. */
function noteEpisodeEnd(drivers, path, credited, durationMs) {
  if (!Array.isArray(credited) || !(durationMs > 0)) return;
  for (const driver of credited) {
    const pair = drivers.pairs[pairKey(driver, path)];
    if (!pair) continue;
    pair.ends = (pair.ends || 0) + 1;
    pair.durationMs = pair.durationMs === undefined ? durationMs : pair.durationMs + (durationMs - pair.durationMs) / pair.ends;
  }
}

function prune(drivers) {
  const keys = Object.keys(drivers.pairs);
  if (keys.length <= MAX_PAIRS) return;
  const learned = new Set(Object.entries(drivers.learned).flatMap(([driver, list]) => list.map((path) => pairKey(driver, path))));
  keys
    .filter((key) => !learned.has(key))
    .sort((a, b) => drivers.pairs[a].k - drivers.pairs[b].k)
    .slice(0, keys.length - MAX_PAIRS)
    .forEach((key) => delete drivers.pairs[key]);
}

/** The paths a change of `driver` has been learned to move. */
function affectedBy(drivers, driver) {
  return (drivers.learned[driver] || []).slice();
}

/** How long a change of `driver` settles the paths it moves: from how long their answers lasted. */
function settleFor(drivers, driver) {
  const durations = affectedBy(drivers, driver)
    .map((path) => drivers.pairs[pairKey(driver, path)])
    .filter((pair) => pair && Number.isFinite(pair.durationMs))
    .map((pair) => 1.5 * pair.durationMs);
  if (durations.length === 0) return DEFAULT_SETTLE_MS;
  return Math.min(MAX_SETTLE_MS, Math.max(MIN_SETTLE_MS, Math.max(...durations)));
}

/** What the watch has learned, for the inventory: driver -> the paths it moves, with how sure. */
function summary(drivers) {
  return Object.entries(drivers.learned).map(([driver, list]) => ({
    driver,
    transitions: drivers.transitions[driver] || 0,
    paths: list.map((path) => {
      const pair = drivers.pairs[pairKey(driver, path)] || {};
      return { path, together: pair.k || 0, lagMs: Math.round(pair.lagMs || 0), answerMs: Number.isFinite(pair.durationMs) ? Math.round(pair.durationMs) : undefined };
    })
  }));
}

function exportDrivers(drivers) {
  const { recent, ...rest } = drivers;
  return rest;
}

function importDrivers(saved, now) {
  const drivers = createDrivers(now);
  if (!saved || typeof saved !== 'object') return drivers;
  if (Number.isFinite(saved.since) && saved.since <= now) drivers.since = saved.since;
  const numbers = (object) =>
    Object.fromEntries(Object.entries(object && typeof object === 'object' ? object : {}).filter(([, value]) => Number.isFinite(value) && value >= 0));
  drivers.transitions = numbers(saved.transitions);
  drivers.onsets = numbers(saved.onsets);
  for (const [key, pair] of Object.entries(saved.pairs && typeof saved.pairs === 'object' ? saved.pairs : {})) {
    if (pair && Number.isFinite(pair.k) && pair.k > 0) drivers.pairs[key] = { ...pair };
  }
  for (const [driver, list] of Object.entries(saved.learned && typeof saved.learned === 'object' ? saved.learned : {})) {
    if (Array.isArray(list)) drivers.learned[driver] = list.filter((path) => typeof path === 'string');
  }
  prune(drivers);
  return drivers;
}

module.exports = {
  DEFAULT_SETTLE_MS,
  WINDOW_MS,
  affectedBy,
  createDrivers,
  exportDrivers,
  importDrivers,
  noteEpisodeEnd,
  noteOnset,
  noteTransition,
  binomialTail,
  poissonTail,
  settleFor,
  summary
};
