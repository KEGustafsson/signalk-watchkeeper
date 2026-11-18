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
 * driver changes at all - the pair is learned. How long an answer takes is
 * not assumed either: the test is made over a minute (a pump's current), a
 * few minutes (a battery's voltage settling) and twenty (a temperature
 * following a heater), the significance shared between them, and the
 * shortest window that holds the answers is the one with the least chance
 * in it. A path that changes all the
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
// against it, each tested: answers come within a minute, within minutes,
// or as slowly as a temperature follows.
const WINDOWS_MS = [MINUTE_MS, 5 * MINUTE_MS, 20 * MINUTE_MS];
const WINDOW_MS = WINDOWS_MS[WINDOWS_MS.length - 1];
// How unlikely by chance a pair must be to be learned, over all windows.
const SIGNIFICANCE = 1e-3;
const MAX_PAIRS = 4000;
// The settling a learned state change gives a path: half again as long as
// its answers to it have lasted, but no longer than a named gate's. An
// answer that lasts as long as the new state does (a current that stays up
// while a watermaker runs) is a new level, not a transient: the path learns
// it within the settling, and has it back the next time (the baseline it
// had in that state), so a longer settle would only blind it.
const MIN_SETTLE_MS = 2 * MINUTE_MS;
const DEFAULT_SETTLE_MS = 15 * MINUTE_MS;
const MAX_SETTLE_MS = DEFAULT_SETTLE_MS;

// Keyed by path names, which plugins choose: no inherited keys.
const dictionary = () => Object.create(null);

function createDrivers(t) {
  // `last`: each path's latest change, as long as it can still be counted.
  return { since: t, transitions: dictionary(), onsets: dictionary(), pairs: dictionary(), learned: dictionary(), last: dictionary(), prunedAt: t };
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
  // Only the latest change of each path is counted against a departure,
  // so one path changing every second takes one entry, not the window's.
  drivers.last[path] = t;
  if (!(t - drivers.prunedAt < WINDOW_MS)) {
    drivers.prunedAt = t;
    for (const [other, at] of Object.entries(drivers.last)) if (t - at > WINDOW_MS) delete drivers.last[other];
  }
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
  for (const [driver, at] of Object.entries(drivers.last)) {
    if (driver === path || t < at || t - at > WINDOW_MS) continue;
    latest.set(driver, at);
  }
  for (const [driver, at] of latest) {
    const key = pairKey(driver, path);
    const pair = drivers.pairs[key] || (drivers.pairs[key] = { k: 0, lagMs: 0 });
    const lag = t - at;
    pair.k += 1;
    pair.lagMs += (lag - pair.lagMs) / pair.k;
    if (!Array.isArray(pair.within)) pair.within = WINDOWS_MS.map(() => 0);
    WINDOWS_MS.forEach((windowMs, index) => {
      if (lag <= windowMs) pair.within[index] += 1;
    });
    const learned = drivers.learned[driver] || [];
    if (learned.includes(path)) continue;
    const rate = (drivers.transitions[driver] || 0) / observed;
    const significant = WINDOWS_MS.some((windowMs, index) => {
      const k = pair.within[index];
      if (k < 2) return false;
      // The chance that a window this long holds a change of the driver
      // anyway, from how often it changes.
      const chance = 1 - Math.exp(-rate * windowMs);
      return k / departures > chance && binomialTail(k, departures, chance) < SIGNIFICANCE / WINDOWS_MS.length;
    });
    if (significant) {
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
  const { last, prunedAt, ...rest } = drivers;
  return rest;
}

function importDrivers(saved, now) {
  const drivers = createDrivers(now);
  if (!saved || typeof saved !== 'object') return drivers;
  if (Number.isFinite(saved.since) && saved.since <= now) drivers.since = saved.since;
  const numbers = (object) =>
    Object.assign(dictionary(), Object.fromEntries(Object.entries(object && typeof object === 'object' ? object : {}).filter(([, value]) => Number.isFinite(value) && value >= 0)));
  drivers.transitions = numbers(saved.transitions);
  drivers.onsets = numbers(saved.onsets);
  for (const [key, pair] of Object.entries(saved.pairs && typeof saved.pairs === 'object' ? saved.pairs : {})) {
    if (!pair || !Number.isFinite(pair.k) || pair.k <= 0) continue;
    const within = Array.isArray(pair.within) && pair.within.length === WINDOWS_MS.length && pair.within.every((k) => Number.isFinite(k) && k >= 0 && k <= pair.k);
    // Counted before there were several windows: within the five minutes
    // that then were the only one, not known for the minute.
    drivers.pairs[key] = { ...pair, within: within ? pair.within.slice() : WINDOWS_MS.map((windowMs) => (windowMs >= 5 * MINUTE_MS ? pair.k : 0)) };
  }
  for (const [driver, list] of Object.entries(saved.learned && typeof saved.learned === 'object' ? saved.learned : {})) {
    if (Array.isArray(list)) drivers.learned[driver] = list.filter((path) => typeof path === 'string');
  }
  prune(drivers);
  return drivers;
}

module.exports = {
  DEFAULT_SETTLE_MS,
  WINDOWS_MS,
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
