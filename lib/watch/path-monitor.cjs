'use strict';

const { linearTrend, timeAlpha, wrapPi } = require('./stats.cjs');
const { isAnglePath, isSpeedPath, isTemperaturePath } = require('../signalk-units.cjs');
const habits = require('./habits.cjs');

/**
 * Per-path learned behaviour and the checks that run on it.
 *
 * One plain, JSON-serialisable object per Signal K path, updated in O(1) per
 * sample, so the whole vessel's baseline can be saved to disk and survive a
 * restart without a fresh learning period. Nothing here knows about Signal K
 * deltas, notifications or time sources: the engine feeds it samples and asks
 * it questions.
 *
 * What it learns, per path:
 *   - how often the path updates (for dropout)
 *   - for a continuous number: a slow baseline mean and spread, a fast
 *     average, how often consecutive samples differ, the sensor's resolution
 *   - for a discrete value (string, boolean, small integer set): which values
 *     it takes and how often it switches between them
 *   - a minute-by-minute series for trend forecasts and incident evidence
 *   - how long it usually holds one value, per operating state (for frozen)
 *   - what its departures usually look like, and come back from (habits.cjs)
 *   - for a counter: the fastest it has counted in the past week (for rate)
 */

const FAST_HALF_LIFE_MS = 8 * 1000;
const SLOW_HALF_LIFE_MS = 30 * 60 * 1000;
// Samples needed before the path's kind (continuous vs discrete) is decided.
const KIND_DECISION_SAMPLES = 20;
// How many more cycle outages a settled path needs before they are its rhythm.
const SETTLED_CYCLE_FACTOR = 3;
const MAX_DISTINCT_FOR_DISCRETE = 4;
const MAX_TRACKED_STATES = 32;
// A winsorised update: one wild sample moves the baseline by at most this many
// standard deviations' worth, so a single glitch cannot desensitise the path
// for the next half hour.
const CLAMP_SIGMAS = 4;
const RECENT_BUCKET_MS = 10 * 1000;
const RECENT_BUCKETS = 60;
const MINUTE_BUCKET_MS = 60 * 1000;
const MINUTE_BUCKETS = 90;
// Transitions are counted per minute for the last hour, so the count is exact
// however fast a switch cycles; a capped list of timestamps undercounted a
// busy hour and let the excess leak into the "usual" rate.
const TRANSITION_BUCKET_MS = 60 * 1000;
// Step sizes remembered for confirming the sensor's resolution.
const RECENT_STEPS = 8;
const HOUR_MS = 60 * 60 * 1000;
// Long gaps in a row needed to take a slower update rate as the path's own,
// the same rule as the GNSS fix interval. Until then each gap counts as an
// outage and is left out of the usual interval.
const LONG_GAPS_FOR_RATE = 8;
// A fall to at most this share of the value before it is a drop to zero: a
// named counter's reset, or another path's candidate reset.
const RESET_FRACTION = 0.01;
// Rises from zero, after such a drop, that show the path counting again.
const RESET_CONFIRM_RISES = 5;
// A path that has risen this many times in a row may also be reset to a
// lower value that is not zero: a link that restarts its sequence numbers
// somewhere else.
const RESET_CLIMB = 100;
// A path that has only ever counted needs fewer rises to show it counts
// again (a retransmission count may tick twice in an hour), and its level
// check waits up to this long for them.
const RESET_COUNTING_RISES = 2;
const RESET_COUNTING_HOLD_MS = 6 * HOUR_MS;
// The longest a state path's restart detour lasts (inDetour()).
const RESTART_DETOUR_MS = 15 * 60 * 1000;
// Readings after a restart that show a path is heard again (evaluateDropout()).
const REACQUIRE_READS = 2;

// How long a path holds one value, learned from the runs it came out of:
// time spent in runs of each length, by powers of two of a second, per
// operating state. Weighted by time, so a sensor's rare plateaus count for
// what they are: a cabin temperature that sits still for ten minutes twice a
// day spends more than 1 % of its time in such runs, and a ten-minute
// plateau is then not "stuck"; a wind sensor that never holds a value for
// more than two seconds is stuck after five minutes of one.
const RUN_BINS = 22;
const RUN_HALF_LIFE_MS = 7 * 24 * HOUR_MS;
// Before this many runs over this much time, the path's habit is unknown,
// and nothing is called stuck.
const RUN_MIN_COUNT = 30;
const RUN_MIN_TIME_MS = 30 * 60 * 1000;
const RUN_QUANTILE = 0.99;
// Stuck: holding a value this many times longer than it normally does
// (beyond the upper edge of the bin its usual runs end in).
const RUN_FACTOR = 2;
const MAX_RUN_REGIMES = 6;
// How much of the path's holding a hold is judged against: the runs learned
// must add up to this many times the limit. Half an hour of a wind sensor's
// one-second runs is enough to call five minutes of one value stuck; half an
// hour of a sea-water temperature's quarter-hour plateaus is not enough to
// call fifty minutes stuck.
const RUN_EVIDENCE_FACTOR = 6;
// A hold longer than the least a stuck finding needs is judged only once the
// runs learned cover a day of watching - observed time, so neither the hours
// the plugin was down nor a sensor's spells of no value count: slow sensors
// sit still longest at night, and the first evening has not seen a night.
const RUN_DAY_MS = 24 * HOUR_MS;

/**
 * The smallest spread worth calling variation, in SI units, by what the path
 * measures. Without a floor a perfectly steady signal - a tank level that has
 * not moved all day - has zero spread, and the first 0.1% change would read as
 * infinitely many standard deviations.
 */
function unitNoiseFloor(path, units) {
  const unit = typeof units === 'string' ? units : undefined;
  if (unit === 'K' || (!unit && isTemperaturePath(path))) return 0.3;
  if (unit === 'rad' || (!unit && isAnglePath(path))) return 0.02;
  if (unit === 'm/s' || (!unit && isSpeedPath(path))) return 0.1;
  if (unit === 'V' || (!unit && /\.voltage$/.test(path))) return 0.05;
  if (unit === 'A' || (!unit && /\.current$/.test(path))) return 0.3;
  if (unit === 'W' || (!unit && /\.power$/.test(path))) return 5;
  if (unit === 'Pa' || (!unit && /[Pp]ressure$/.test(path))) return 30;
  if (unit === 'ratio' || (!unit && /\.(?:stateOfCharge|currentLevel|relativeHumidity|stateOfHealth)$/.test(path))) {
    return 0.005;
  }
  if (unit === 'Hz' || (!unit && /\.revolutions$/.test(path))) return 0.3;
  if (unit === 'm3/s') return 1e-7;
  if (unit === 'm') return 0.1;
  return undefined;
}

function createPathState(path, t) {
  return {
    path,
    kind: 'unknown',
    angle: isAnglePath(path),
    n: 0,
    firstAt: t,
    lastAt: t,
    acceptedAt: undefined,
    intervalMean: undefined,
    // A run of gaps too long to be the usual interval (see learnInterval()).
    longGaps: 0,
    longGapRun: undefined,
    source: undefined,
    units: undefined,
    displayName: undefined,
    zones: undefined,
    // continuous
    last: undefined,
    unwrapped: undefined,
    fast: undefined,
    mean: undefined,
    variance: 0,
    quantum: undefined,
    distinct: [],
    allInteger: true,
    monotonic: true,
    rose: false,
    rises: 0,
    // Falls that were not a counter's reset, and resets it came back from;
    // when the last of each was, and rises since the last fall.
    falls: 0,
    resets: 0,
    fallAt: undefined,
    resetAt: undefined,
    climb: 0,
    recentSteps: [],
    sameCount: 0,
    sameSince: t,
    relearnUntil: 0,
    relearnN: 0,
    excursionSince: undefined,
    accepted: 0,
    // discrete
    lastValue: undefined,
    seen: {},
    seenOverflow: false,
    transitionMinutes: [],
    transitionTotal: 0,
    newStateAt: undefined,
    newStateValue: undefined,
    // series
    minuteBucket: undefined,
    minutes: [],
    recentBucket: undefined,
    recent: []
  };
}

function pushBucket(state, bucketKey, seriesKey, bucketMs, limit, t, value) {
  const start = Math.floor(t / bucketMs) * bucketMs;
  const bucket = state[bucketKey];
  if (bucket && bucket.start === start) {
    bucket.sum += value;
    bucket.count += 1;
    return;
  }
  if (bucket && bucket.count > 0) {
    state[seriesKey].push([bucket.start + bucketMs / 2, bucket.sum / bucket.count]);
    if (state[seriesKey].length > limit) {
      state[seriesKey].splice(0, state[seriesKey].length - limit);
    }
  }
  state[bucketKey] = { start, sum: value, count: 1 };
}

/** The series including the still-open bucket, oldest first. */
function seriesWithOpen(state, seriesKey, bucketKey, bucketMs) {
  const bucket = state[bucketKey];
  const series = state[seriesKey].slice();
  if (bucket && bucket.count > 0) {
    series.push([bucket.start + bucketMs / 2, bucket.sum / bucket.count]);
  }
  return series;
}

function classifyValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? 'number' : 'invalid';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return 'discrete';
  }
  if (value === null) {
    return 'discrete';
  }
  return 'invalid';
}

/**
 * Continuous or discrete, for a numeric path. Re-decided on every sample, but
 * it can only move one way: a small integer set (a pump state of 0/1, an
 * engine at 0 rpm) is discrete until it takes a fifth value or a fraction,
 * and from then on it is continuous for good.
 */
function decideKind(state, t) {
  if (state.kind === 'continuous') {
    return;
  }
  // A measurement - by name (rssi, a temperature, a ratio) or unit (V, dBm)
  // - is never a state code, however few whole values it has shown: a
  // signal strength sitting at -42 and -43 dBm for the first minutes is not
  // in state "-42", and -36 is not a new state of it. Decided as soon as it
  // is known, which may be when its metadata arrives.
  if (isMeasurement(state)) {
    state.kind = 'continuous';
    state.distinct = null;
    endRedecision(state);
    return;
  }
  if (state.distinct === null || !state.allInteger) {
    state.kind = 'continuous';
    endRedecision(state);
    return;
  }
  // Samples since the kind was last open to decision (a re-decision after
  // the counter listing changed starts this over; n does not).
  if ((state.kindN ?? state.n) >= KIND_DECISION_SAMPLES) {
    state.kind = 'discrete';
    if (state.redecideFrom !== undefined) {
      becameDiscreteAgain(state, t);
    }
  }
}

/**
 * A re-decided path has just turned out discrete. What it learned as a
 * continuous path says nothing about how it switches, so the switching
 * history starts here, and the values it took while being decided are its
 * known states. States first seen in the next while are learned without a
 * finding, from now - not from the restart, which for a path that changes
 * once in ten minutes is hours before its kind is known.
 */
