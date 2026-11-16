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
// hour are an incident, not a habit.
const MIN_EPISODES = 3;
const MIN_SPAN_MS = 6 * HOUR_MS;
// An episode that starts this soon after the last one ended is the same one
// coming back, not another occasion.
const MERGE_MS = 10 * MINUTE_MS;
// The usual size and length: a high quantile of the kept episodes, not the
// largest, so one real event does not set the bar for good.
const QUANTILE = 0.8;
// How much further than usual is news.
const PEAK_MARGIN = 1.5;
const MIN_EXTRA_MS = 5 * MINUTE_MS;

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
      if (last && t - last[0] <= MERGE_MS && t >= last[0]) {
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

/**
 * Whether a score is news for this path: always, without a habit; with one,
 * only when it goes clearly further than usual, or the episode has lasted
 * clearly longer.
 */
function judge(state, key, score, t) {
  const habitual = usual(state, key, t);
  if (!habitual) return { beyond: true, usual: undefined };
  const habit = habitOf(state, key, false);
  const lasted = habit && habit.open ? t - habit.open.since : 0;
  const longer = lasted > Math.max(2 * habitual.durationMs, habitual.durationMs + MIN_EXTRA_MS);
  return { beyond: score > PEAK_MARGIN * habitual.peak || longer, usual: habitual, lasted };
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
function importHabits(saved, now) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return undefined;
  const out = {};
  for (const [key, habit] of Object.entries(saved)) {
    if (!habit || !Array.isArray(habit.past)) continue;
    const past = habit.past.filter(
      (entry) => Array.isArray(entry) && entry.length === 3 && entry.every(Number.isFinite) && entry[0] <= now && entry[0] > now - HABIT_WINDOW_MS
    );
    // An episode open when the plugin stopped is not known to have ended on its own.
    if (past.length > 0) out[key] = { open: undefined, past: past.slice(-MAX_EPISODES) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

module.exports = {
  HABIT_WINDOW_MS,
  MIN_EPISODES,
  PEAK_MARGIN,
  drop,
  follow,
  forget,
  importHabits,
  judge,
  summary,
  usual
};
