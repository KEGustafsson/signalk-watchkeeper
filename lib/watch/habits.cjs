'use strict';

/**
 * What kind of departures a path makes, and comes back from, on its own.
 *
 * The baseline says what a path normally reads. This says what its unusual
 * moments normally look like: a radio link whose packet loss spikes for a
 * minute several times a day, a solar charger that flaps between modes every
 * dusk. Those are this vessel's normal too, one level up, and reporting each
 * of them teaches the crew to ignore the watch.
 *
 * An episode is a stretch where a detector's score stays at or above its
 * clear level. When it ends without the baseline taking it in as the new
 * normal, its peak and length are kept. Once a path has had enough of them,
 * on different occasions, a new one is only news when it goes clearly
 * further, or lasts clearly longer, than they usually did. Nothing is
 * configured: the watch habituates to what it keeps seeing come and go, and
 * a departure of a new size is still reported the first time.
 *
 * Plain JSON on the path state (`state.habits`), saved with it.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Episodes older than this are forgotten: a link that was bad last month is
// not a reason to excuse it now.
const HABIT_WINDOW_MS = 14 * DAY_MS;
// Enough that the kept episodes always span MIN_SPAN_MS: they are more than
// MERGE_MS apart, so 37 of them cover more than six hours, however often the
// path has them (a minute's spike every quarter of an hour included).
const MAX_EPISODES = 40;
// How many episodes, over how long, make a habit: three spikes in one bad
// hour are an incident, not a habit - the least evidence a habit's size and
// spread can be read from.
const MIN_EPISODES = 3;
const MIN_SPAN_MS = 6 * HOUR_MS;
// An episode that starts again before as long as the last one lasted (a
// minute at least) has passed is the same one coming back - a value
// hovering at the edge - not another occasion.
const MIN_MERGE_MS = MINUTE_MS;
// What the text calls the usual size and length: a high quantile of the
// kept episodes.
const QUANTILE = 0.8;
// How far is news is fitted to the path (judge()): the peaks and lengths
// of its episodes, as log-normal, with this much spread assumed until there
// are enough of them to say (a prior worth this many episodes), and the
// alert budget - how many of its routine episodes a day may still be
// reported, from the sensitivity setting.
const PRIOR_LOG_SPREAD = 0.35;
const PRIOR_WEIGHT = 2;
// About one routine episode a month per path may still be reported.
const DEFAULT_ALERTS_PER_DAY = 0.03;

function habitOf(state, key, create) {
  if (!state.habits || typeof state.habits !== 'object') {
    if (!create) return undefined;
    state.habits = {};
  }
  let habit = state.habits[key];
  if (!habit && create) {
    habit = { open: undefined, past: [] };
    state.habits[key] = habit;
  }
  return habit;
}

function forgetOld(habit, t) {
  habit.past = habit.past.filter(([at]) => at > t - HABIT_WINDOW_MS && at <= t);
  if (habit.past.length > MAX_EPISODES) habit.past.splice(0, habit.past.length - MAX_EPISODES);
}

/**
 * Follow one detector's score on one tick. `above`: the score is at or above
 * the level at which that detector's finding would still be open.
 */
function follow(state, key, score, above, t) {
  if (above) {
    const habit = habitOf(state, key, true);
    if (!habit.open) {
      const last = habit.past[habit.past.length - 1];
      if (last && t >= last[0] && t - last[0] <= Math.max(MIN_MERGE_MS, last[2])) {
        // The same episode back again: reopen it rather than count it twice.
        habit.past.pop();
        habit.open = { since: last[0] - last[2], peak: last[1] };
      } else {
        habit.open = { since: t, peak: score };
      }
    }
    if (score > habit.open.peak) habit.open.peak = score;
    return;
  }
  const habit = habitOf(state, key, false);
  if (!habit || !habit.open) return;
  const { since, peak } = habit.open;
  habit.open = undefined;
  if (Number.isFinite(peak) && t >= since) {
    habit.past.push([t, peak, t - since]);
    forgetOld(habit, t);
  }
}

/**
 * The episode in progress of `from` ended with the path settling where it
 * went (accepted as its new level): kept under `to`, a habit of level
 * changes - a daily figure stepping at midnight, a setpoint moved.
 */
function transfer(state, from, to, t) {
  const habit = habitOf(state, from, false);
  if (!habit || !habit.open) return;
  const { since, peak } = habit.open;
  habit.open = undefined;
  if (!Number.isFinite(peak) || t < since) return;
  const target = habitOf(state, to, true);
  target.past.push([t, peak, t - since]);
  forgetOld(target, t);
}

/** The episode in progress did not come back on its own (re-learned, accepted): it is no habit. */
function drop(state, key) {
  const habit = habitOf(state, key, false);
  if (habit) habit.open = undefined;
}

function quantile(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(QUANTILE * sorted.length) - 1)];
}