function becameDiscreteAgain(state, t) {
  if (Number.isFinite(t)) {
    if (state.redecideFrom !== 'discrete') {
      state.transitionsSince = t;
      state.transitionTotal = 0;
      state.transitionMinutes = [];
    }
    if (Number.isFinite(state.redecideQuietMs)) {
      state.newStateQuietUntil = Math.max(state.newStateQuietUntil || 0, t + state.redecideQuietMs);
    }
  }
  for (const value of state.distinct || []) {
    const key = String(value);
    if (!(key in state.seen) && Object.keys(state.seen).length < MAX_TRACKED_STATES) {
      state.seen[key] = 1;
    }
  }
  endRedecision(state);
}

function endRedecision(state) {
  state.redecideFrom = undefined;
  state.redecideQuietMs = undefined;
}

/**
 * While the watch starts up (options.startupUntil), every plugin announces
 * its states again, and some pass through another on the way (a link that
 * reads "down" until it has connected). Those switches are not the path's:
 * they are not counted toward cycling, and a value first seen then is a new
 * state only if the path still holds it when the start-up is over
 * (settleStartup()).
 */
function inStartup(t, options, state) {
  // A path's own start-up, if its source's pace after restarts is known
  // (the engine sets it); the whole watch's otherwise.
  const until = state && Number.isFinite(state.startupUntil) ? state.startupUntil : options && options.startupUntil;
  return Number.isFinite(until) && t < until;
}

/**
 * After a restart, a state path can take longer than the start-up to settle:
 * an under-keel plugin reads "off" until it has worked out its first
 * clearance, minutes later, and then "alarm" again as before. Until the path
 * is back on the value it had before the restart (state.restartFrom), or for
 * RESTART_DETOUR_MS at most, it is on the restart's detour: its switches are
 * not counted, and a value first seen then waits (settleStartup()).
 */
function inDetour(state, t) {
  return state.restartFrom !== undefined && Number.isFinite(state.restartUntil) && t < state.restartUntil;
}

function countTransition(state, t) {
  const minute = Math.floor(t / TRANSITION_BUCKET_MS) * TRANSITION_BUCKET_MS;
  const buckets = state.transitionMinutes;
  const latest = buckets[buckets.length - 1];
  if (latest && latest[0] === minute) {
    latest[1] += 1;
  } else {
    buckets.push([minute, 1]);
  }
  while (buckets.length > 0 && buckets[0][0] <= t - HOUR_MS - TRANSITION_BUCKET_MS) {
    buckets.shift();
  }
  state.transitionTotal += 1;
}

/**
 * Whether a value never seen before is a new state of the path. A word or
 * a flag always is; so is a number's first change from the one value it
 * has had (an alarm flag going from 0 to 1), and any change of a path named
 * as a state code. After that, a number is only once the path has shown it
 * is a code, by going back to a value it had before (a charger 3, 4, 3): a
 * whole-number reading that keeps taking new values - a daily figure, a
 * signal strength - is measuring, and its next new value is not news.
 */
function revisitsStates(state, numeric) {
  if (!numeric || isStateCodeLeaf(state.path)) return true;
  return Object.keys(state.seen).length <= 1 || (state.revisits || 0) >= 1;
}

function recordDiscrete(state, key, t, ready, options, numeric = false) {
  const switched = state.lastValue !== undefined && state.lastValue !== key;
  // A switch the restart made (a plugin sending 0 until it has read, then
  // its 5 again) is no evidence that the path goes back to its states.
  const restartSwitch = switched && (inStartup(t, options, state) || inDetour(state, t));
  if (switched && !restartSwitch && key in state.seen) state.revisits = (state.revisits || 0) + 1;
  if (numeric) state.numericStates = true;
  if (switched && inDetour(state, t) && key === state.restartFrom) {
    // Back where it was before the restart: the detour was the restart's,
    // and nothing on it was news.
    state.restartFrom = undefined;
    state.startupNew = undefined;
  } else if (switched && (inStartup(t, options, state) || inDetour(state, t))) {
    // Whether it would be news is decided now, as it is outside the
    // start-up - before the value is among the states seen - and it is
    // reported, or not, once the start-up is over (settleStartup()).
    if (!(key in state.seen) && !state.seenOverflow && revisitsStates(state, numeric)) {
      if (!Array.isArray(state.startupNew)) state.startupNew = [];
      if (!state.startupNew.includes(key)) state.startupNew.push(key);
    }
  } else if (switched) {
    countTransition(state, t);
    // After a re-decision of the kind, states seen meanwhile are learned
    // quietly for a while: only the new-state check waits, not the baseline.
    const quiet = Number.isFinite(state.newStateQuietUntil) && t < state.newStateQuietUntil;
    if (ready && !quiet && !state.seenOverflow && !(key in state.seen) && revisitsStates(state, numeric)) {
      state.newStateAt = t;
      state.newStateValue = key;
    }
  }
  if (key in state.seen) {
    state.seen[key] += 1;
  } else if (Object.keys(state.seen).length < MAX_TRACKED_STATES) {
    state.seen[key] = 1;
  } else {
    state.seenOverflow = true;
  }
  state.lastValue = key;
}

/**
 * Learn how often the path updates from one gap between accepted samples.
 *
 * An outage is not the path's rate. A gap long enough to be a dropout is left
 * not counted in the usual interval when it follows regular samples, or one
 * hour of silence would stretch a 30 s sensor's "usual" past the regularity
 * limit and its next outage would go unreported. Long gaps one after another
 * count, up to the dropout limit (below). A path that really slowed down (or a slower source taking over)
 * shows as a run of long gaps of about one size: eight in a row, each within
 * half of the run's mean so far, are its new rate (their mean). Scattered or
 * growing gaps stay outages. The same rule as the GNSS fix interval.
 */
function learnInterval(state, dt, options) {
  // The longest gaps past a regular path's that the path has come back
  // from: a raised path's long silences are judged against them
  // (evaluateDropout). A gap of up to a day that ends while the interval is
  // already raised is the sender's rhythm (its evenings and its nights) and
  // is kept, also across a regular day: a nightly silence is not a dropout
  // every night. A gap that ends while the interval is still a regular
  // path's, or one longer than a day (a slow sensor unplugged for two days),
  // is an outage, judged (and reported) as one: it counts as two hours at
  // most, and only until the path settles regular again, so the first quiet
  // spell of a sender's night still counts, and two days unplugged do not
  // make a later death wait three days.
  const regularLimit = options.maxRegularIntervalMs ?? 60000;
  if (dt > regularLimit) {
    if (state.intervalMean > regularLimit && dt <= RHYTHM_GAP_MS) {
      state.longestGap = Math.max(state.longestGap || 0, dt);
    } else {
      state.outageGap = Math.max(state.outageGap || 0, Math.min(dt, 2 * RAISED_SILENCE_MS));
    }
  }
  const limit = Math.max(options.dropoutMinMs ?? 30000, (options.dropoutFactor ?? 10) * (state.intervalMean ?? 0));
  const outage = state.intervalMean !== undefined && dt > limit;
  if (!outage) {
    state.longGaps = 0;
    state.longGapRun = undefined;
    state.intervalMean = state.intervalMean === undefined ? dt : state.intervalMean + 0.1 * (dt - state.intervalMean);
    // The interval as its regular gaps give it, before any run of long gaps
    // raised it (below): only while the interval is still a regular path's,
    // so ordinary long gaps after the rise do not carry it up with them, and
    // one short gap after the rise (a second reading a few seconds after a
    // long gap) does not copy the raised interval into it.
    if (state.intervalMean <= (options.maxRegularIntervalMs ?? 60000)) state.regularMean = state.intervalMean;
    // A settled regular stretch: from now on outages are the sensor
    // failing, never a rhythm (below).
    // A settled regular stretch is gaps short enough for a regular path in
    // a row: a slow cycle's normal gaps (five minutes) are not one, and a
    // burst of a few readings between them is too short to be one.
    if (dt <= (options.maxRegularIntervalMs ?? 60000)) {
      state.regularRun = (state.regularRun || 0) + 1;
    } else {
      state.regularRun = 0;
    }
    if (state.regularRun > (options.minSamples ?? 30)) {
      state.settled = true;
      // Regular again: a cycle learned before no longer sets its limit, and
      // the outages it came back from while regular are forgotten - two days
      // unplugged must not make a later death wait three days. The gaps of
      // its rhythm (longestGap) are kept.
      state.cycleLimit = undefined;
      state.outageGap = undefined;
    }
    // A burst between outages of a repeating cycle (below).
    if (state.cycleOutages > 0) {
      state.sinceOutage += 1;
      state.cycleTime += dt;
      state.cycleGaps += 1;
      if (state.sinceOutage > (options.minSamples ?? 30)) state.cycleOutages = 0;
    }
    return;
  }
  state.regularRun = 0;
  learnCycle(state, dt, options);
  // An outage after regular samples is not learned, so a flaky sensor (a
  // few samples between outages) keeps its interval and every outage is
  // reported. Outages right after one another - a sender that reports on
  // change and is quiet at night, or one that really slowed down - are that
  // sender's rhythm: each counts up to the dropout limit, so the night is
  // not reported gap by gap.
  if (state.longGaps > 0) {
    state.intervalMean += 0.1 * (limit - state.intervalMean);
  }
  const run = state.longGapRun;
  if (run === undefined || !(state.longGaps > 0) || Math.abs(dt - run) > 0.5 * run) {
    state.longGapRun = dt;
    state.longGaps = 1;
  } else {
    state.longGaps += 1;
    state.longGapRun = run + (dt - run) / state.longGaps;
  }
  if (state.longGaps >= LONG_GAPS_FOR_RATE) {
    // A plain slower rate replaces any cycle learned before.
    state.cycleLimit = undefined;
    state.cycleRun = undefined;
    state.cycleMax = undefined;
    state.intervalMean = state.longGapRun;
    // A confirmed slower rate is the path's rate now. The interval it was
    // regular at is kept (regularMean), so a path that was regular before
    // is still watched, at its new rate (evaluateDropout).
    state.longGaps = 0;
    state.longGapRun = undefined;
  }
}

/**
 * A sender whose outages come between short bursts, again and again - a
 * pair of readings every five minutes, a sensor that wakes to report - has
 * that cycle for its rhythm. Eight outages of about one size (each within
 * half of their mean), each after fewer regular samples than a path needs
 * to settle, make the cycle's mean gap its interval, as eight long gaps in a
 * row do. A path that has had a settled regular stretch (more regular gaps
 * in a row than a path needs to settle) needs three times as many - 24 -
 * before its outages are taken as a rhythm: until then they are the sensor
 * failing, and each is reported, however regular.
 */
function learnCycle(state, dt, options) {
  const run = state.cycleRun;
  const continues =
    state.cycleOutages > 0 && state.sinceOutage <= (options.minSamples ?? 30) && Number.isFinite(run) && Math.abs(dt - run) <= 0.5 * run;
  if (continues) {
    state.cycleOutages += 1;
    state.cycleRun = run + (dt - run) / state.cycleOutages;
    state.cycleMax = Math.max(state.cycleMax || 0, dt);
  } else {
    state.cycleOutages = 1;
    state.cycleRun = dt;
    state.cycleMax = dt;
    state.cycleTime = 0;
    state.cycleGaps = 0;
  }
  state.cycleTime += dt;
  state.cycleGaps += 1;
  state.sinceOutage = 0;
  // A settled path needs three times as many before it is taken as the
  // sender's new rhythm: twenty outages of a failing sensor are each still
  // reported, while a sender that really changed to bursts is not reported
  // for ever.
  const needed = state.settled ? SETTLED_CYCLE_FACTOR * LONG_GAPS_FOR_RATE : LONG_GAPS_FOR_RATE;
  if (state.cycleOutages >= needed) {
    state.intervalMean = state.cycleTime / state.cycleGaps;
    // The cycle's longest silence is known: a silence twice that is still a
    // dropout, even when the cycle's mean gap is too long to call the path
    // regular - a sensor that fails in a rhythm and then dies is reported.
    state.cycleLimit = 2 * (state.cycleMax || state.cycleRun);
    state.cycleOutages = 0;
    state.settled = false;
  }
}

/**
 * Feed one sample. Returns false when the sample was ignored (throttled,
 * unusable), true when it was taken.
 */
function observe(state, value, t, options) {
  // Signal K's null is "no value available" - a Bluetooth sensor out of
  // range, a charger reconnecting - never a state the path is in. It is not
  // a sample either: a path that keeps sending null has stopped reporting,
  // and its dropout says so (evaluateDropout()).
  if (value === null) {
    if (t >= state.lastAt) {
      state.nullAt = t;
      if (state.nullSince === undefined) {
        state.nullSince = t;
        // The value held before it is not known to have been held through it.
        state.runBroken = true;
      }
    }
    return false;
  }
  const type = classifyValue(value);
  if (type === 'invalid') {
    return false;
  }

  const key = type === 'number' ? value : String(value);
  const changed = state.n === 0 ? true : type === 'number' ? value !== state.last : key !== state.lastValue;

  // A discrete change is always taken - a bilge pump that ran for half a
  // second is exactly the event worth seeing - but repeats are throttled.
  if (
    state.acceptedAt !== undefined &&
    t - state.acceptedAt < options.minIntervalMs &&
    !(changed && (type === 'discrete' || state.kind === 'discrete'))
  ) {
    state.lastAt = Math.max(state.lastAt, t);
    return false;
  }

  const dt = state.acceptedAt === undefined ? 0 : t - state.acceptedAt;
  if (dt < 0) {
    // Out of order: keep the newest, ignore the straggler.
    return false;
  }
  if (dt > 0) {
    // A run of one value that a silence interrupted is not a run the sensor
    // held: what it did during the outage is unknown. The hold starts again
    // at the sample that ended the silence (a sensor that comes back stuck
    // is judged from then), and the interrupted run is not learned.
    if (state.intervalMean !== undefined && dt > Math.max(options.dropoutMinMs ?? 30000, (options.dropoutFactor ?? 10) * state.intervalMean)) {
      restartHold(state, t);
    }
    learnInterval(state, dt, options);
  }
  // Reading again after a spell of no value: a hold starts here, whatever
  // the value was before it.
  if (state.nullSince !== undefined && state.n > 0) restartHold(state, t);
  state.nullSince = undefined;
  if (Number.isFinite(state.readsSinceRestart)) state.readsSinceRestart += 1;
  // The sample before this one: two samples since a silence began are
  // evidence that the path's connection still lives (the engine's feed
  // check).
  state.prevAt = state.acceptedAt;
  state.acceptedAt = t;
  state.lastAt = t;
  state.n += 1;
  state.kindN = (state.kindN ?? state.n - 1) + 1;

  const ready = isReady(state, t, options);

  if (type === 'discrete') {
    state.kind = 'discrete';
    state.distinct = null;
    // A word or a flag settles any pending re-decision: its kind is known.
    endRedecision(state);
    recordDiscrete(state, key, t, ready, options);
    return true;
  }

  // Numbers: track enough to decide continuous vs discrete. A listed counter
  // is never discrete, however few values it has had: twelve engine starts
  // going to thirteen is a count, not a new state. Under a pattern, a path
  // named as a state code (chargerState, inverterMode) still classifies
  // itself, so it keeps its new-state check beside the counters.
  if (counterListing(state) !== 'self') {
    state.distinct = null;
  }
  // The most decimals the sender has used: a host monitor that sends disk
  // use as 0.29 and 0.3 reports in steps of 0.01, which says its resolution
  // before any step has been seen three times (noiseFloor()).
  // Learned at the baseline only - within 5 % of its mean, the band the noise
  // floor works in: a departure does not set the resolution it is judged by
  // (a link's first loss spike, sent as 0.06 from 0, is not a 0.01 step).
  if (state.mean !== undefined && Math.abs(value - state.mean) <= 0.05 * Math.abs(state.mean)) {
    // A value computed in floating point (0.29000000000000004) is no
    // evidence of the sender's rounding and must not erase what was learned;
    // a sender most of whose readings look like that is precise, and has no
    // resolution to learn this way (resolutionOf()).
    const places = decimalPlaces(value);
    if (places <= DECIMALS_MAX_PLACES) {
      state.maxDecimals = Math.max(Number.isFinite(state.maxDecimals) ? state.maxDecimals : 0, places);
      state.decimalsN = (state.decimalsN || 0) + 1;
    } else {
      state.decimalsOverN = (state.decimalsOverN || 0) + 1;
    }
  }
  if (!Number.isInteger(value)) {
    state.allInteger = false;
  }
  if (state.distinct !== null) {
    if (!state.distinct.includes(value)) {
      state.distinct.push(value);
      if (state.distinct.length > MAX_DISTINCT_FOR_DISCRETE) {
        state.distinct = null;
      }
    }
  }
  decideKind(state, t);

  if (state.kind === 'discrete') {
    recordDiscrete(state, String(value), t, ready, options, true);
  }

  // Unwrap angles so a heading crossing north is a two-degree change, not a
  // 358-degree one.
  let x = value;
  if (state.angle && state.unwrapped !== undefined && state.last !== undefined) {
    x = state.unwrapped + wrapPi(value - state.last);
  }

  if (state.last !== undefined) {
    const signed = x - (state.unwrapped === undefined ? state.last : state.unwrapped);
    const step = Math.abs(signed);
    // The sensor's resolution is a step size seen more than once. A single
    // step is not evidence of resolution: a tank that sat at 80 % and then
    // dropped to 20 % would otherwise have "learned" a 60-point resolution,
    // and the noise floor that follows from it would hide the drop itself.
    if (step > 0) {
      state.recentSteps.push(signed);
      if (state.recentSteps.length > RECENT_STEPS) state.recentSteps.shift();
      if (stepOccurrences(state.recentSteps, step) >= 3 && (state.quantum === undefined || step < state.quantum)) {
        state.quantum = step;
      }
    }
    if (value < state.last) {
      const toZero = state.last > 0 && value <= RESET_FRACTION * state.last;
      if (toZero && COUNTER_LEAF.test(state.path)) {
        // A named counter that drops to (nearly) zero was reset - a daily
        // yield at midnight, a trip log cleared - and is still a counter.
        state.resets = (state.resets || 0) + 1;
        state.resetAt = t;
        state.resetCandidate = undefined;
      } else if (!isMeasurement(state) && !isStateCodeLeaf(state.path) && (toZero || (state.climb || 0) >= RESET_CLIMB)) {
        // A drop to zero, or any drop after a long unbroken climb, may be a
        // reset - a link restarted, a modem's byte count cleared - or a
        // glitch. Which, the next samples say (below). A path never seen
        // falling, that has counted for a while, is taken for counting
        // meanwhile: its reset is not a departure on its way to being
        // recognised (shiftWatched()).
        state.resetCandidate = {
          from: state.last,
          to: value,
          rises: 0,
          at: t,
          counting: state.fallAt === undefined && state.rises >= COUNTER_SAMPLES
        };
      } else {
        noteFall(state, t);
      }
    } else if (value > state.last) {
      state.rose = true;
      state.rises += 1;
      state.climb = (state.climb || 0) + 1;
      if (!Number.isFinite(state.climbSince)) {
        state.climbSince = t;
        state.climbMs = 0;
      }
      const candidate = state.resetCandidate;
      if (candidate) {
        const to = Number.isFinite(candidate.to) ? candidate.to : 0;
        if (value >= to + 0.5 * (candidate.from - to)) {
          // Straight back to where it was: a glitch, which is a fall and a
          // rise of a measurement, not a count starting over.
          noteFall(state, t);
        } else if ((candidate.rises += 1) >= (candidate.counting ? RESET_COUNTING_RISES : RESET_CONFIRM_RISES)) {
          // Counting up again from where it dropped to: it was reset.
          state.resets = (state.resets || 0) + 1;
          state.resetAt = t;
          state.resetCandidate = undefined;
        }
      }
    }
  }

  // A day of climbing is a day it was watched climbing: a silence counts
  // for no more than a dropout's worth, and the hours the plugin was down
  // not at all (countsByBehaviour()).
  if (Number.isFinite(state.climbSince) && dt > 0) {
    const cap = Math.max(options.dropoutMinMs || 0, (options.dropoutFactor || 1) * (state.intervalMean || dt));
    state.climbMs = (Number.isFinite(state.climbMs) ? state.climbMs : 0) + Math.min(dt, cap);
  }

  if (changed) {
    // The run of one value that just ended is how long this path holds a
    // value, unless a silence broke it (the frozen check's yardstick).
    if (state.n > 1 && !state.runBroken && t > state.sameSince) {
      learnRun(state, t - state.sameSince, t);
    }
    // The hold that starts now is a whole run, to be learned when it ends.
    state.runBroken = false;
    state.sameCount = 0;
    state.sameSince = t;
  } else {
    state.sameCount += 1;
  }

  applyPendingRestore(state, t);

  // Baseline update. Every number feeds it, whatever its kind, so a path that
  // turns out to be continuous already has a baseline when it does.
  if (state.mean === undefined) {
    state.mean = x;
    state.fast = x;
    state.variance = 0;
  } else {
    const relearning = t < state.relearnUntil;
    if (relearning) {
      state.relearnN += 1;
    }
    const countAlpha = 1 / (relearning ? state.relearnN + 1 : state.n);
    const slowAlpha = Math.max(timeAlpha(dt, SLOW_HALF_LIFE_MS), countAlpha);
    const fastAlpha = Math.max(timeAlpha(dt, FAST_HALF_LIFE_MS), 1 / state.n);
    state.fast += fastAlpha * (x - state.fast);

    const scale = Math.max(Math.sqrt(state.variance), noiseFloor(state));
    // A path saved before the yardstick was learned starts from its spread:
    // it is judged as it was until the yardstick has learned.
    if (!Number.isFinite(state.devVar)) state.devVar = state.variance;
    const devScale = Math.max(Math.sqrt(state.devVar), noiseFloor(state));
    const settled = state.n > KIND_DECISION_SAMPLES && !relearning;
    // While the path is away from its baseline, the baseline must not learn
    // the excursion as normal variation: a spread updated from a sustained
    // departure grows until the departure no longer stands out, and the alert
    // talks itself out of existing. So during an excursion the spread is held
    // and the mean creeps by at most one spread-width's worth per sample.
    const excursion = settled && Math.abs(state.fast - state.mean) / devScale >= options.zClear;
    if (excursion) {
      state.excursionSince = state.excursionSince === undefined ? t : state.excursionSince;
    } else {
      state.excursionSince = undefined;
    }
    const limit = settled ? (excursion ? 1 : CLAMP_SIGMAS) * scale : Infinity;
    const diff = Math.max(-limit, Math.min(limit, x - state.mean));
    const increment = slowAlpha * diff;
    state.mean += increment;
    if (!excursion) {
      state.variance = (1 - slowAlpha) * (state.variance + diff * increment);
      // How far the fast average strays from the baseline when nothing is
      // happening: the yardstick a departure is measured by. Smaller than
      // the samples' spread by as much as the path's noise averages away -
      // a lot for a sensor whose readings scatter independently, little for
      // one whose readings wander together - so it is learned, not assumed.
      // While the path learns afresh it is the samples' spread, as before
      // anything was learned.
      const dev = state.fast - state.mean;
      state.devVar = relearning ? state.variance : (1 - slowAlpha) * state.devVar + slowAlpha * dev * dev;
    }
    // An excursion that has lasted this long is the new normal - a
    // different sea temperature, a re-plumbed sensor. Learn it afresh rather
    // than alert about it forever.
    if (excursion && t - state.excursionSince >= options.acceptExcursionMs) {
      beginRelearn(state, t, options.relearnMs);
      state.excursionSince = undefined;
      state.accepted = (state.accepted || 0) + 1;
    }
  }

  state.last = value;
  state.unwrapped = x;
  pushBucket(state, 'recentBucket', 'recent', RECENT_BUCKET_MS, RECENT_BUCKETS, t, x);
  pushBucket(state, 'minuteBucket', 'minutes', MINUTE_BUCKET_MS, MINUTE_BUCKETS, t, x);
  return true;
}