/** What this path's episodes of `key` usually look like, or undefined if it has no such habit. */
function usual(state, key, t) {
  const habit = habitOf(state, key, false);
  if (!habit) return undefined;
  const past = habit.past.filter(([at]) => at > t - HABIT_WINDOW_MS && at <= t);
  if (past.length < MIN_EPISODES) return undefined;
  const spanMs = past[past.length - 1][0] - past[0][0];
  if (spanMs < MIN_SPAN_MS) return undefined;
  return {
    count: past.length,
    peak: quantile(past.map(([, peak]) => peak)),
    durationMs: quantile(past.map(([, , duration]) => duration)),
    sinceMs: t - past[0][0]
  };
}

/** The standard normal quantile (Acklam's rational approximation). */
function normalQuantile(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * The level a fresh episode exceeds with chance `p`, if the path's episodes
 * so far are what it does: log-normal, the spread shrunk toward a prior
 * while there are few of them.
 */
function limitOf(values, p, reach = 1) {
  const logs = values.map((value) => Math.log(Math.max(value, 1e-9)));
  const n = logs.length;
  const mean = logs.reduce((sum, value) => sum + value, 0) / n;
  const squares = logs.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const spread = Math.sqrt((squares + PRIOR_WEIGHT * PRIOR_LOG_SPREAD ** 2) / (n - 1 + PRIOR_WEIGHT));
  // The spread of a new episode about a mean that is itself estimated.
  const fitted = Math.exp(mean + normalQuantile(1 - p) * spread * Math.sqrt(1 + 1 / n));
  // Never beyond the path's own record by more than its own variation (as
  // far as the sensitivity reaches): a departure further than any it has
  // made and come back from is news, however widely its episodes vary (a
  // fit's tail can reach far past anything the path has done), but one that
  // only edges past the record by the path's own scatter is what a record
  // does now and then.
  return Math.min(fitted, Math.max(...values) * Math.exp(reach * spread));
}

/**
 * Whether a score is news for this path: always, without a habit; with one,
 * only when it goes further, or the episode lasts longer, than the path's
 * episodes would by chance more often than the alert budget allows - a
 * routine spike several times a day may still be reported about once a
 * month (at normal sensitivity), and one of a new size at once. How
 * much further that is follows from how much its episodes vary: a link
 * whose spikes are all alike is news a little beyond them; one whose
 * spikes vary widely, only well beyond.
 */
function judge(state, key, score, t, alertsPerDay = DEFAULT_ALERTS_PER_DAY) {
  const habitual = usual(state, key, t);
  if (!habitual) return { beyond: true, usual: undefined };
  const habit = habitOf(state, key, false);
  const lasted = habit && habit.open ? t - habit.open.since : 0;
  const past = habit.past.filter(([at]) => at > t - HABIT_WINDOW_MS && at <= t);
  const perDay = (past.length / Math.max(habitual.sinceMs, HOUR_MS)) * DAY_MS;
  // The chance an episode may have of being reported, for the budget.
  const p = Math.min(0.5, Math.max(1e-3, alertsPerDay / perDay));
  // How far past its record the sensitivity lets a path go, from the same
  // budget: at normal one spread, less at high, more at low.
  const reach = normalQuantile(1 - Math.min(0.5, alertsPerDay)) / normalQuantile(1 - DEFAULT_ALERTS_PER_DAY);
  const peakLimit = limitOf(past.map(([, peak]) => peak), p, reach);
  const durationLimit = limitOf(past.map(([, , duration]) => Math.max(duration, 1000)), p, reach);
  const fitted = { ...habitual, peakLimit, durationLimit };
  return { beyond: score > peakLimit || lasted > durationLimit, usual: fitted, lasted };
}

/** Whether an episode of `key` is in progress. */
function isOpen(state, key) {
  const habit = habitOf(state, key, false);
  return Boolean(habit && habit.open);
}

/** Every habit the path has, for the report. */
function summary(state, t) {
  if (!state.habits || typeof state.habits !== 'object') return [];
  return Object.keys(state.habits)
    .map((key) => ({ key, ...usual(state, key, t) }))
    .filter((item) => item.count !== undefined);
}

/** The operator said a finding on this path was useful: do not get used to it. */
function forget(state) {
  delete state.habits;
}

/** A saved habit table, cleaned of anything malformed. */
function importHabits(saved, now, { keepOpen = false } = {}) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return undefined;
  const out = {};
  for (const [key, habit] of Object.entries(saved)) {
    if (!habit || !Array.isArray(habit.past)) continue;
    const past = habit.past.filter(
      (entry) => Array.isArray(entry) && entry.length === 3 && entry.every(Number.isFinite) && entry[0] <= now && entry[0] > now - HABIT_WINDOW_MS
    );
    // An episode open when the plugin stopped carries on over a short
    // restart; after a longer one it is not known to have ended on its own.
    const open =
      keepOpen && habit.open && Number.isFinite(habit.open.since) && Number.isFinite(habit.open.peak) && habit.open.since <= now
        ? { since: habit.open.since, peak: habit.open.peak }
        : undefined;
    if (past.length > 0 || open) out[key] = { open, past: past.slice(-MAX_EPISODES) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

module.exports = {
  HABIT_WINDOW_MS,
  MIN_EPISODES,
  drop,
  follow,
  forget,
  importHabits,
  isOpen,
  judge,
  normalQuantile,
  transfer,
  summary,
  usual
};