/**
 * How many times a step of this size occurs among the recent (signed) steps,
 * counting a step that goes straight back the way the one before it came -
 * a glitch out and back - as one occurrence, not two. A sensor flickering
 * between two levels still adds an occurrence for every out-and-back pair;
 * one glitch followed by a real drop of the same size makes two, not three.
 */
function stepOccurrences(steps, step) {
  const matches = (value) => Math.abs(Math.abs(value) - step) <= 0.1 * Math.max(Math.abs(value), step);
  let count = 0;
  let paired = false;
  for (let index = 0; index < steps.length; index += 1) {
    const value = steps[index];
    if (!matches(value)) {
      paired = false;
      continue;
    }
    const previous = steps[index - 1];
    if (!paired && previous !== undefined && matches(previous) && Math.sign(previous) !== Math.sign(value)) {
      paired = true;
      continue;
    }
    count += 1;
    paired = false;
  }
  return count;
}

/**
 * Start the current hold of one value again from `t`, after a silence, an
 * operating-state change or a restart: from now on it is judged as a hold
 * that began then, and the part before is not learned as a run - what the
 * path did across the break, or in which state, is not known.
 */
function restartHold(state, t) {
  state.sameSince = t;
  state.sameCount = 0;
  state.runBroken = true;
}

/** A fall that was not a counter's reset. */
function noteFall(state, t) {
  state.monotonic = false;
  state.falls = (state.falls || 0) + 1;
  state.fallAt = t;
  state.climb = 0;
  state.climbSince = undefined;
  state.climbMs = 0;
  state.resetCandidate = undefined;
}

function runBin(ms) {
  return Math.min(RUN_BINS - 1, Math.max(0, Math.floor(Math.log2(Math.max(1, ms / 1000)))));
}

/** The run table for the operating state the path is in now. */
function runRecord(state, create, t) {
  const key = typeof state.regimeKey === 'string' ? state.regimeKey : '';
  if (!state.runRecords || typeof state.runRecords !== 'object') {
    if (!create) return undefined;
    state.runRecords = {};
  }
  let record = state.runRecords[key];
  if (!record && create) {
    record = { bins: new Array(RUN_BINS).fill(0), count: 0, at: t };
    state.runRecords[key] = record;
    const keys = Object.keys(state.runRecords);
    if (keys.length > MAX_RUN_REGIMES) {
      keys.sort((a, b) => state.runRecords[a].at - state.runRecords[b].at);
      delete state.runRecords[keys[0]];
    }
  }
  return record;
}

/** One run of a single value, `ms` long, that the path came out of. */
function learnRun(state, ms, t) {
  const record = runRecord(state, true, t);
  // Older runs fade, so a sensor that was replaced, or a season that
  // changed, is learned again within weeks. Decayed in steps (all bins at
  // once, which leaves the quantile as it was; only the counts age).
  if (t - record.at >= HOUR_MS) {
    const factor = 0.5 ** ((t - record.at) / RUN_HALF_LIFE_MS);
    record.bins = record.bins.map((value) => value * factor);
    record.count *= factor;
    record.at = t;
  }
  record.bins[runBin(ms)] += ms;
  record.count += 1;
}

/**
 * The longest this path usually holds one value, in its current operating
 * state, or undefined while that is not known yet.
 */
function usualRunMs(state) {
  const record = runRecord(state, false);
  if (!record || record.count < RUN_MIN_COUNT) return undefined;
  const total = record.bins.reduce((sum, value) => sum + value, 0);
  if (total < RUN_MIN_TIME_MS) return undefined;
  let cumulative = 0;
  for (let index = 0; index < RUN_BINS; index += 1) {
    cumulative += record.bins[index];
    if (cumulative >= RUN_QUANTILE * total) return 2 ** (index + 1) * 1000;
  }
  return 2 ** RUN_BINS * 1000;
}

/** Digits after the decimal point, as the number came (15 for exponent form). */
function decimalPlaces(value) {
  const text = String(value);
  if (/e/i.test(text)) return 15;
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(15, text.length - dot - 1);
}

// Samples whose decimals must have been seen before they say the resolution,
// and the finest resolution they are taken to say: a value computed in
// floating point (279.76000000000005) shows many decimals and says nothing.
const DECIMALS_MIN_SAMPLES = 30;
const DECIMALS_MAX_PLACES = 5;

/**
 * The path's resolution: the smallest step seen three times, or, before
 * that, the last digit its sender uses.
 */
function resolutionOf(state) {
  if (state.quantum !== undefined) return state.quantum;
  // Whole numbers say nothing this way: a path that has sat at 0 is not one
  // that reports in units (whole-number paths have their own floor).
  const rounded = state.decimalsN || 0;
  if (
    rounded >= DECIMALS_MIN_SAMPLES &&
    (state.decimalsOverN || 0) <= 0.1 * rounded &&
    Number.isFinite(state.maxDecimals) &&
    state.maxDecimals >= 1 &&
    state.maxDecimals <= DECIMALS_MAX_PLACES
  ) {
    return 10 ** -state.maxDecimals;
  }
  return undefined;
}

// The coarsest resolution real senders of a unit have, as a noise floor:
// pressure senders on a J1939 gateway report in 4 kPa steps and 1 psi ones
// in 6.9 kPa. Tanks are deliberately not here: an eighths sender would get a
// floor of a quarter, and then even full to empty scores below a warning.
// Their floor stays at ten times the unit's (0.05), which already keeps one
// eighth step quiet. Elsewhere ten times the unit's floor is coarser than any
// real sensor.
const COARSEST_FLOOR = { Pa: 16000 };

function noiseFloor(state) {
  const unitFloor = unitNoiseFloor(state.path, state.units);
  // Twice a learned step (a sensor flickering between two neighbouring
  // values is not departing), once the step its sender rounds to: a reading
  // sent as 0.29 and then 0.3 has moved by its rounding, not by 0.01 of news.
  const step = resolutionOf(state);
  const quantumFloor = step === undefined ? 0 : state.quantum !== undefined ? 2 * step : step;
  const relative = state.mean === undefined ? 0 : 0.005 * Math.abs(state.mean);
  // A learned resolution can raise the floor, but only so far: no real
  // sensor reports in steps coarser than the coarsest senders of its unit
  // (or than 5 % of its value), so a resolution beyond that is a run of
  // glitches, and letting it through would hide real departures.
  if (unitFloor !== undefined) {
    const unit = state.units || (/[Pp]ressure$/.test(state.path) ? 'Pa' : undefined);
    return Math.max(unitFloor, Math.min(quantumFloor, Math.max(10 * unitFloor, COARSEST_FLOOR[unit] || 0)));
  }
  // Without a unit: 5 % of the value, but a whole-number path always keeps
  // its counting resolution - one count is never a large departure. A path
  // that sits at zero (packet loss, an alarm count) has no "5 % of its value":
  // while its mean is within its own resolution of zero, the resolution sets
  // the floor. Without that, a mean that decayed to 1e-13 after a spike made
  // the floor 1e-9, and the rounding noise of the decay scored thousands of
  // spreads.
  const nearZero = state.mean === undefined || Math.abs(state.mean) < quantumFloor;
  const cap = Math.max(nearZero ? quantumFloor : 10 * relative, state.allInteger ? 2 : 0);
  return Math.max(relative, Math.min(quantumFloor, cap), 1e-9);
}

function isReady(state, t, options) {
  return (
    state.n >= options.minSamples &&
    t - state.firstAt >= options.learningMs &&
    t >= state.relearnUntil
  );
}

// A path that has only ever gone up - engine hours, a trip log - is a
// counter, and a counter's steady climb is not a departure from anything.
// "Never went down" alone is not enough - a voltage that sat still and then
// jumped, or one climbing steadily on a charger, has never gone down either.
// A counter is a number that is
//   - listed by the operator in watchCounterPaths under its exact path,
//     whatever it does; or
//   - covered by a pattern there, or named as a counter (runTime, fuel.used,
//     lifetimeDischarge, energy, log...), and not a measurement - no
//     measurement in its name, no unit of one. Named ones must also never
//     have gone down (a reset to zero aside).
// Nothing else is guessed to be a counter from how it behaves: a voltage
// published under an unknown name and without units can climb for hours
// without a dip too, and taking it for a counter would switch off the very
// checks that should report it. A pattern cannot do that either: under
// "plugins.example" the counters are counters and the batteryVoltage beside
// them is still judged.
const COUNTER_SAMPLES = 30;
const COUNTER_LEAF =
  /(?:^|\.)(?:runTime|[a-zA-Z]*[Hh]ours|[a-zA-Z]*[Cc]ount|cumulative[A-Za-z]*|[a-zA-Z]*Total|total[A-Za-z]*|energy[A-Za-z]*|lifetime(?:Discharge|Recharge|Charge|Energy)|[a-zA-Z]*[Cc]onsumed|[a-zA-Z]*Today|yield[A-Za-z]*|used|odometer|log|trip)$/;
// Units of a measurement, which a count never has. Anything else - SI or not
// (s, m3, J, C, m; h, Ah, kWh from a plugin) - can be a running total.
const MEASUREMENT_UNITS = new Set(['V', 'A', 'W', 'K', 'Pa', 'ratio', 'Hz', 'm/s', 'rad', 'rad/s', 'm3/s', 'deg', 'dB', 'dBm', 'db', 'dbm']);
// The last name of a measurement, which no counter-like word in it overrides:
// totalPower, energyStored, currentVolume and satellitesInView.count go up
// and down.
const MEASUREMENT_LEAF =
  /(?:[Vv]oltage|[Cc]urrent|[Tt]emperature|[Ll]evel|[Vv]olume|[Pp]ressure|[Dd]epth|[Ss]peed|[Vv]elocity|[Aa]ngle|[Hh]eading|[Pp]ower|[Rr]atio|stateOfCharge|[Hh]umidity|[Rr]evolutions|[Rr]ate|[Ff]low|[Ff]requency|[Dd]istance|[Aa]ltitude|[Pp]osition|[Ss]tored|[Rr]emaining|[Cc]apacity|[Aa]vailable|[Rr]ssi|RSSI|[Rr]srp|RSRP|[Rr]srq|RSRQ|[Ss]inr|SINR|[Ss]nr|SNR|[Ss]ignalStrength|[Ss]ignalQuality|[Ll]inkQuality|[Jj]itter|[Ll]atency|^rtt|[Rr]oundTrip(?:Time)?|[Ll]oss)$/;

function leafOf(path) {
  return path.slice(path.lastIndexOf('.') + 1);
}

// A leaf naming a state code rather than a count: a whole `state` or `mode`
// (switch banks, device states) or a name ending in one (chargerState,
// relay1State, inverterACMode, errorCode, chargePhase, gpsSource, and flags
// such as engineInAlarm). Time or pulses in a state or since an error
// (timeInState, secondsSinceLastError, pulsesInCurrentMode) are counts again:
// a time or count word, then In or Since.
const STATE_CODE_LEAF =
  /(?:^|[A-Za-z0-9])(?:[Ss]tate|[Mm]ode|[Ss]tatus|[Tt]ype|[Cc]ode|[Pp]hase|[Ff]ault|[Ee]rror|[Aa]larm|[Nn]ame|[Ss]ource|[Rr]eference|[Mm]ethod|[Ll]abel)$/;
// The time or count word, then In or Since. A long word may follow a
// lowercase letter (runtimeInState, uptimeSinceFault); a short one only
// starts the leaf or a word of it (msSinceError, relay1SecondsInState), so
// "systemsInAlarm" is not "ms in alarm".
const LONG_COUNT_WORDS = ['time', 'seconds', 'minutes', 'hours', 'duration', 'elapsed', 'period', 'dwell', 'pulses', 'count', 'counts', 'events', 'cycles', 'starts', 'trips'];
const SHORT_COUNT_WORDS = ['ms', 'secs', 'mins', 'days', 'age'];
const capitalised = (words) => words.map((word) => word[0].toUpperCase() + word.slice(1));
const COUNT_OF_STATE_LEAF = new RegExp(
  `(?:(?:^|[a-z])(?:${LONG_COUNT_WORDS.join('|')})|^(?:${SHORT_COUNT_WORDS.join('|')})|(?:${capitalised([...LONG_COUNT_WORDS, ...SHORT_COUNT_WORDS]).join('|')}))` +
    '(?:In|Since)[A-Za-z0-9]*?(?:State|Status|Mode|Phase|Fault|Error|Alarm|Code)$'
);

function isStateCodeLeaf(path) {
  const leaf = leafOf(path);
  return STATE_CODE_LEAF.test(leaf) && !COUNT_OF_STATE_LEAF.test(leaf);
}

/**
 * What the counter listing does to a path: 'exact' (listed by its own path:
 * a counter whatever it does), 'forced' (under a pattern and not a state
 * code: a counter, never discrete), or 'self' (not listed, or a state code
 * under a pattern: it classifies itself). `listedBy` is the matching entry,
 * or true for a save that kept only a flag.
 */
function counterListingFor(path, listedBy) {
  if (!listedBy) return 'self';
  if (listedBy === path) return 'exact';
  return isStateCodeLeaf(path) ? 'self' : 'forced';
}

function counterListing(state) {
  return counterListingFor(state.path, state.counterOptIn);
}

function isMeasurement(state) {
  return (
    MEASUREMENT_LEAF.test(leafOf(state.path)) ||
    /\.satellites/.test(state.path) ||
    (typeof state.units === 'string' && MEASUREMENT_UNITS.has(state.units))
  );
}

function isCounter(state) {
  if (state.kind === 'discrete') {
    return false;
  }
  if (state.counterOptIn === state.path) {
    return true;
  }
  if (isMeasurement(state)) {
    return false;
  }
  if (counterListing(state) === 'forced') {
    return true;
  }
  if (!state.rose || state.n < COUNTER_SAMPLES) {
    return false;
  }
  if (COUNTER_LEAF.test(state.path)) {
    return state.monotonic;
  }
  return countsByBehaviour(state);
}

// A climb with never a fall, through this much watching, is a count: a
// day has a night in it, and no measurement - a voltage on a charger, a
// tank filling - climbs through a whole day without once going down.
const COUNTING_DAY_MS = 24 * HOUR_MS;

/**
 * A path no name says is a counter shows itself one by what it does: it is
 * reset - drops to zero, or lower after a long climb, and counts up again
 * from there (a link's sequence number when it restarts, a modem's byte
 * count when it is cleared) - or it has only climbed, through a whole day
 * of watching. Either way it has not gone down any other way since. A
 * shorter climb is never enough (a voltage on a charger climbs for hours);
 * a measurement that drops to zero stays there or comes straight back, and
 * does not count up from nothing.
 */
function countsByBehaviour(state) {
  if (isStateCodeLeaf(state.path)) return false;
  const fellSince = (at) => Number.isFinite(state.fallAt) && state.fallAt > at;
  if ((state.resets || 0) >= 1 && Number.isFinite(state.resetAt) && !fellSince(state.resetAt)) return true;
  return (
    Number.isFinite(state.climbSince) &&
    (Number.isFinite(state.climbMs) ? state.climbMs : state.lastAt - state.climbSince) >= COUNTING_DAY_MS &&
    (state.climb || 0) >= RESET_CLIMB &&
    !fellSince(state.climbSince)
  );
}

/**
 * Rate of change over the last minute and a half, in SI units per minute.
 * Short on purpose: it describes whether the value is *still* moving, so a
 * step that has levelled off is not reported as "changing 4 °C/min".
 */
function recentSlopePerMinute(state, windowMs = 90 * 1000) {
  const series = seriesWithOpen(state, 'recent', 'recentBucket', RECENT_BUCKET_MS);
  if (series.length < 3) {
    return undefined;
  }
  const end = series[series.length - 1][0];
  const points = series.filter(([at]) => at >= end - windowMs);
  const trend = linearTrend(points);
  return trend ? trend.slope * 60 * 1000 : undefined;
}

/**
 * A sustained departure from the learned baseline: a step, or a ramp faster
 * than the baseline can follow. One check covers both, because a ramp keeps
 * the fast average pulling away from the slow one.
 */
// How long a drop to zero waits, before the level check judges it, for the
// next samples to say whether it was a counter's reset: a reset is not a
// departure, and is not reported as one on its way to being recognised.
const RESET_HOLD_MS = 60 * 1000;

function shiftWatched(state, t, options) {
  if (state.kind !== 'continuous' || !isReady(state, t, options) || isCounter(state)) return false;
  const candidate = state.resetCandidate;
  if (!candidate || !Number.isFinite(candidate.at)) return true;
  // A path that has only ever counted waits longer: a retransmission count
  // that restarts from zero may not move again for an hour, and its reset is
  // still not a departure. Not for ever: something that climbed and then
  // collapsed to zero for good is judged after that.
  const hold = candidate.counting ? RESET_COUNTING_HOLD_MS : Math.max(RESET_HOLD_MS, 2 * RESET_CONFIRM_RISES * (state.intervalMean || 0));
  return t - candidate.at >= hold;
}

/**
 * How far the path is from its baseline: `z` in the spreads of its samples
 * (what is reported, and what its habits are kept in), and `departure` in
 * how far its fast average usually strays (what decides whether it is
 * departing at all).
 */
function shiftZ(state) {
  const floor = noiseFloor(state);
  const scale = Math.max(Math.sqrt(state.variance), floor);
  const strays = Math.max(Math.sqrt(Number.isFinite(state.devVar) ? state.devVar : state.variance), floor);
  const delta = state.fast - state.mean;
  return { z: delta / scale, departure: delta / strays, scale, strays };
}

function evaluateShift(state, t, options, isOpen) {
  if (!shiftWatched(state, t, options)) {
    return null;
  }
  const std = Math.sqrt(state.variance);
  const { z, departure, scale, strays } = shiftZ(state);
  const delta = state.fast - state.mean;
  const size = Math.abs(z);
  const away = Math.abs(departure);
  // A departure of a kind this path keeps making and coming back from - a
  // radio link's packet loss spiking for a minute - is reported only when
  // it goes clearly further, or lasts clearly longer, than it usually does
  // (habits.cjs). An open finding clears as any other does.
  // Routine if the path keeps making departures like it and coming back, or
  // keeps settling at levels this far from the last (a daily figure's
  // midnight step): its habits of either.
  const verdict = habits.judge(state, z >= 0 ? 'shift+' : 'shift-', size, t, options.alertsPerDay);
  const levels = habits.judge(state, 'level', size, t, options.alertsPerDay);
  const active = isOpen ? away >= options.zClear : away >= options.zWarn && verdict.beyond && levels.beyond;
  const habitual = verdict.usual || levels.usual;
  const slope = recentSlopePerMinute(state);
  return {
    active,
    severity: away >= options.zAlert && (!habitual || size >= 2 * habitual.peak) ? 'alert' : 'warn',
    evidence: {
      value: state.last,
      // The last few seconds' average, which the departure is measured by.
      average: state.fast,
      baseline: state.mean,
      spread: std,
      z,
      departure,
      strays,
      delta,
      // Only a rate that is itself beyond the noise is worth saying.
      slopePerMinute: slope !== undefined && Math.abs(slope) >= scale ? slope : undefined,
      ...(habitual ? { usual: habitual } : {})
    }
  };
}

/** No update for far longer than this path normally goes between updates. */
// The least silence reported for a regular path whose interval a run of
// unconfirmed long gaps raised (evaluateDropout).
const RAISED_SILENCE_MS = 60 * 60 * 1000;
// The longest gap that is a sender's rhythm (a night, a day at anchor) rather
// than an outage (learnInterval()).
const RHYTHM_GAP_MS = 24 * HOUR_MS;

function evaluateDropout(state, t, options) {
  if (state.n < options.minSamples || state.intervalMean === undefined) return null;
  // A learned cycle sets the limit whatever the mean gap: a burst sender
  // (ten readings a second apart, then five minutes quiet) has a regular
  // mean but a cycle's silences. It lasts until a settled regular stretch
  // clears it. Such a path is not one of the feed's steady paths (`cycle` in
  // the evidence).
  const irregular = state.intervalMean > options.maxRegularIntervalMs;
  const cycle = Number.isFinite(state.cycleLimit) ? state.cycleLimit : undefined;
  // Long gaps one after another raise the interval, as a confirmed slower
  // rate (eight of about one size) does. A path that was regular before
  // them is still watched, only for a silence far beyond them (an hour at
  // least): a sender quiet at night is not reported gap by gap, and a sensor
  // whose gaps grew, or that settled at a slower rate, and that then went
  // silent for good still is.
  const raised = irregular && cycle === undefined && Number.isFinite(state.regularMean) && state.regularMean <= options.maxRegularIntervalMs;
  if (irregular && cycle === undefined && !raised) return null;
  // A raised path is reported past an hour, or half again its longest gap
  // come back from: a sender quiet for two hours at night is not reported
  // each night, and one that slowed and then died still is.
  const raisedLimit = raised ? Math.max(RAISED_SILENCE_MS, 1.5 * Math.max(state.longestGap || 0, state.outageGap || 0)) : 0;
  // Its interval's multiple, as a regular path's, but a day at most for a
  // raised one: a silence longer than a day is an outage, never a sender's
  // rhythm (learnInterval()), so a path that settled at every three hours
  // is reported after a day, not after thirty hours.
  const intervalLimit = options.dropoutFactor * state.intervalMean;
  const limit = Math.max(options.dropoutMinMs, raised ? Math.min(intervalLimit, RHYTHM_GAP_MS) : intervalLimit, cycle || 0, raisedLimit);
  const silentFor = t - state.lastAt;
  // A path that sends "no value" now and then and comes back (a sensor out of
  // range at times, a derived value without its input) is reported only when
  // a spell of it lasts clearly longer than its spells usually do.
  const unavailable = Number.isFinite(state.nullSince);
  const verdict = unavailable ? habits.judge(state, 'unavailable', 1, t, options.alertsPerDay) : { beyond: true };
  // After a restart, a path that has not read again yet is still being
  // reacquired: a Bluetooth plugin may take minutes to hear its sensors
  // again, sending "no value" meanwhile. Its silence is judged once it has
  // read again, or once RESTART_DETOUR_MS have passed without it. Read
  // again means twice: the server re-announces its last cached value when it
  // starts, which is one reading from before the restart, not a sensor heard.
  const reacquiring = (state.readsSinceRestart ?? REACQUIRE_READS) < REACQUIRE_READS && Number.isFinite(state.reacquireUntil) && t < state.reacquireUntil;
  return {
    active: silentFor > limit && verdict.beyond && !reacquiring,
    severity: 'warn',
    evidence: {
      silentFor,
      intervalMean: state.intervalMean,
      lastAt: state.lastAt,
      source: state.source,
      limit,
      ...(cycle ? { cycle: true } : {}),
      ...(raised ? { raised: true } : {}),
      // Still sending, but null: the sensor says it has no value.
      ...(unavailable ? { unavailableSince: state.nullSince, unavailableFor: t - state.nullSince } : {}),
      ...(verdict.usual ? { usual: verdict.usual } : {})
    }
  };
}

/**
 * A number holding one value far longer than it ever normally does, in the
 * operating state it is in. Judged against the path's own runs (learnRun()),
 * not against how often it changes: a counter that ticks in bursts changes
 * on most of its updates while it ticks and then sits for hours, and an
 * engine's coolant temperature with the engine stopped sits on one reading
 * for an hour, and neither is stuck. A sensor that never held a value for
 * more than seconds is stuck after a few minutes of one.
 */
function evaluateFrozen(state, t, options) {
  if (state.kind !== 'continuous' || state.n < options.frozenMinSamples || isCounter(state)) {
    return null;
  }
  const usualRun = usualRunMs(state);
  if (usualRun === undefined) {
    return null;
  }
  const limit = Math.max(options.frozenMs, RUN_FACTOR * usualRun);
  // Enough of the path's holding seen to judge a hold this long (above).
  const record = runRecord(state, false);
  const seenMs = record.bins.reduce((sum, value) => sum + value, 0);
  if (seenMs < RUN_EVIDENCE_FACTOR * limit || (limit > options.frozenMs && seenMs < RUN_DAY_MS)) {
    return null;
  }
  // To its last sample: a path that has gone silent, or sends "no value",
  // is not repeating anything (its dropout reports that), and its hold does
  // not grow while it says nothing.
  const frozenFor = state.sameCount > 0 ? Math.max(0, state.lastAt - state.sameSince) : 0;
  // Exactly zero is a machine that is off (0 rpm, 0 A), not a sensor that is
  // stuck; and a path re-learning after an operating change is expected to
  // behave differently from before. A silence or an operating change starts
  // the hold again (restartHold()).
  // And only while it still reports: once it falls silent, its dropout
  // takes over, and a stuck finding open then clears.
  const fresh = state.intervalMean === undefined || t - state.lastAt <= Math.max(options.dropoutMinMs ?? 30000, (options.dropoutFactor ?? 10) * state.intervalMean);
  const plausible = state.last !== 0 && t >= state.relearnUntil && !Number.isFinite(state.nullSince) && fresh;
  return {
    active: plausible && state.sameCount >= options.frozenMinRepeats && frozenFor >= limit,
    severity: 'warn',
    evidence: { value: state.last, frozenFor, repeats: state.sameCount, usualRunMs: usualRun, limit }
  };
}

/** A discrete value the path has never taken before, held for a while. */
function evaluateNewState(state, t, options) {
  if (state.kind !== 'discrete' || state.newStateAt === undefined) {
    return null;
  }
  return {
    active: t - state.newStateAt < options.eventHoldMs,
    severity: 'warn',
    evidence: { value: state.newStateValue, at: state.newStateAt, known: Object.keys(state.seen).filter((k) => k !== state.newStateValue) }
  };
}

function cyclingCounts(state, t, options) {
  // Since the switching history began: a path re-decided as discrete starts
  // it again, because its time as a continuous path held no switches.
  const since = Number.isFinite(state.transitionsSince) ? state.transitionsSince : state.firstAt;
  if (state.kind !== 'discrete' || t - since < options.cyclingLearningMs) {
    return null;
  }
  // Counted to the minute: the minute buckets that start inside the last
  // hour. The oldest partial minute is left out rather than counted whole,
  // so the window is 59-60 minutes and never reaches past the hour; what is
  // left out stays in the historical rate, which uses the same split.
  const lastHour = state.transitionMinutes
    .filter(([minute]) => minute >= t - HOUR_MS)
    .reduce((sum, [, count]) => sum + count, 0);
  const observedHours = Math.max(1, (t - since - HOUR_MS) / HOUR_MS);
  const baselinePerHour = Math.max(0, state.transitionTotal - lastHour) / observedHours;
  const threshold = Math.max(options.cyclingMinPerHour, Math.ceil(3 * baselinePerHour + 2));
  return { lastHour, baselinePerHour, threshold };
}

/**
 * Switching far more often in the last hour than it has on average - and,
 * for a path that does that on its own every so often (a solar charger
 * flapping between modes every dusk), clearly more than on those occasions.
 */
function evaluateCycling(state, t, options, isOpen = false) {
  const counts = cyclingCounts(state, t, options);
  if (!counts) {
    return null;
  }
  const { lastHour, baselinePerHour, threshold } = counts;
  const verdict = habits.judge(state, 'cycling', lastHour, t, options.alertsPerDay);
  const habitual = verdict.usual;
  return {
    active: lastHour >= threshold && (isOpen || verdict.beyond),
    severity: lastHour >= 2 * threshold && (!habitual || lastHour >= 2 * habitual.peak) ? 'alert' : 'warn',
    evidence: { lastHour, baselinePerHour, threshold, ...(habitual ? { usual: habitual } : {}) }
  };
}

// A counter is watched by how fast it counts: over this window, against the
// fastest it counted in any such window over the past week. Only a count far
// beyond that is news - a modem moving ten times the data of its busiest
// ten minutes all week - so the evening's normal traffic, the noon peak of
// a solar yield and a link's usual bursts of retransmissions are not.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_DAYS = 7;
const RATE_HISTORY_MS = 24 * HOUR_MS;
const RATE_FACTOR = 4;
const RATE_CLEAR_FACTOR = 2;
const RATE_ALERT_FACTOR = 10;
// The fewest steps of its own resolution that make a count worth judging:
// four counts where a busy ten minutes had one are not a surge.
const RATE_MIN_STEPS = 10;

/** The counter's rate over the last window, per ms, or undefined (too little data, or reset in it). */
function counterRate(state, t) {
  const series = seriesWithOpen(state, 'minutes', 'minuteBucket', MINUTE_BUCKET_MS);
  if (series.length < 3) return undefined;
  const last = series[series.length - 1];
  if (last[0] < t - 2 * MINUTE_BUCKET_MS) return undefined;
  let first;
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const point = series[index];
    if (index < series.length - 1 && point[1] > series[index + 1][1]) return undefined;
    first = point;
    if (point[0] <= last[0] - RATE_WINDOW_MS) break;
  }
  const span = last[0] - first[0];
  if (span < RATE_WINDOW_MS / 2) return undefined;
  return (last[1] - first[1]) / span;
}

/**
 * The smallest count worth judging, in the counter's own steps: its
 * resolution, or one for a whole-number counter that has not shown one.
 */
function rateStep(state) {
  if (Number.isFinite(state.quantum) && state.quantum > 0) return state.quantum;
  return state.allInteger ? 1 : undefined;
}

/**
 * Whether the counter's week holds paces at all - none counted means no
 * record yet, a day of zeros is a record of zero.
 */
function hasRateHistory(state, t) {
  const cutoff = t - RATE_DAYS * 24 * HOUR_MS;
  return Array.isArray(state.rateDays) && state.rateDays.some(([day]) => day > cutoff);
}

/**
 * Whether `rate` is a surge over `record`: `factor` times it, or, for a
 * counter that has not counted at all all week, enough steps of its own in a
 * window (`share` of RATE_MIN_STEPS, for the clear threshold).
 */
function surges(state, rate, record, factor, share, t) {
  if (record > 0) return rate >= factor * record;
  const step = rateStep(state);
  return step !== undefined && hasRateHistory(state, t) && rate * RATE_WINDOW_MS >= share * RATE_MIN_STEPS * step;
}

function rateRecord(state, t) {
  const days = Array.isArray(state.rateDays) ? state.rateDays : [];
  const cutoff = t - RATE_DAYS * 24 * HOUR_MS;
  return days.filter(([day]) => day > cutoff).reduce((best, [, rate]) => Math.max(best, rate), 0);
}

/**
 * A rate seen while the counter was not surging. Held back for two windows
 * before it counts toward the record: a surge builds up over a window, and
 * the build-up must not raise the bar the surge is then judged against.
 */
function holdRate(state, rate, t) {
  if (!Array.isArray(state.rateHeld)) state.rateHeld = [];
  const held = state.rateHeld;
  const latest = held[held.length - 1];
  if (latest && t - latest[0] < RATE_WINDOW_MS && t >= latest[0]) {
    latest[1] = Math.max(latest[1], rate);
  } else {
    held.push([t, rate]);
  }
  while (held.length > 2) {
    const [at, max] = held.shift();
    noteRate(state, max, at);
  }
}

function noteRate(state, rate, t) {
  const day = Math.floor(t / (24 * HOUR_MS)) * 24 * HOUR_MS;
  if (!Array.isArray(state.rateDays)) state.rateDays = [];
  const latest = state.rateDays[state.rateDays.length - 1];
  if (latest && latest[0] === day) latest[1] = Math.max(latest[1], rate);
  else state.rateDays.push([day, rate]);
  const cutoff = t - RATE_DAYS * 24 * HOUR_MS;
  state.rateDays = state.rateDays.filter(([at]) => at > cutoff);
}

/** A counter counting far faster than it has all week. */
function evaluateRate(state, t, options) {
  if (!isCounter(state) || !isReady(state, t, options) || state.rateNow === undefined) return null;
  if (!Number.isFinite(state.rateSince) || t - state.rateSince < RATE_HISTORY_MS) return null;
  // The record leaves the surge out (learnFromTick()), so it is the fastest
  // the counter went before it.
  const record = rateRecord(state, t);
  const rate = state.rateNow;
  const step = rateStep(state);
  const enough = record > 0 ? rate * RATE_WINDOW_MS >= RATE_MIN_STEPS * (state.quantum || 0) : step !== undefined && hasRateHistory(state, t);
  return {
    active: state.rateSurgeSince !== undefined && enough,
    severity: record > 0 && rate >= RATE_ALERT_FACTOR * record ? 'alert' : 'warn',
    evidence: {
      value: state.last,
      ratePerMinute: rate * MINUTE_BUCKET_MS,
      recordPerMinute: record * MINUTE_BUCKET_MS,
      factor: record > 0 ? rate / record : undefined,
      windowMs: RATE_WINDOW_MS
    }
  };
}

/**
 * Learning that happens on the tick, from what the detectors see: the
 * departures a path comes back from (habits.cjs), and a counter's rate.
 * Run before the checks, whether or not the path is muted - a muted path's
 * habits are still facts about it.
 */
/** Once start-up is over: a value first seen during it that the path still holds is a new state. */
function settleStartup(state, t, options) {
  if (inStartup(t, options, state) || inDetour(state, t)) return;
  if (state.restartFrom !== undefined) {
    // The detour is over and the path did not go back: that is one real
    // change, from where it was before the restart to where it is.
    const from = state.restartFrom;
    state.restartFrom = undefined;
    state.restartUntil = undefined;
    if (state.kind === 'discrete' && state.lastValue !== undefined && state.lastValue !== from) countTransition(state, t);
  }
  if (!Array.isArray(state.startupNew)) return;
  const pending = state.startupNew;
  state.startupNew = undefined;
  const quiet = Number.isFinite(state.newStateQuietUntil) && t < state.newStateQuietUntil;
  if (state.kind === 'discrete' && pending.includes(state.lastValue) && isReady(state, t, options) && !quiet) {
    state.newStateAt = t;
    state.newStateValue = state.lastValue;
  }
}

function learnFromTick(state, t, options) {
  settleStartup(state, t, options);
  // Nothing is learned of the path's habits while the watch starts up: a
  // link's round-trip time while it reconnects is the restart's, not a
  // departure the path makes. An episode carried over the restart waits.
  // A departure that began then is the restart's until it ends, however
  // long it fades after the start-up is over.
  if (inStartup(t, options, state)) {
    if (shiftWatched(state, t, options)) {
      const { departure } = shiftZ(state);
      const restartOwn = state.startupDeparture;
      if (restartOwn && (restartOwn === 'shift+' ? departure : -departure) < options.zClear) {
        // The restart's own departure is over, here and now: when it ended,
        // kept until the start-up is, so that one dipping under and coming
        // back is still one restart's settling, measured to its last end.
        state.startupDeparture = undefined;
        state.startupSettledWithin = t;
      }
      // Not an episode carried over the restart: that one began before it,
      // and keeps being followed.
      if (departure >= options.zClear && !habits.isOpen(state, 'shift+')) state.startupDeparture = 'shift+';
      else if (-departure >= options.zClear && !habits.isOpen(state, 'shift-')) state.startupDeparture = 'shift-';
      if (state.startupDeparture) state.startupSettledWithin = undefined;
      state.startupTickAt = t;
    }
    learnRate(state, t, options);
    return;
  }
  if (Number.isFinite(state.startupSettledWithin)) {
    // The start-up is over, and the restart's departure ended within it -
    // unless it dipped under only on the start-up's last tick and is back
    // on this one: hovering at the edge, it is still the restart's, and
    // settles when that ends. One that ended earlier is over, and a
    // departure now is a new one, the path's own.
    const hovering = state.startupSettledWithin === state.startupTickAt && shiftWatched(state, t, options);
    const away = hovering ? shiftZ(state).departure : 0;
    if (away >= options.zClear && !habits.isOpen(state, 'shift+')) state.startupDeparture = 'shift+';
    else if (-away >= options.zClear && !habits.isOpen(state, 'shift-')) state.startupDeparture = 'shift-';
    else state.startupSettledAt = state.startupSettledWithin;
    state.startupSettledWithin = undefined;
  }
  state.startupTickAt = undefined;
  if (shiftWatched(state, t, options)) {
    // Its habits are kept as they were learned before the yardstick: an
    // episode while it is `zClear` of its readings' spreads away, its peak
    // in them. Episodes that small in its average (a jitter's every
    // flicker) are not habits, and counted in would widen what a habit
    // excuses until a real drift passed for one.
    const { z, departure } = shiftZ(state);
    const restartOwn = state.startupDeparture;
    if (restartOwn && (restartOwn === 'shift+' ? departure : -departure) < options.zClear) {
      state.startupDeparture = undefined;
      // How long the restart's own departure lasted: its source's settling
      // after a restart (restarts.cjs), for the engine to learn.
      state.startupSettledAt = t;
    }
    if (state.startupDeparture !== 'shift+') habits.follow(state, 'shift+', z, z >= options.zClear, t);
    if (state.startupDeparture !== 'shift-') habits.follow(state, 'shift-', -z, -z >= options.zClear, t);
  } else {
    state.startupDeparture = undefined;
    // Accepted as the new normal: the departure did not end on its own; it
    // is a level the path settled at, and a habit of those. Re-learning for
    // any other reason: it says nothing of what the path does.
    if ((state.accepted || 0) > (state.acceptedSeen || 0)) {
      habits.transfer(state, 'shift+', 'level', t);
      habits.transfer(state, 'shift-', 'level', t);
    }
    habits.drop(state, 'shift+');
    habits.drop(state, 'shift-');
  }
  state.acceptedSeen = state.accepted || 0;
  // Spells of "no value" that the path came back from (evaluateDropout()).
  habits.follow(state, 'unavailable', 1, Number.isFinite(state.nullSince), t);
  const counts = cyclingCounts(state, t, options);
  if (counts) habits.follow(state, 'cycling', counts.lastHour, counts.lastHour >= counts.threshold, t);
  else habits.drop(state, 'cycling');
  learnRate(state, t, options);
}

/** A counter's pace, and whether it is surging (evaluateRate()). */
function learnRate(state, t, options) {
  const rate = isCounter(state) && isReady(state, t, options) ? counterRate(state, t) : undefined;
  state.rateNow = rate;
  if (rate === undefined) {
    state.rateSurgeSince = undefined;
    return;
  }
  if (!Number.isFinite(state.rateSince)) state.rateSince = t;
  const record = rateRecord(state, t);
  const opening = state.rateSurgeSince === undefined;
  const factor = opening ? RATE_FACTOR : RATE_CLEAR_FACTOR;
  const learnt = t - state.rateSince >= RATE_HISTORY_MS;
  if (learnt && surges(state, rate, record, factor, opening ? 1 : 0.5, t)) {
    if (state.rateSurgeSince === undefined) {
      state.rateSurgeSince = t;
      state.rateHeld = [];
    }
    // A surge that has lasted this long is how the counter counts now.
    if (t - state.rateSurgeSince >= options.acceptExcursionMs) {
      noteRate(state, rate, t);
      state.rateSurgeSince = undefined;
    }
    return;
  }
  state.rateSurgeSince = undefined;
  holdRate(state, rate, t);
}

// Where a tank or battery runs out is worth a warning hours before it does.
// Waste tanks fill instead of empty, so their limit is at the top.
const DEPLETION_TARGETS = [
  { pattern: /^tanks\.(?:fuel|freshWater|lubrication|gas)\.[^.]+\.currentLevel$/, limit: 0.1, direction: -1, horizonMs: 3 * HOUR_MS, label: '10 %' },
  { pattern: /^tanks\.(?:wasteWater|blackWater)\.[^.]+\.currentLevel$/, limit: 0.9, direction: 1, horizonMs: 3 * HOUR_MS, label: '90 %' },
  { pattern: /^electrical\.batteries\.[^.]+\.(?:stateOfCharge|capacity\.stateOfCharge)$/, limit: 0.2, direction: -1, horizonMs: 2 * HOUR_MS, label: '20 %' }
];

const ALERTING_ZONE_STATES = new Set(['warn', 'alert', 'alarm', 'emergency']);

/** Limits this path is heading toward: from meta.zones, and the built-in depletion targets. */
function forecastLimits(state) {
  const limits = [];
  for (const target of DEPLETION_TARGETS) {
    if (target.pattern.test(state.path)) {
      limits.push({ value: target.limit, direction: target.direction, horizonMs: target.horizonMs, zone: 'low', label: target.label });
    }
  }
  if (Array.isArray(state.zones)) {
    for (const zone of state.zones) {
      if (!zone || !ALERTING_ZONE_STATES.has(zone.state)) {
        continue;
      }
      const lower = Number.isFinite(zone.lower) ? zone.lower : undefined;
      const upper = Number.isFinite(zone.upper) ? zone.upper : undefined;
      if (lower !== undefined) {
        limits.push({ value: lower, direction: 1, horizonMs: 30 * 60 * 1000, zone: zone.state });
      }
      if (upper !== undefined) {
        limits.push({ value: upper, direction: -1, horizonMs: 30 * 60 * 1000, zone: zone.state });
      }
    }
  }
  return limits;
}

/** When the minute-by-minute trend will cross a limit, if that is soon. */
function evaluateForecast(state, t, options) {
  if (state.kind !== 'continuous' || !isReady(state, t, options) || state.angle) {
    return null;
  }
  const limits = forecastLimits(state);
  if (limits.length === 0) {
    return null;
  }
  const series = seriesWithOpen(state, 'minutes', 'minuteBucket', MINUTE_BUCKET_MS);
  let best;
  for (const limit of limits) {
    const windowMs = limit.horizonMs >= HOUR_MS ? 60 * 60 * 1000 : 15 * 60 * 1000;
    const points = series.filter(([at]) => at >= t - windowMs);
    if (points.length < (windowMs >= HOUR_MS ? 10 : 5)) {
      continue;
    }
    const trend = linearTrend(points);
    if (!trend || trend.r2 < 0.6 || Math.sign(trend.slope) !== limit.direction) {
      continue;
    }
    const current = state.fast;
    const remaining = limit.value - current;
    if (Math.sign(remaining) !== limit.direction) {
      // Already past the limit: that is the zone's own alarm, not a forecast.
      continue;
    }
    const etaMs = remaining / trend.slope;
    if (etaMs > 0 && etaMs <= limit.horizonMs && (!best || etaMs < best.etaMs)) {
      best = { etaMs, limit: limit.value, zone: limit.zone, label: limit.label, slopePerMinute: trend.slope * 60 * 1000, r2: trend.r2 };
    }
  }
  return {
    active: Boolean(best),
    severity: 'warn',
    evidence: best ? { value: state.last, ...best } : { value: state.last }
  };
}

const MAX_REGIMES = 6;
// How long a baseline must have been settled to be worth filing under its
// operating state: a few minutes of a transition is not "how it runs".
const MIN_SETTLED_FOR_REGIME_MS = 10 * 60 * 1000;

/** File the current baseline under the operating state the path is leaving. */
function saveRegimeBaseline(state, key, t, options) {
  if (state.kind !== 'continuous' || state.mean === undefined || !isReady(state, t, options)) {
    return false;
  }
  // Not in the middle of a departure: the mean is held back from it then,
  // and is not the level the path had in this state - filed, it would be
  // restored the next time and report the state's own level as a departure.
  if (state.excursionSince !== undefined) {
    return false;
  }
  const settledSince = Math.max(state.firstAt + options.learningMs, state.relearnUntil);
  if (t - settledSince < MIN_SETTLED_FOR_REGIME_MS) {
    return false;
  }
  if (!state.regimes) state.regimes = {};
  state.regimes[key] = { mean: state.mean, variance: state.variance, devVar: state.devVar, savedAt: t };
  const keys = Object.keys(state.regimes);
  if (keys.length > MAX_REGIMES) {
    keys.sort((a, b) => state.regimes[a].savedAt - state.regimes[b].savedAt);
    delete state.regimes[keys[0]];
  }
  return true;
}

/** Arrange for the baseline learned in `key` to come back once the transition settles. */
function planRegimeRestore(state, key) {
  const saved = state.regimes && state.regimes[key];
  state.restoreOnSettle = saved ? { key, mean: saved.mean, variance: saved.variance, devVar: saved.devVar } : undefined;
  return Boolean(saved);
}

/** Apply a planned restore once the settling period has passed. */
function applyPendingRestore(state, t) {
  if (!state.restoreOnSettle || t < state.relearnUntil) {
    return false;
  }
  state.mean = state.restoreOnSettle.mean;
  state.variance = state.restoreOnSettle.variance;
  // Filed before the yardstick was learned: the spread, as then.
  state.devVar = Number.isFinite(state.restoreOnSettle.devVar) ? state.restoreOnSettle.devVar : state.variance;
  state.restoredRegime = state.restoreOnSettle.key;
  state.restoreOnSettle = undefined;
  state.excursionSince = undefined;
  return true;
}

/**
 * Open the path's kind to decision again, as for a new path (its baseline is
 * kept, and keeps learning as before): the counter listing it was decided
 * under has changed.
 */
function redecideKind(state, t, quietMs) {
  // A measurement (by name or unit) that was continuous stays continuous:
  // the listing never made it one, and a whole-number reading (coolant in
  // whole kelvin) decided again would turn discrete and absorb a real shift.
  if (state.kind === 'continuous' && isMeasurement(state)) {
    return;
  }
  // A second re-decision before the first is settled keeps the kind the
  // path had before both: still 'unknown' is not what it was.
  if (state.redecideFrom === undefined || state.kind !== 'unknown') {
    state.redecideFrom = state.kind;
  }
  state.redecideQuietMs = Number.isFinite(quietMs) ? quietMs : undefined;
  state.kind = 'unknown';
  state.distinct = [];
  state.allInteger = true;
  state.kindN = 0;
  // States already seen stay known, and a pending new state is dropped.
  // States first seen in the next while are learned without a finding (from
  // here, and again from when the kind is known, if it turns out discrete);
  // the baseline and every other check carry on as they were.
  state.newStateAt = undefined;
  state.newStateValue = undefined;
  if (Number.isFinite(t) && Number.isFinite(quietMs)) {
    state.newStateQuietUntil = Math.max(state.newStateQuietUntil || 0, t + quietMs);
  }
}

/** Restart the baseline: an operating-state change has made the old one wrong. */
function beginRelearn(state, t, durationMs) {
  state.relearnUntil = Math.max(state.relearnUntil, t + durationMs);
  state.relearnN = 0;
}

/** The compact form saved to disk. */
function exportPathState(state) {
  const { recent, recentBucket, newStateAt, newStateValue, prevAt, startupDeparture, startupSettledAt, startupSettledWithin, startupTickAt, reacquiredAt, departureDrivers, departureSince, reacquireNoted, startupUntil, rateNow, rateSurgeSince, nullAt, runBroken, ...rest } = state;
  return rest;
}

/**
 * `legacyGaps`: the save is from before outages and the sender's rhythm were
 * kept apart, when `longestGap` held both.
 */
function importPathState(saved, now, { legacyGaps = false, savedAt } = {}) {
  if (!saved || typeof saved.path !== 'string') {
    return undefined;
  }
  const state = { ...createPathState(saved.path, now), ...saved };
  // Such a save's longest gap may be an outage the path came back from (two
  // days unplugged) rather than its rhythm: on a path that has settled
  // regular it is dropped, whatever its length, as an outage is when the
  // path settles - or a later death would wait three days, or a two-hour
  // outage would set the limit for good. A nightly silence dropped with it
  // is learned again the next night.
  if (legacyGaps && state.settled) delete state.longestGap;
  // A gap of more than a day is an outage, never the rhythm, whenever the
  // save was made: kept as one (two hours at most, until the path settles).
  if (state.longestGap > RHYTHM_GAP_MS) {
    state.outageGap = Math.max(Number.isFinite(state.outageGap) ? state.outageGap : 0, 2 * RAISED_SILENCE_MS);
    delete state.longestGap;
  }
  // A restart is not a dropout: give every path its normal chance to report.
  state.lastAt = now;
  state.acceptedAt = undefined;
  state.prevAt = undefined;
  state.sameSince = now;
  state.sameCount = 0;
  state.recent = [];
  state.recentBucket = undefined;
  state.transitionMinutes = Array.isArray(saved.transitionMinutes) ? saved.transitionMinutes.slice(-61) : [];
  state.recentSteps = Array.isArray(saved.recentSteps) ? saved.recentSteps.slice(-RECENT_STEPS) : [];
  state.rises = Number.isFinite(saved.rises) ? saved.rises : 0;
  // Set from the current settings by the engine, not from the save.
  state.counterOptIn = undefined;
  delete state.riseHours;
  // From before a stuck sensor was judged by its own runs.
  delete state.changeRate;
  delete state.runRate;
  // The first run after a restart began before it: not learned.
  state.runBroken = true;
  state.rateNow = undefined;
  state.rateSurgeSince = undefined;
  state.nullAt = undefined;
  // Sending "no value" when the plugin stopped: since when is kept, so a
  // sensor that has had no value for an hour is not said to have had none
  // for ten minutes after a restart. (Its dropout still counts from now.)
  state.nullSince = Number.isFinite(saved.nullSince) && saved.nullSince <= now ? saved.nullSince : undefined;
  // Every path is reacquired after a restart (evaluateDropout()).
  state.reacquireUntil = now + RESTART_DETOUR_MS;
  state.readsSinceRestart = 0;
  // A state path starts on its restart detour from the value it had (or,
  // restarted again while still on one, from the value it had before that).
  // Values first seen during a start-up or a restart detour that have not
  // been judged yet stay pending over another restart: they are already
  // among the values seen, so nothing else would bring them back.
  state.startupNew = Array.isArray(saved.startupNew) ? saved.startupNew.filter((value) => typeof value === 'string') : undefined;
  if (state.startupNew && state.startupNew.length === 0) state.startupNew = undefined;
  if (state.kind === 'discrete') {
    const before = saved.restartFrom !== undefined ? saved.restartFrom : saved.lastValue;
    state.restartFrom = before === undefined || before === 'null' ? undefined : before;
    state.restartUntil = state.restartFrom === undefined ? undefined : now + RESTART_DETOUR_MS;
  }
  // An episode in progress carries on over a short restart (the 30 minutes
  // an open finding does): a spike the restart cut in two is still one.
  state.habits = habits.importHabits(saved.habits, now, {
    keepOpen: Number.isFinite(savedAt) && savedAt <= now && now - savedAt <= 30 * 60 * 1000
  });
  // Saves from before falls and resets were told apart: what went down
  // before is not known to have been a reset or a fall, so the evidence
  // for a counter that shows itself by its resets starts now.
  if (!Number.isFinite(saved.falls)) state.falls = 0;
  if (!Number.isFinite(saved.resets)) state.resets = 0;
  // Saves from before a counter could be reset to a value other than zero
  // took such a reset for a fall, for good: whether it falls is learned again.
  if (!Number.isFinite(saved.climb)) {
    state.climb = 0;
    state.monotonic = true;
    state.fallAt = undefined;
  }
  // Saves from before a day of climbing was a count: its day starts now.
  if (!Number.isFinite(saved.climbSince) && (state.climb || 0) > 0) {
    state.climbSince = now;
    state.climbMs = 0;
  }
  // Saves from before the climbing was timed as it was watched: the time
  // up to their last reading, not the hours the plugin was down since.
  if (Number.isFinite(state.climbSince) && !Number.isFinite(saved.climbMs)) {
    state.climbMs = Number.isFinite(saved.lastAt) ? Math.max(0, saved.lastAt - state.climbSince) : 0;
  }
  // Saves from before null was "no value": it is not one of the path's states.
  if (state.seen && typeof state.seen === 'object' && 'null' in state.seen) {
    const { null: _dropped, ...seen } = state.seen;
    state.seen = seen;
  }
  if (state.lastValue === 'null') state.lastValue = undefined;
  state.minutes = Array.isArray(saved.minutes) ? saved.minutes.slice(-MINUTE_BUCKETS) : [];
  return state;
}

function hasDepletionTarget(path) {
  return DEPLETION_TARGETS.some((target) => target.pattern.test(path));
}

/** Whether a departure of the path is in progress (one its habits follow). */
function departing(state) {
  return habits.isOpen(state, 'shift+') || habits.isOpen(state, 'shift-');
}

/** The habits a path has formed, for the report and the inventory. */
function habitSummary(state, t) {
  return habits.summary(state, t);
}

/** The operator found a finding on this path useful: it is not to be got used to. */
function forgetHabits(state) {
  habits.forget(state);
}

module.exports = {
  HOUR_MS,
  departing,
  inStartup,
  evaluateRate,
  resolutionOf,
  restartHold,
  forgetHabits,
  habitSummary,
  learnFromTick,
  usualRunMs,
  applyPendingRestore,
  planRegimeRestore,
  saveRegimeBaseline,
  hasDepletionTarget,
  isCounterState: isCounter,
  counterListingFor,
  redecideKind,
  beginRelearn,
  createPathState,
  evaluateCycling,
  evaluateDropout,
  evaluateForecast,
  evaluateFrozen,
  evaluateNewState,
  evaluateShift,
  exportPathState,
  importPathState,
  isReady,
  noiseFloor,
  observe,
  seriesWithOpen
};
