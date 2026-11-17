'use strict';

const monitor = require('./path-monitor.cjs');
const { createGnssState, evaluateGnss, isGnssPath, observeGnss } = require('./gnss.cjs');
const { narrate } = require('./narrate.cjs');
const { describePath: describePathName } = require('./format.cjs');
const sources = require('./sources.cjs');
const rules = require('./rules.cjs');
const { isAnglePath } = require('../signalk-units.cjs');
const { sunElevationDeg } = require('./sun.cjs');
const learnedStates = require('./drivers.cjs');
const restartLearning = require('./restarts.cjs');

/**
 * Watchkeeper engine: every watched Signal K path in, findings and incidents
 * out.
 *
 * Pure and clock-free - the caller passes the time with every call - so the
 * same engine runs live inside the plugin, over a day of History API data in a
 * replay, and in a unit test, and gives the same answers in all three. It uses
 * no language model at any point: detection is statistics, and the text is
 * templates (narrate.cjs).
 *
 * Pipeline, per sample:
 *   ingest -> regime gates -> exclusions -> path monitor / GNSS monitor
 * and on every tick:
 *   conditions -> tracker (persistence, hysteresis) -> findings -> incidents
 */

const STATE_VERSION = 1;
const MAX_FINDING_LOG = 1000;
const FEEDBACK_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_INCIDENTS = 50;
// Findings one incident keeps. A finding that stays open keeps its incident
// active, so a neighbour that clears and recurs for days would otherwise add
// a snapshot on every recurrence: past this, the oldest cleared ones go (the
// first, the incident's earliest sign, and every open one are kept).
const MAX_INCIDENT_FINDINGS = 50;
const MAX_REGIME_CHANGES = 20;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// An incident takes findings by timing only while it is forming: each within
// 3 minutes of its last new finding (a cascade), and none later than 10
// minutes after it opened. After that only a finding in a system that still
// has an open finding in it joins - an incident kept open for hours by one
// finding is not a net for everything that happens meanwhile.
const INCIDENT_JOIN_GAP_MS = 3 * MINUTE;
const INCIDENT_FORMING_MS = 10 * MINUTE;

// The thresholds a departure needs before the path has a history, and the
// alert budget once it has one: how many of a path's routine departures a
// day may still be reported (habits.cjs).
const SENSITIVITY = {
  low: { zWarn: 8, zAlert: 14, zClear: 4, alertsPerDay: 0.01 },
  normal: { zWarn: 6, zAlert: 10, zClear: 3, alertsPerDay: 0.03 },
  high: { zWarn: 4.5, zAlert: 8, zClear: 2.5, alertsPerDay: 0.1 }
};

/**
 * Paths whose normal job is to change quickly: they follow the helm, the
 * wind and the seabed, and a "sudden change" in them is seamanship, not news.
 * Position and fix quality are excluded from the per-path checks because the
 * GNSS integrity monitor reads them instead. Notifications are never watched:
 * they are alarms already, and this plugin raises its own there.
 */
const DEFAULT_EXCLUDE = [
  'navigation.position',
  'navigation.gnss',
  'navigation.datetime',
  'navigation.courseOverGround*',
  'navigation.heading*',
  'navigation.attitude',
  'navigation.rateOfTurn',
  'navigation.speedOverGround',
  'navigation.speedThroughWater*',
  'navigation.leewayAngle',
  'navigation.course',
  'navigation.courseRhumbline',
  'navigation.courseGreatCircle',
  'navigation.destination',
  'navigation.anchor',
  'navigation.trip',
  'navigation.log',
  'navigation.magneticVariation*',
  'environment.wind',
  'environment.current',
  'environment.depth',
  'environment.tide',
  'environment.sun',
  'environment.moon',
  'environment.mode',
  'environment.time',
  'steering',
  'performance',
  'design',
  'resources',
  'communication',
  '**.runTime'
];

/**
 * Operating-state changes that make a learned baseline wrong. When an engine
 * starts, its temperatures climb, the alternator lifts the battery voltage and
 * fuel flow appears - all at once, all expected. Instead of an alert for each,
 * the affected paths re-learn their baseline for a settling period.
 */
const DEFAULT_GATES = [
  {
    pattern: /^propulsion\.([^.]+)\.revolutions$/,
    regime: (value) => (typeof value === 'number' ? (value > 0.5 ? 'running' : 'stopped') : undefined),
    affects: (match) => [`propulsion.${match[1]}.`, 'electrical.', 'tanks.fuel.'],
    settleMs: 15 * MINUTE,
    label: (match, regime) => `Engine ${match[1]} ${regime}`
  },
  {
    pattern: /^propulsion\.([^.]+)\.state$/,
    regime: (value) => (value === undefined || value === null ? undefined : String(value)),
    affects: (match) => [`propulsion.${match[1]}.`, 'electrical.', 'tanks.fuel.'],
    settleMs: 15 * MINUTE,
    label: (match, regime) => `Engine ${match[1]} state ${regime}`
  },
  {
    pattern: /^electrical\.(?:chargers?|inverters?|solar|alternators?|ac)\.([^.]+)\.(?:chargingMode|mode|state)$/,
    regime: (value) => (value === undefined || value === null ? undefined : String(value)),
    affects: () => ['electrical.'],
    settleMs: 10 * MINUTE,
    label: (match, regime) => `${match[0].split('.')[1]} ${match[1]} ${regime}`
  },
  {
    pattern: /^navigation\.state$/,
    regime: (value) => (value === undefined || value === null ? undefined : String(value)),
    affects: () => ['propulsion.', 'electrical.', 'tanks.'],
    settleMs: 10 * MINUTE,
    label: (match, regime) => `Vessel ${regime}`
  }
];

const RESTING_REGIME = /^(?:stopped|off|idle|standby|not[ _-]?running|disabled|moored|0)$/i;

// While the watch starts up, every plugin announces its values again, and
// some pass through another state on the way (a link "down" until it has
// connected). Switches then are not counted, a new state then must still
// hold at the end, and an operating state that changes then is applied as
// it stands at the end, once. How long that is, how long a finding open
// when the watch stopped waits to come back (the same finding, in the same
// incident), and how long each path is given to be heard again, are
// learned from how the sources came back at earlier restarts
// (restarts.cjs); its defaults hold until then.
const STARTUP_MS = restartLearning.DEFAULT_STARTUP_MS;
// Carried over only for a restart this soon after the last save.
const CARRY_MAX_GAP_MS = 30 * MINUTE;
// An operating state that changes more than this often in an hour is
// flapping (a solar charger hunting between bulk and off in poor light):
// its changes wait until it has held one state this long, or every change
// would start the paths it affects re-learning, and they would be watched
// by nothing all day.
const GATE_FLAP_CHANGES = 4;
const GATE_FLAP_HOLD_MS = 10 * MINUTE;

/**
 * Day, twilight and night, as an operating state of everything solar.
 * Worked out from the vessel's own position and the time (sun.cjs), so it
 * needs no sun path and no other plugin.
 *
 * Twilight is a state of its own because it is where solar paths change:
 * a panel's voltage comes up in the dawn long before the sun does and goes
 * in the dusk after it has set, and a charger switches modes as the light
 * comes and goes. Judged against the night's baseline or the day's, all of
 * that is news every day; so solar paths re-learn for as long as the
 * twilight lasts (an hour in a northern winter, all night near midsummer),
 * and are judged again once the sun is clearly up or clearly down.
 */
const DAYLIGHT_GATE = 'watchkeeper.daylight';
const DAYLIGHT = {
  affects: ['electrical.solar.'],
  // Clearly up, and below civil twilight (-6°): no light worth a panel.
  dayDeg: 3,
  nightDeg: -7,
  // A boundary is crossed once, not back and forth as the fix wanders.
  hysteresisDeg: 0.5,
  settleMs: 15 * MINUTE,
  everyMs: MINUTE,
  // How long the receiver followed must be silent before another is.
  sourceSilenceMs: 5 * MINUTE,
  // The night's baseline (panels at 0 V, no yield) is the same every night
  // and comes back; a day's depends on the weather and the season, and is
  // learned afresh each morning.
  restoreInto: (regime) => regime === 'night',
  labels: { day: 'Sun up', twilight: 'Twilight', night: 'Sun down' }
};

function daylightRegime(elevation, previous) {
  const { dayDeg, nightDeg, hysteresisDeg } = DAYLIGHT;
  const regime = elevation >= dayDeg ? 'day' : elevation <= nightDeg ? 'night' : 'twilight';
  if (previous === undefined || previous === regime) return regime;
  const nearDay = Math.abs(elevation - dayDeg) < hysteresisDeg && (previous === 'day' || regime === 'day');
  const nearNight = Math.abs(elevation - nightDeg) < hysteresisDeg && (previous === 'night' || regime === 'night');
  return nearDay || nearNight ? previous : regime;
}

// How long a condition must hold before it is a finding, and how long it must
// be gone before the finding clears. Persistence keeps a one-second glitch out
// of the operator's way; the clear delay keeps a value hovering at the
// threshold from opening and closing the same finding every few seconds.
const TIMING = {
  shift: { persistMs: 15000, clearMs: 60000 },
  rate: { persistMs: 2 * MINUTE, clearMs: 5 * MINUTE },
  dropout: { persistMs: 0, clearMs: 0 },
  frozen: { persistMs: 0, clearMs: 0 },
  newState: { persistMs: 0, clearMs: 0 },
  cycling: { persistMs: 0, clearMs: 10 * MINUTE },
  forecast: { persistMs: 2 * MINUTE, clearMs: 5 * MINUTE },
  feed: { persistMs: 0, clearMs: 0 },
  disagree: { persistMs: 30000, clearMs: 60000 },
  failover: { persistMs: 0, clearMs: 0 },
  rule: { persistMs: 5000, clearMs: 30000 },
  'gnss.jump': { persistMs: 0, clearMs: 0 },
  'gnss.deadReckoning': { persistMs: 30000, clearMs: 60000 },
  'gnss.sourcesDisagree': { persistMs: 30000, clearMs: 60000 },
  'gnss.quality': { persistMs: 30000, clearMs: 60000 },
  'gnss.frozen': { persistMs: 0, clearMs: 10000 },
  'gnss.clock': { persistMs: 0, clearMs: 0 },
  'gnss.lost': { persistMs: 0, clearMs: 0 }
};

const SEVERITY_RANK = { warn: 1, alert: 2 };

// How the report names a habit (habits.cjs keys).
const HABIT_WORDS = { 'shift+': 'rising for a while', 'shift-': 'dipping for a while', cycling: 'switching often', unavailable: 'having no value for a while' };

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function toBounded(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/**
 * Why an `ollamaUrl` setting cannot be used, or undefined. It is refused
 * rather than replaced by the default, so a mistyped host is named to the
 * operator instead of a model on localhost being asked in its place.
 */
function ollamaUrlProblem(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return 'is not a valid URL (start it with http:// or https://, for example http://gpu.local:11434)';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'is not an http or https URL (start it with http:// or https://, for example http://gpu.local:11434)';
  }
  if (url.username || url.password) {
    return 'has a user name or password in it; credentials in the URL are not supported';
  }
  if (url.search || url.hash || /[?#]/.test(text)) {
    // The API path is appended to it: after a ? or # it would not be a path.
    return 'has a query or a fragment in it; give only the server, for example http://gpu.local:11434';
  }
  return undefined;
}

/**
 * The Ollama base URL without a trailing slash (blank is the default), or,
 * when the setting cannot be used, no URL and why.
 */
function normalizeOllamaUrl(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  if (!text) return { ollamaUrl: DEFAULT_OLLAMA_URL };
  const problem = ollamaUrlProblem(text);
  return problem ? { ollamaUrl: '', ollamaUrlProblem: problem } : { ollamaUrl: text };
}

function normalizeWatchConfig(options = {}) {
  const sensitivity = Object.prototype.hasOwnProperty.call(SENSITIVITY, options.watchSensitivity)
    ? options.watchSensitivity
    : 'normal';
  const extraExclude = Array.isArray(options.watchExcludePaths)
    ? options.watchExcludePaths.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const useDefaults = toBoolean(options.watchDefaultExclusions, true);
  const counterPaths = Array.isArray(options.watchCounterPaths)
    ? options.watchCounterPaths.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  return {
    watchEnabled: toBoolean(options.watchEnabled, false),
    watchSensitivity: sensitivity,
    watchNotifications: toBoolean(options.watchNotifications, true),
    watchSound: toBoolean(options.watchSound, false),
    watchLearningMinutes: toBounded(options.watchLearningMinutes, 30, 1, 24 * 60),
    watchMaxPaths: Math.round(toBounded(options.watchMaxPaths, 1500, 10, 10000)),
    watchExcludePaths: extraExclude,
    watchDefaultExclusions: useDefaults,
    watchCounterPaths: counterPaths,
    watchRules: rules.normalizeRules(options.watchRules),
    // The model that reads a rule the parser cannot: blank is the parser only.
    ruleAssistModel: typeof options.ruleAssistModel === 'string' ? options.ruleAssistModel.trim() : '',
    ...normalizeOllamaUrl(options.ollamaUrl),
    exclude: [...(useDefaults ? DEFAULT_EXCLUDE : []), ...extraExclude]
  };
}

/** Detector options for a normalized watch config. */
function detectorOptions(config) {
  return {
    ...SENSITIVITY[config.watchSensitivity || 'normal'],
    minIntervalMs: 1000,
    minSamples: 30,
    acceptExcursionMs: 60 * MINUTE,
    relearnMs: 10 * MINUTE,
    learningMs: (config.watchLearningMinutes || 30) * MINUTE,
    maxRegularIntervalMs: MINUTE,
    dropoutMinMs: 30000,
    dropoutFactor: 10,
    frozenMinSamples: 100,
    frozenMinRepeats: 30,
    frozenMs: 5 * MINUTE,
    eventHoldMs: 10 * MINUTE,
    cyclingLearningMs: 6 * HOUR,
    cyclingMinPerHour: 4,
    gnssMaxSpeedKn: 40,
    gnssJumpMinMetres: 100,
    gnssCurrentAllowanceKn: 2,
    gnssSourceDisagreeMetres: 100,
    gnssFrozenMs: MINUTE,
    gnssClockJumpMs: 30000,
    gnssLostMs: 30000
  };
}

/**
 * `navigation.heading*`, `**.runTime`, `steering`: `*` is one segment's worth
 * of characters, `**` crosses segments, and every pattern also covers the
 * paths beneath it.
 */
/**
 * Whether a gate's entry covers a path: an entry ending in a dot is a
 * branch (every path under it), any other the one path it names - what a
 * learned operating state moves.
 */
function covers(entry, path) {
  return entry.endsWith('.') ? path.startsWith(entry) : path === entry;
}

function compileGlob(pattern) {
  const text = String(pattern || '').trim();
  if (!text.includes('*')) {
    return (path) => path === text || path.startsWith(`${text}.`);
  }
  const source = text
    .split('**')
    .map((part) => part.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*'))
    .join('.*');
  const regex = new RegExp(`^${source}(?:\\..*)?$`);
  return (path) => regex.test(path);
}

/** A matcher that returns the first pattern a path matches, or undefined. */
function compileMatchers(patterns) {
  const matchers = patterns.map((pattern) => [pattern, compileGlob(pattern)]);
  return (path) => {
    for (const [pattern, match] of matchers) {
      if (match(path)) return pattern;
    }
    return undefined;
  };
}

/** Leaves of an object value (attitude, a nested sensor), bounded. */
function leaves(path, value, out = [], depth = 0) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    out.push([path, value]);
    return out;
  }
  if (depth >= 3) {
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    if (out.length >= 32) break;
    leaves(`${path}.${key}`, item, out, depth + 1);
  }
  return out;
}

// How long after its last sample a steady path that is silent now may have
// gone quiet and still be part of one feed silence with the others; a path
// watched for its cycle or for a raised silence may have, within its own
// limit (its gaps are that long while it is alive).
const FEED_ONSET_MS = 5 * MINUTE;
// The longest a feed silence waits, after its paths went quiet, for a slower
// path on their connection that is not yet overdue (feedSilence()).
const FEED_HOLD_MS = 2 * MINUTE;
// The moments of a feed silence judged at most, newest first, besides the
// one most silent paths share (feedSilence()).
const FEED_MOMENTS = 8;

/**
 * The connection a path's samples came in on: the provider's own label when
 * the server gave one (`venus` for every device of the Venus plugin, `can0`
 * for `can0.35`), else the source up to its last dot - Signal K names a
 * source by its connection's label and, after a last dot, the device on it:
 * `can0` of `can0.35`, `n2k.can1` of `n2k.can1.35`, `ttyUSB0` of
 * `ttyUSB0.GP`. A label with no dot is a connection of its own (a plugin's,
 * `gps`). Paths whose source is not known are one connection together:
 * nothing tells them apart.
 */
function feedOf(state) {
  if (state.connection) return String(state.connection);
  if (!state.source) return '';
  const label = String(state.source);
  const dot = label.lastIndexOf('.');
  return dot > 0 ? label.slice(0, dot) : label;
}

/**
 * Which dropouts are one silent data feed. `watched` is [state, cond, muted]
 * for every path with a dropout check; `earlier` the paths the feed silence
 * reported at the last tick folded in; `feedMuted` whether the feed finding
 * is muted (a muted feed still folds its paths' dropouts in while it is
 * silent). A feed silence is paths that went quiet together: the silent
 * unmuted paths whose silences could have begun at one moment (each within
 * its own span after its last sample). Of the moments that most such paths
 * share, the latest that is a silent feed is taken (else the one most
 * share): a group that went quiet hours before is not evidence that the feed
 * died now, and its paths keep their own dropouts. Only moments enough paths
 * share to be a feed are judged, the newest few of them. The paths of a feed
 * silence already reported stay in it while they are silent, so a second
 * connection that dies does not unfold it.
 *
 * A connection with a live path did not die: its silent paths are their own
 * dropouts. Live is a path that is not overdue now and reported after the
 * group went quiet, beyond the jitter of its own interval - a later sample by
 * more than that interval, or two samples since: a slow path whose one
 * sample came in a few seconds after the rest went quiet was still on its
 * way. Raised and cycling paths that are neither silent nor live are left
 * out, as they may be silent with the rest without being overdue yet; paths
 * that went quiet before the group are left out of the paths the half is
 * taken of, as they were not reporting when it went quiet.
 *
 * A connection with a path that is neither live nor overdue yet - one due to
 * report within FEED_HOLD_MS of the group going quiet - is undecided: its
 * silent paths are `held` (neither a feed nor dropouts) until that path
 * reports twice, or once late enough (live: its paths are dropouts), or
 * misses its next sample (the feed), and for FEED_HOLD_MS at most. While the
 * feed itself depends on such a connection, `holding` is set: the feed is
 * neither reported nor cleared.
 */
function feedSilence(watched, earlier = new Set(), { feedMuted = false, now } = {}) {
  const silentUnmuted = watched.filter(([, cond, muted]) => cond.active && !muted);
  const isOwn = (cond) => Boolean(cond.evidence.cycle || cond.evidence.raised);
  const span = ([state, cond]) => [
    state.lastAt,
    state.lastAt + (isOwn(cond) ? cond.evidence.limit : Math.max(FEED_ONSET_MS, cond.evidence.limit))
  ];
  const at = Number.isFinite(now)
    ? now
    : watched.length > 0
      ? watched[0][0].lastAt + watched[0][1].evidence.silentFor
      : 0;
  // The moments the most silent paths' spans share: each peak of how many
  // spans overlap.
  const edges = [];
  for (const entry of silentUnmuted) {
    const [from, to] = span(entry);
    edges.push([from, 1], [to, -1]);
  }
  edges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const peaks = [];
  let depth = 0;
  for (const [index, [moment, step]] of edges.entries()) {
    depth += step;
    const next = edges[index + 1];
    if (step > 0 && (!next || next[1] < 0)) peaks.push({ at: moment, depth });
  }
  // A silent feed needs at least half of the paths it is taken of silent:
  // the steady paths that still report always count among those, and the
  // silent ones are at most a moment's group, the feed reported before and
  // the muted silent paths. A moment too few paths share is not judged.
  let reporting = 0;
  let beyondGroup = 0;
  for (const [state, cond, muted] of watched) {
    if (!cond.active && !isOwn(cond)) reporting += 1;
    else if (cond.active && (muted || earlier.has(state.path))) beyondGroup += 1;
  }
  const canBeFeed = (peak) => peak.depth + beyondGroup >= Math.max(4, reporting);
  let judged = 0;

  function judge(moment, { heldAsLive = false } = {}) {
    judged += 1;
    const group = silentUnmuted.filter((entry) => {
      const [from, to] = span(entry);
      return from <= moment && moment <= to;
    });
    const quietFrom = group.reduce((latest, [state]) => Math.max(latest, state.lastAt), -Infinity);
    // When each connection's paths of the group went quiet: a connection is
    // held from its own silence on, so a path elsewhere that dies later and
    // joins the group does not start the wait again.
    const quietOn = new Map();
    for (const [state] of group) {
      const feed = feedOf(state);
      quietOn.set(feed, Math.max(quietOn.has(feed) ? quietOn.get(feed) : -Infinity, state.lastAt));
    }
    // Since when a path's connection has been quiet: its own paths' silence,
    // else the group's.
    const quietOf = (state) => (quietOn.has(feedOf(state)) ? quietOn.get(feedOf(state)) : quietFrom);
    const shortest = group.reduce((least, [state]) => Math.min(least, state.intervalMean), Infinity);
    const jitter = Math.min(MINUTE, Math.max(5 * 1000, 2 * shortest));
    const overdue = ([state, cond]) => !isOwn(cond) && cond.evidence.silentFor > Math.max(jitter, 1.5 * state.intervalMean);
    const isLive = (entry) => {
      const [state, cond] = entry;
      if (cond.active) return false;
      // A steady path that has missed its next sample is not evidence of
      // anything; a raised or cycling one is not overdue before its limit.
      if (overdue(entry)) return false;
      // Since its own connection went quiet: a connection whose paths went
      // quiet before another's did is live by what it sent after its own
      // silence, not only after the later one.
      const since = quietOf(state);
      return state.lastAt - since > Math.max(jitter, state.intervalMean) || state.prevAt > since;
    };
    // Not live yet, nor overdue, and due to report while the feed may wait
    // for it: its next sample says which. A steady path's is an interval
    // after its last; a raised or cycling one's gaps are its own (its last
    // gap, a cycle's longest outage), often far longer than its mean.
    const isPending = (entry) => {
      const [state, cond] = entry;
      if (cond.active || overdue(entry) || isLive(entry)) return false;
      let gap = state.intervalMean;
      if (isOwn(cond)) {
        const last = state.lastAt - state.prevAt;
        gap = Math.max(gap, Number.isFinite(last) ? last : Infinity, cond.evidence.cycle ? cond.evidence.limit / 2 : 0);
      }
      // A raised or cycling path past its own due time has missed it, as a
      // steady one that is overdue has.
      if (isOwn(cond) && at > state.lastAt + 1.5 * gap) return false;
      const since = quietOf(state);
      return at <= since + FEED_HOLD_MS && state.lastAt + gap <= since + FEED_HOLD_MS;
    };
    const liveFeeds = new Set();
    const pendingFeeds = new Set();
    if (group.length > 0) {
      for (const entry of watched) {
        if (isLive(entry)) liveFeeds.add(feedOf(entry[0]));
        else if (isPending(entry)) pendingFeeds.add(feedOf(entry[0]));
      }
    }
    // Undecided connections: a pending path and silent paths of the group
    // not yet in a feed reported.
    const heldFeeds = new Set(
      group
        .filter(([state]) => !earlier.has(state.path) && pendingFeeds.has(feedOf(state)) && !liveFeeds.has(feedOf(state)))
        .map(([state]) => feedOf(state))
    );
    // Taken for live (heldAsLive): their paths not yet in a feed reported
    // are left out, as a live connection's are.
    const outside = (state) => liveFeeds.has(feedOf(state)) || (heldAsLive && heldFeeds.has(feedOf(state)) && !earlier.has(state.path));
    const members = new Set(group.filter(([state]) => !outside(state)).map(([state]) => state.path));
    if (members.size > 0) {
      for (const [state] of silentUnmuted) {
        if (earlier.has(state.path) && !liveFeeds.has(feedOf(state))) members.add(state.path);
      }
    }
    const held = new Set(
      group.filter(([state]) => !earlier.has(state.path) && heldFeeds.has(feedOf(state))).map(([state]) => state.path)
    );

    let regular = 0;
    let silent = 0;
    let regularAll = 0;
    let silentAll = 0;
    let quietSince = Infinity;
    const silentSources = new Set();
    // The spans of the members from a feed already reported that are not of
    // this moment's group: a muted path that went quiet with them is one
    // with them too.
    const earlierSpans = [];
    for (const entry of watched) {
      const [state, , muted] = entry;
      if (muted || !members.has(state.path)) continue;
      quietSince = Math.min(quietSince, state.lastAt);
      const [from, to] = span(entry);
      if (earlier.has(state.path) && !(from <= moment && moment <= to)) earlierSpans.push([from, to]);
    }
    // A muted path's silence may have begun with the members' as theirs did:
    // its span holds the moment (or overlaps a span of a member from the
    // feed already reported).
    const onsetWith = (entry) => {
      const [from, to] = span(entry);
      return (from <= moment && moment <= to) || earlierSpans.some(([start, end]) => from <= end && start <= to);
    };
    for (const entry of watched) {
      const [state, cond, muted] = entry;
      if (cond.active) {
        if (muted) {
          // A muted path counts as part of a feed silence only when its
          // silence may have begun at the moment the unmuted ones' did (the
          // test they pass), and its feed is not live: a sensor muted
          // because it is unplugged has been silent for hours, and ten
          // muted paths that went quiet an hour after four unmuted ones did
          // are not one silence with them. Left out, it is left out of the
          // paths the half is taken of too - unless, like an unmuted path,
          // it went quiet after the feed did: it was reporting then.
          if (members.size === 0 || outside(state)) continue;
          if (!onsetWith(entry)) {
            if (!isOwn(cond) && state.lastAt >= quietSince) regularAll += 1;
            continue;
          }
        } else if (!members.has(state.path)) {
          // A path that went quiet after the feed did (on a live
          // connection, or too late to be one with it) was reporting when
          // the feed went quiet: one of the paths the half is taken of.
          if (isOwn(cond) || !(state.lastAt >= quietSince)) continue;
          regularAll += 1;
          regular += 1;
          continue;
        }
        regularAll += 1;
        silentAll += 1;
        if (state.source) silentSources.add(state.source);
        if (!muted) {
          regular += 1;
          silent += 1;
        }
        continue;
      }
      // A raised or cycling path counts once it has reported since the feed
      // went quiet, as a live one; until then it is not a steady path.
      if (isOwn(cond) && !(members.size > 0 && (isLive(entry) || (heldAsLive && isPending(entry) && heldFeeds.has(feedOf(state)))))) continue;
      regularAll += 1;
      if (!muted) regular += 1;
    }
    const allSilent = regularAll >= 4 && silentAll >= Math.max(4, 0.5 * regularAll);
    // Reported unless the silence is only the muted paths' (tick()); a muted
    // feed folds its paths in while it is silent.
    const reportable = allSilent && silent > 0 && silent >= 0.5 * regular && silent >= Math.min(4, regular);
    const feedSilent = feedMuted ? allSilent : reportable;
    return { regular, silent, regularAll, silentAll, allSilent, reportable, feedSilent, sources: [...silentSources], members, held };
  }

  // The latest moment that is a silent feed, else the one most paths share.
  let chosen;
  let chosenAt;
  const candidates = peaks
    .filter(canBeFeed)
    .sort((left, right) => right.at - left.at)
    .slice(0, FEED_MOMENTS);
  for (const peak of candidates) {
    const result = judge(peak.at);
    if (result.allSilent) {
      chosen = result;
      chosenAt = peak.at;
      break;
    }
  }
  if (!chosen) {
    const deepest = peaks.reduce((best, peak) => (!best || peak.depth > best.depth ? peak : best), undefined);
    chosen = deepest ? judge(deepest.at) : judge(-Infinity);
  }
  let holding = false;
  let held = new Set();
  if (chosen.feedSilent && chosen.held.size > 0) {
    // Undecided connections in the silence: is it a feed even if they turn
    // out live? Then it is reported without them, and their paths wait.
    // Else the feed waits for them too, and so do all its paths.
    const without = judge(chosenAt, { heldAsLive: true });
    if (without.feedSilent) {
      held = chosen.held;
      chosen = without;
    } else {
      holding = true;
      held = new Set([...chosen.members].filter((item) => !earlier.has(item)));
    }
  }
  const { regular, silent, regularAll, silentAll, reportable, feedSilent, sources: silentSources, members } = chosen;
  return { regular, silent, regularAll, silentAll, reportable, feedSilent, sources: silentSources, members, held, holding, judged };
}

function pathGroup(path) {
  return String(path || '').split('.').slice(0, 2).join('.');
}

function createWatchEngine(config = {}, { now = 0, onNewPath, rowIntervalMs } = {}) {
  const watchConfig = config.exclude ? config : normalizeWatchConfig(config);
  const options = detectorOptions(watchConfig);
  // A replay feeds aggregated rows, every row interval at best: a path with
  // a value in (nearly) every row is regular there, or a week's replay (61 s
  // rows) would check no path for dropouts at all. Only that: a path updated
  // every 90 s is not regular live, and is not made so by a replay.
  if (Number.isFinite(rowIntervalMs) && rowIntervalMs > 0) {
    options.maxRegularIntervalMs = Math.max(options.maxRegularIntervalMs, 1.25 * rowIntervalMs);
  }
  const isExcluded = compileMatchers(watchConfig.exclude);
  // An entry naming the path exactly wins over a pattern that also covers
  // it, wherever each is in the list.
  const counterPatterns = compileMatchers(watchConfig.watchCounterPaths || []);
  const counterExact = new Set(watchConfig.watchCounterPaths || []);
  const isCounterPath = (path) => (counterExact.has(path) ? path : counterPatterns(path));
  const gates = DEFAULT_GATES;

  const paths = new Map();
  // Excluded path -> the pattern that excluded it, for the inventory.
  const excluded = new Map();
  // Excluded paths are not baselined, but redundant sources on them are still
  // compared: two compasses disagreeing matters even though heading itself is
  // expected to swing. Created only once a second source appears.
  const firstSource = new Map();
  const sourceOnly = new Map();
  const gnssInputs = new Set();
  // The latest value of every leaf, watched or not, for rules: a rule may be
  // about a path the statistics skip ("tell me if the depth is below 3 m").
  const latest = new Map();
  const MAX_LATEST = 6000;
  let activeRules = watchConfig.watchRules || [];
  // Paths a rule reads: kept in `latest` whatever its cap. Those stored past
  // the cap are dropped again when no rule reads them any more, so replacing
  // rules cannot grow `latest` without bound.
  const overflowInputs = new Set();
  let ruleInputs = new Set(activeRules.flatMap((rule) => [rule && rule.path, rule && rule.when && rule.when.path].filter(Boolean)));
  // Operator feedback per path: dismissals (a mute, "not useful") raise that
  // path's thresholds, "useful" lowers them back. Decays with a 14-day
  // half-life, so a one-off dismissal does not deafen a path for good.
  const feedback = new Map();
  // Closed findings, for the watch report.
  let findingLog = [];
  const ruleMemory = new Map();
  let capped = 0;
  const gnss = createGnssState();
  const gateRegimes = new Map();
  const regimeChanges = [];
  const trackers = new Map();
  const findings = new Map();
  let incidents = [];
  let incidentCounter = 0;
  let mutes = [];
  let mutesCompiled = () => false;
  let lastTick = now;
  // The paths the feed silence folded in at the last tick (feedSilence()).
  let feedMembers = new Set();
  const startedAt = now;
  options.startupUntil = now + STARTUP_MS;
  // Findings open when the watch last stopped, by key (importState()).
  let carried = new Map();
  let carryUntil = -Infinity;
  // How the sources came back after restarts (restarts.cjs), and when this
  // engine was restarted, if it was.
  let restarts = restartLearning.createRestarts();
  let restartedAt;
  const sourceKey = (state) => state.connection || state.source || 'default';
  // Each gate's state as last observed, which may differ from the one
  // applied while it is held (changeRegime()).
  const gateSeen = new Map();
  const gatePending = new Map();
  // Operating states learned from the data (drivers.cjs).
  let drivers = learnedStates.createDrivers(now);

  /** A gate's own entries, and the paths it has been learned to move. */
  function withLearned(path, prefixes) {
    const learned = learnedStates.affectedBy(drivers, path).filter((item) => !prefixes.some((prefix) => covers(prefix, item)));
    return learned.length > 0 ? [...prefixes, ...learned] : prefixes;
  }

  /**
   * A discrete path that is no named gate changed value. Counted for the
   * learning; and, once paths have been learned to answer it, an operating
   * state of theirs, as a named gate's is.
   */
  function noteStateChange(path, value, t) {
    const learned = learnedStates.affectedBy(drivers, path);
    if (learned.length > 0) {
      // During the start-up too: changeRegime() holds the state it settles
      // on until the start-up is over (settleGates()), and learns from none
      // of the values on the way - a state that changed as the server came
      // back and held is the paths' state from then on.
      changeRegime(path, String(value), learned, learnedStates.settleFor(drivers, path), (state) => `${describePathName(path)} ${state}`, t);
    } else if (t >= options.startupUntil) {
      // Not the values a restart passes through on the way.
      learnedStates.noteTransition(drivers, path, t);
    }
  }

  /** Paths learned to answer `driver` just now: its regime becomes part of theirs. */
  function adoptLearned(driver, t) {
    const named = gatePrefixes.get(driver);
    if (named && !gates.some((gate) => gate.pattern.test(driver)) && driver !== DAYLIGHT_GATE) {
      gatePrefixes.set(driver, learnedStates.affectedBy(drivers, driver));
    } else if (named) {
      gatePrefixes.set(driver, withLearned(driver, named.filter((prefix) => prefix.endsWith('.'))));
    } else {
      gatePrefixes.set(driver, learnedStates.affectedBy(drivers, driver));
    }
    if (!gateRegimes.has(driver)) {
      const source = paths.get(driver);
      const value = source && source.lastValue !== undefined ? source.lastValue : undefined;
      if (value !== undefined) gateRegimes.set(driver, String(value));
    }
    for (const path of learnedStates.affectedBy(drivers, driver)) {
      const state = paths.get(path);
      if (state) state.regimeKey = regimeKeyFor(path);
    }
  }
  const counters = { findingsOpened: 0, incidentsOpened: 0, byDetector: {} };

  // Mutes with their end, to tell at ingest whether a sample arrived muted.
  let muteWindows = [];
  function compileMutes(t) {
    mutes = mutes.filter((mute) => mute.until > t);
    const matchers = mutes.map((mute) => compileGlob(mute.path));
    muteWindows = mutes.map((mute, index) => ({ until: mute.until, match: matchers[index] }));
    mutesCompiled = (path) => path !== undefined && matchers.some((match) => match(path));
  }
  const mutedAt = (path, t) => muteWindows.some((window) => window.until > t && window.match(path));

  // Gate path -> the prefixes it affects, so each path's operating state can be
  // named: "propulsion.main.revolutions=running;navigation.state=motoring".
  const gatePrefixes = new Map();

  function regimeKeyFor(path) {
    const parts = [];
    for (const [gatePath, prefixes] of gatePrefixes) {
      if (prefixes.some((prefix) => covers(prefix, path)) && gateRegimes.has(gatePath)) {
        parts.push(`${gatePath}=${gateRegimes.get(gatePath)}`);
      }
    }
    return parts.sort().join(';');
  }

  /**
   * An operating-state change. Every affected path files its settled baseline
   * under the state it is leaving, and re-learns through the transition. If it
   * has been in the new state before, the baseline it learned there is
   * restored once the transition settles - so the second engine start is
   * judged against how this engine normally runs, not against whatever it did
   * while warming up. Without that, a re-learn after every start would quietly
   * accept "running 10 °C hotter than usual" as the new normal.
   */
  function isGatePath(path) {
    return gates.some((gate) => gate.pattern.test(path));
  }

  function applyGates(path, value, t) {
    for (const gate of gates) {
      const match = gate.pattern.exec(path);
      if (!match) continue;
      const regime = gate.regime(value);
      if (regime === undefined) continue;
      changeRegime(path, regime, withLearned(path, gate.affects(match)), gate.settleMs, (state) => gate.label(match, state), t, gate.restoreInto);
    }
  }

  /**
   * A gate's state, as observed. Applied at once, unless the watch is
   * starting up or the gate is flapping: then it waits (settleGates()).
   */
  function changeRegime(path, regime, prefixes, settleMs, labelFor, t, restoreInto) {
    gatePrefixes.set(path, prefixes);
    let seen = gateSeen.get(path);
    if (!seen) {
      seen = { regime, since: t, changes: [] };
      gateSeen.set(path, seen);
    } else if (seen.regime !== regime) {
      seen.regime = regime;
      seen.since = t;
      seen.changes.push(t);
      // A change the paths it moves may answer (learnedStates); not the
      // values a restart passes through on the way.
      if (t >= options.startupUntil) learnedStates.noteTransition(drivers, path, t);
    }
    seen.changes = seen.changes.filter((at) => at > t - HOUR && at <= t);
    const hold = gateHeld(path, t);
    if (hold) {
      gatePending.set(path, { prefixes, settleMs, labelFor, restoreInto });
      return;
    }
    gatePending.delete(path);
    applyRegime(path, regime, prefixes, settleMs, labelFor(regime), t, restoreInto);
  }

  /** Whether a gate's observed state has to wait before it is applied. */
  function gateHeld(path, t) {
    if (!gateRegimes.has(path)) return false;
    if (t < options.startupUntil) return true;
    const seen = gateSeen.get(path);
    return Boolean(seen) && seen.changes.length > GATE_FLAP_CHANGES && t - seen.since < GATE_FLAP_HOLD_MS;
  }

  /** Apply the gates that waited, once start-up is over or they have held a state long enough. */
  function settleGates(t) {
    for (const [path, pending] of gatePending) {
      const seen = gateSeen.get(path);
      if (seen) seen.changes = seen.changes.filter((at) => at > t - HOUR && at <= t);
      if (!seen || gateHeld(path, t)) continue;
      gatePending.delete(path);
      applyRegime(path, seen.regime, pending.prefixes, pending.settleMs, pending.labelFor(seen.regime), t, pending.restoreInto);
    }
  }

  function applyRegime(path, regime, prefixes, settleMs, label, t, restoreInto) {
    const previous = gateRegimes.get(path);
    if (previous === regime) return;
    const affectedStates = [...paths.values()].filter((state) => prefixes.some((prefix) => covers(prefix, state.path)));
    if (previous === undefined) {
      gateRegimes.set(path, regime);
      for (const state of affectedStates) state.regimeKey = regimeKeyFor(state.path);
      return;
    }
    const leaving = new Map(affectedStates.map((state) => [state, regimeKeyFor(state.path)]));
    gateRegimes.set(path, regime);
    // Restored only into an active state, unless the gate says otherwise. A
    // stopped engine's temperatures are a cool-down that takes hours and
    // depends on the weather, so "how it usually is when stopped" is not a
    // baseline to hold it to.
    const restores = typeof restoreInto === 'function' ? restoreInto(regime) : !RESTING_REGIME.test(regime);
    let restored = 0;
    for (const state of affectedStates) {
      monitor.saveRegimeBaseline(state, leaving.get(state), t, options);
      state.regimeKey = regimeKeyFor(state.path);
      // A value held across the change is not a run of either state: the
      // hold starts again at the change.
      monitor.restartHold(state, t);
      if (restores && monitor.planRegimeRestore(state, state.regimeKey)) restored += 1;
      else monitor.planRegimeRestore(state, undefined);
      monitor.beginRelearn(state, t, settleMs);
    }
    regimeChanges.unshift({
      at: t,
      path,
      from: previous,
      to: regime,
      label,
      affected: affectedStates.length,
      restored,
      settleMs
    });
    regimeChanges.splice(MAX_REGIME_CHANGES);
  }

  // When the sun was last worked out (followDaylight()), and from which
  // receiver's fixes.
  let daylightAt;
  let daylightSource;
  let daylightSourceAt;

  /**
   * Day or night at the vessel, from a position fix. From one receiver only,
   * as every operating state is read from one source: a faulty second GPS
   * placing the boat on the other side of the world must not flip day and
   * night (and keep solar paths re-learning). Another receiver takes over
   * only once the one followed has been silent for a while.
   */
  function followDaylight(value, t, source) {
    if (!value || typeof value !== 'object' || !Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) return;
    if (Math.abs(value.latitude) > 90 || Math.abs(value.longitude) > 180) return;
    const key = source || 'default';
    if (daylightSource === undefined || (key !== daylightSource && !(t - daylightSourceAt <= DAYLIGHT.sourceSilenceMs))) {
      daylightSource = key;
    }
    if (key !== daylightSource) return;
    daylightSourceAt = t;
    if (daylightAt !== undefined && t >= daylightAt && t - daylightAt < DAYLIGHT.everyMs) return;
    daylightAt = t;
    const elevation = sunElevationDeg(value.latitude, value.longitude, t);
    const regime = daylightRegime(elevation, gateRegimes.get(DAYLIGHT_GATE));
    changeRegime(DAYLIGHT_GATE, regime, withLearned(DAYLIGHT_GATE, DAYLIGHT.affects), DAYLIGHT.settleMs, (state) => DAYLIGHT.labels[state], t, DAYLIGHT.restoreInto);
    if (regime === 'twilight') {
      // Re-learning for as long as the light is changing, and the settling
      // time after it.
      for (const state of paths.values()) {
        // Extended, not restarted: the baseline keeps what it has learned so far.
        if ((gatePrefixes.get(DAYLIGHT_GATE) || DAYLIGHT.affects).some((prefix) => covers(prefix, state.path))) {
          state.relearnUntil = Math.max(state.relearnUntil, t + DAYLIGHT.settleMs);
        }
      }
    }
  }

  function getState(path, t) {
    let state = paths.get(path);
    if (!state) {
      if (paths.size >= watchConfig.watchMaxPaths) {
        capped += 1;
        return undefined;
      }
      state = monitor.createPathState(path, t);
      // The pattern that lists it (the path itself when listed exactly).
      state.counterOptIn = isCounterPath(path);
      state.counterListing = monitor.counterListingFor(path, state.counterOptIn);
      state.regimeKey = regimeKeyFor(path);
      paths.set(path, state);
      if (typeof onNewPath === 'function') onNewPath(path);
    }
    return state;
  }

  /**
   * One Signal K value. `t` is when it was received (ms since epoch);
   * `source` its `$source`; `connection` the label of the connection or
   * plugin it came in on (`update.source.label`), when the server gave one.
   */
  function ingest(path, value, t, source, connection) {
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('notifications')) {
      return;
    }
    if (isGnssPath(path)) {
      gnssInputs.add(path);
      observeGnss(gnss, path, value, t, source, options);
    }
    if (path === 'navigation.position') followDaylight(value, t, source);
    const gnssInput = isGnssPath(path);
    for (const [leafPath, leafValue] of leaves(path, value)) {
      if (gnssInput) gnssInputs.add(leafPath);
      // A rule's input is always kept, however many other leaves came first;
      // one stored past the cap is remembered, so it goes with its rule.
      if (latest.has(leafPath) || latest.size < MAX_LATEST || ruleInputs.has(leafPath)) {
        if (!latest.has(leafPath) && latest.size >= MAX_LATEST) overflowInputs.add(leafPath);
        // `changes` counts transitions as they arrive, so a "changes" rule
        // sees a value that went false -> true -> false between two ticks,
        // which the latest value alone would hide.
        const previous = latest.get(leafPath);
        const changes = previous
          ? previous.changes + (rules.looseEquals(previous.value, leafValue) ? 0 : 1)
          : 0;
        const entry = { value: leafValue, at: t, changes };
        // Where the value stood at the end of a mute: a "changes" rule
        // starts from here when the mute ends, so changes made in the last
        // seconds of the mute (after its last tick) are not reported.
        entry.mutedTo = mutedAt(leafPath, t) ? { value: leafValue, changes } : previous && previous.mutedTo;
        latest.set(leafPath, entry);
      }
      // Operating states (engine running, charger mode) are read from the
      // path's primary source only: a second source reporting another value
      // would otherwise flip the regime on every sample and keep the paths it
      // gates relearning for good.
      const excludedBy = isExcluded(leafPath);
      if (excludedBy !== undefined) {
        if (!excluded.has(leafPath) && excluded.size < 5000) excluded.set(leafPath, excludedBy);
        if (trackExcludedSources(leafPath, leafValue, t, source)) applyGates(leafPath, leafValue, t);
        continue;
      }
      const state = getState(leafPath, t);
      if (!state) {
        // Past the cap on watched paths: an operating state is still read
        // from its primary source only. Other paths past the cap are not
        // compared across sources - they take no room in the tables kept for
        // excluded paths, and report no disagreement or failover.
        if (isGatePath(leafPath) && trackExcludedSources(leafPath, leafValue, t, source)) applyGates(leafPath, leafValue, t);
        continue;
      }
      if (!state.sources) state.sources = sources.createSourceState();
      const fromPrimary = sources.routeSample(state.sources, source, leafValue, t, {
        intervalMean: state.intervalMean,
        angle: state.angle,
        scaleOf: () => monitor.noiseFloor(state),
        zClear: options.zClear
      });
      if (!fromPrimary) continue;
      applyGates(leafPath, leafValue, t);
      state.source = state.sources.primary === 'default' ? undefined : state.sources.primary;
      // The primary's connection, for the silent feed (feedOf()); kept in the
      // save, so a device that is dead when the plugin restarts is still
      // told apart from its connection's other devices.
      state.connection = typeof connection === 'string' && connection.length > 0 ? connection : undefined;
      const before = state.lastValue;
      const detourFrom = state.restartFrom;
      monitor.observe(state, leafValue, t, options);
      if (restartedAt !== undefined) {
        // How this source comes back after a restart: heard again (a second
        // reading - the first may be the server's cached value), and a state
        // path back where it was (restarts.cjs).
        // A path that reports only now and then is heard again at its own
        // pace, not its source's: it is not judged for silence after a
        // restart either (evaluateDropout()).
        if (!state.reacquireNoted && state.readsSinceRestart >= 2) {
          state.reacquireNoted = true;
          state.reacquiredAt = t;
          if (!(state.intervalMean > options.maxRegularIntervalMs)) {
            restartLearning.note(restarts, sourceKey(state), 'reacquire', t - restartedAt, restartedAt);
          }
        }
        if (detourFrom !== undefined && state.restartFrom === undefined) {
          restartLearning.note(restarts, sourceKey(state), 'detour', t - restartedAt, restartedAt);
        }
      }
      if (state.kind === 'discrete' && before !== undefined && state.lastValue !== before && !isGatePath(leafPath)) {
        noteStateChange(leafPath, state.lastValue, t);
      }
    }
  }

  /** Tracks the sources of a skipped path; whether this sample is from its primary. */
  function trackExcludedSources(path, value, t, sourceName) {
    if (path.startsWith('navigation.position') || path === 'navigation.datetime') return true;
    // A sample with no source is a source of its own ('default', as
    // routeSample keys it), not one that bypasses the choice of primary.
    const source = sourceName || 'default';
    let entry = sourceOnly.get(path);
    if (!entry) {
      const first = firstSource.get(path);
      if (first === undefined) {
        // Operating-state paths keep some room of their own past the cap: an
        // untracked one would take every source's sample, and opposing
        // sources would flip its regime. Past that room too, one is not
        // gated at all rather than gated by any source.
        const gatePath = isGatePath(path);
        if (firstSource.size < (gatePath ? 5000 + 256 : 5000)) {
          firstSource.set(path, { source, value, at: t, n: 1, interval: undefined });
          return true;
        }
        return !gatePath;
      }
      if (first.source === source) {
        if (t > first.at) learnSourceInterval(first, t - first.at);
        first.value = value;
        first.at = t;
        first.n += 1;
        return true;
      }
      if (sourceOnly.size >= 500) return false;
      // The source seen first stays the primary, with what is known of it:
      // how many samples it sent (a failover from a long-established source
      // is news) and how often (a source reporting every 30 s is not quiet
      // 10 s after its last sample).
      entry = {
        path,
        units: undefined,
        angle: isAnglePath(path),
        sources: sources.createSourceState()
      };
      entry.sources.primary = first.source;
      entry.sources.entries[first.source] = { n: first.n, value: first.value, at: first.at, interval: first.interval, longGaps: first.longGaps };
      sourceOnly.set(path, entry);
    }
    // The interval is the primary's own, as a watched path's is: a second
    // source sending every second must not make a primary that sends every
    // 30 s look quiet. Each source's is learned from its own samples, so a
    // new primary is judged by its own interval (none yet: from its next
    // sample), not by the old primary's, nor by the silence that made it
    // fail over.
    const primary = entry.sources.entries[entry.sources.primary];
    return sources.routeSample(entry.sources, source, value, t, {
      intervalMean: primary ? primary.interval : undefined,
      angle: entry.angle,
      scaleOf: () => monitor.noiseFloor(entry),
      zClear: options.zClear,
      learnInterval: learnSourceInterval
    });
  }

  /**
   * One gap of a path's primary source into `holder.interval`, as a watched
   * path's interval learns (path-monitor's learnInterval()): an outage - a gap
   * as long as a dropout - after regular samples is not its interval, or one
   * hour of silence would make a 1 s source's failover wait half an hour;
   * long gaps one after another (a source that slowed down) count, each up
   * to that limit.
   */
  function learnSourceInterval(holder, dt) {
    if (holder.interval === undefined) {
      holder.interval = dt;
      return;
    }
    const limit = Math.max(options.dropoutMinMs, options.dropoutFactor * holder.interval);
    if (dt > limit) {
      if (holder.longGaps > 0) holder.interval += 0.1 * (limit - holder.interval);
      holder.longGaps = (holder.longGaps || 0) + 1;
      return;
    }
    holder.longGaps = 0;
    holder.interval += 0.1 * (dt - holder.interval);
  }

  /** Units, display name and zones from the path's Signal K metadata. */
  function setMeta(path, meta) {
    const state = paths.get(path) || sourceOnly.get(path);
    if (!state || !meta || typeof meta !== 'object') return;
    if (typeof meta.units === 'string') state.units = meta.units;
    if (typeof meta.displayName === 'string') state.displayName = meta.displayName;
    if (Array.isArray(meta.zones)) state.zones = meta.zones.slice(0, 10);
  }

  // ---- incidents -----------------------------------------------------------

  function incidentGroup(finding) {
    return finding.detector.startsWith('gnss.') ? 'gnss' : pathGroup(finding.path);
  }

  function findIncidentFor(finding, t) {
    const group = incidentGroup(finding);
    // Findings join an incident by system (same two-segment prefix, e.g.
    // propulsion.main) while that system still has an open finding in it, or
    // by timing while the incident is forming (INCIDENT_JOIN_GAP_MS,
    // INCIDENT_FORMING_MS). A system whose findings there have all cleared
    // starts afresh: an incident held open for a day by a sensor with no
    // value does not take in that system's next, unrelated departure. GNSS
    // is kept apart in both directions: a spoofed fix and an overheating
    // engine arriving together are a coincidence, and folding one into the
    // other would bury the position warning under an engine title.
    // An incident that resolved this very tick (a feed silence whose paths'
    // dropouts open as it clears) is still the same incident: it reopens,
    // and a finding that cleared in this tick counts as still open.
    const candidates = incidents.filter((incident) => {
      if (incident.status !== 'active' && !(incident.status === 'resolved' && incident.resolvedAt === t)) return false;
      const gnssOnly = incident.groups.length > 0 && incident.groups.every((item) => item === 'gnss');
      if (group === 'gnss') return incident.groups.includes('gnss');
      return !gnssOnly;
    });
    if (group === 'gnss') return candidates[0];
    // The system's own incident first: a coincidence in timing with a newer
    // incident does not pull a finding away from the one its system is in.
    const bySystem = candidates.find((incident) =>
      incident.findings.some((entry) => (entry.clearedAt === undefined || entry.clearedAt === t) && incidentGroup(entry) === group)
    );
    if (bySystem) return bySystem;
    return candidates.find((incident) => {
      const joinedAt = Number.isFinite(incident.joinedAt) ? incident.joinedAt : incident.openedAt;
      // The forming cap is for an active incident; one that resolved this
      // tick reopens on the join gap alone, as above.
      return t - joinedAt <= INCIDENT_JOIN_GAP_MS && (incident.status === 'resolved' || t - incident.openedAt <= INCIDENT_FORMING_MS);
    });
  }

  function refreshIncident(incident) {
    const entries = incident.findings;
    const same = (ref) => (entry) => ref && entry.key === ref.key && entry.openedAt === ref.openedAt;
    const open = entries.filter((entry) => entry.clearedAt === undefined);
    // The worst it reached, kept for the report and for once it resolves.
    // (Saves from before this field kept that running worst as severity.)
    incident.peakSeverity = entries.reduce(
      (worst, entry) => (SEVERITY_RANK[entry.severity] > SEVERITY_RANK[worst] ? entry.severity : worst),
      incident.peakSeverity || incident.severity || 'warn'
    );
    let name;
    if (incident.status === 'active' && open.length > 0) {
      // Named by what is still wrong: the finding that reopened it (a silent
      // feed that cleared into its paths' dropouts is no longer "data
      // stopped arriving") while that is open, else the earliest open one.
      // Its severity is the worst still open: an incident whose alert
      // cleared hours ago and is left with a warning is a warning.
      name = open.find(same(incident.lead)) || open[0];
      incident.namedBy = { key: name.key, openedAt: name.openedAt };
      incident.severity = open.reduce(
        (worst, entry) => (SEVERITY_RANK[entry.severity] > SEVERITY_RANK[worst] ? entry.severity : worst),
        'warn'
      );
    } else {
      // Resolved: it keeps the name it had last, and is remembered at the
      // worst it reached.
      name = entries.find(same(incident.namedBy)) || entries.find(same(incident.lead)) || entries[0];
      incident.severity = incident.peakSeverity;
    }
    // Findings dropped to keep the incident bounded still happened: they
    // count towards "related", so the title does not shrink as it compacts.
    const related = entries.length - 1 + (incident.omitted || 0);
    incident.title = related > 0 ? `${name.title} (+${related} related)` : name.title;
  }

  function attach(finding, t) {
    const group = incidentGroup(finding);
    let incident = findIncidentFor(finding, t);
    if (!incident) {
      incidentCounter += 1;
      counters.incidentsOpened += 1;
      incident = {
        id: `inc-${t.toString(36)}-${incidentCounter}`,
        status: 'active',
        openedAt: t,
        updatedAt: t,
        joinedAt: t,
        resolvedAt: undefined,
        severity: finding.severity,
        peakSeverity: finding.severity,
        groups: [],
        findings: [],
        omitted: 0,
        title: ''
      };
      incidents.unshift(incident);
      incidents = incidents.slice(0, MAX_INCIDENTS);
    }
    if (incident.status !== 'active') {
      incident.status = 'active';
      incident.resolvedAt = undefined;
      // Reopened in the tick it resolved: what is happening now names it.
      incident.lead = { key: finding.key, openedAt: finding.openedAt };
    }
    if (!incident.groups.includes(group)) incident.groups.push(group);
    incident.findings.push(snapshot(finding));
    while (incident.findings.length > MAX_INCIDENT_FINDINGS) {
      const oldestCleared = incident.findings.findIndex((entry, index) => index > 0 && entry.clearedAt !== undefined);
      if (oldestCleared < 0) break;
      incident.findings.splice(oldestCleared, 1);
      incident.omitted = (incident.omitted || 0) + 1;
    }
    incident.updatedAt = t;
    // Timing is by when findings *joined*, not by when the incident last
    // changed: open findings refresh their text on every tick, and keying on
    // that would make one long incident swallow everything after it.
    incident.joinedAt = t;
    finding.incidentId = incident.id;
    refreshIncident(incident);
  }

  function snapshot(finding) {
    return {
      key: finding.key,
      detector: finding.detector,
      path: finding.path,
      severity: finding.severity,
      title: finding.title,
      message: finding.message,
      openedAt: finding.openedAt,
      clearedAt: finding.clearedAt
    };
  }

  function updateIncidentEntry(finding, t) {
    const incident = incidents.find((item) => item.id === finding.incidentId);
    if (!incident) return;
    const entry = incident.findings.find((item) => item.key === finding.key && item.openedAt === finding.openedAt);
    if (entry) Object.assign(entry, snapshot(finding));
    incident.updatedAt = t;
    if (incident.findings.every((item) => item.clearedAt !== undefined)) {
      incident.status = 'resolved';
      incident.resolvedAt = t;
    }
    refreshIncident(incident);
  }

  // ---- condition tracking --------------------------------------------------

  /**
   * Feed one condition through persistence and hysteresis. `cond` is
   * `{ active, severity, evidence, message? }`, or null when the detector has
   * no opinion (still learning, muted, not applicable) - which counts as
   * inactive, so a finding whose path goes into re-learning still clears.
   */
  function applyCondition(key, detector, info, cond, t, timingOverride) {
    const timing = timingOverride || TIMING[detector] || { persistMs: 0, clearMs: 0 };
    const tracker = trackers.get(key) || {};
    const open = findings.get(key);
    const active = Boolean(cond && cond.active);

    // While the watch starts up, links reconnect and plugins announce their
    // values again: a departure then (a link's round-trip time while it
    // reconnects) waits until start-up is over, and is reported if it is
    // still there. A finding carried over the restart resumes at once, and
    // the operator's own watches are never held.
    const own = info && paths.get(info.path);
    const startupUntil = own && Number.isFinite(own.startupUntil) && !String(key).startsWith('gnss') ? own.startupUntil : options.startupUntil;
    const holding = active && !open && t < startupUntil && detector !== 'rule' && !carried.has(key);
    if (holding) {
      tracker.pendingSince = undefined;
    } else if (active) {
      tracker.clearSince = undefined;
      if (!open) {
        tracker.pendingSince = tracker.pendingSince === undefined ? t : tracker.pendingSince;
        if (t - tracker.pendingSince >= timing.persistMs && resumeCarried(key, detector, info, cond, t, tracker.pendingSince)) {
          tracker.pendingSince = undefined;
        } else if (t - tracker.pendingSince >= timing.persistMs) {
          const text = narrate(detector, info, cond.evidence, cond);
          const finding = {
            key,
            detector,
            path: info.path,
            notifyKey: info.notifyKey,
            severity: cond.severity,
            openedAt: t,
            updatedAt: t,
            clearedAt: undefined,
            title: text.title,
            message: text.message,
            evidence: cond.evidence
          };
          findings.set(key, finding);
          counters.findingsOpened += 1;
          counters.byDetector[detector] = (counters.byDetector[detector] || 0) + 1;
          attach(finding, t);
          tracker.pendingSince = undefined;
        }
      } else {
        const text = narrate(detector, info, cond.evidence, cond);
        // Severity escalates while a finding is open but does not fall back:
        // an alert that eased to a warning is still the alert it was.
        if (SEVERITY_RANK[cond.severity] > SEVERITY_RANK[open.severity]) open.severity = cond.severity;
        open.title = text.title;
        open.message = text.message;
        open.evidence = cond.evidence;
        open.updatedAt = t;
        updateIncidentEntry(open, t);
      }
    } else {
      tracker.pendingSince = undefined;
      if (open) {
        tracker.clearSince = tracker.clearSince === undefined ? t : tracker.clearSince;
        if (t - tracker.clearSince >= timing.clearMs) {
          open.clearedAt = t;
          findingLog.push({
            detector: open.detector,
            path: open.path,
            severity: open.severity,
            title: open.title,
            openedAt: open.openedAt,
            clearedAt: t
          });
          if (findingLog.length > MAX_FINDING_LOG) findingLog = findingLog.slice(-MAX_FINDING_LOG);
          findings.delete(key);
          updateIncidentEntry(open, t);
          tracker.clearSince = undefined;
        }
      }
    }
    if (tracker.pendingSince === undefined && tracker.clearSince === undefined && !findings.has(key)) {
      trackers.delete(key);
    } else {
      trackers.set(key, tracker);
    }
  }

  /**
   * A finding that was open when the watch stopped, back within a few
   * minutes of the restart: it carries on as the finding it was - opened
   * when it first opened, in its incident, counted once - rather than as a
   * new one. Its notification is raised again: the server's went with it.
   */
  function resumeCarried(key, detector, info, cond, t, activeSince) {
    const before = carried.get(key);
    // Back in time is when its condition was first active again: one that
    // came back before the deadline and needed its persistence after it is
    // still the same finding.
    if (!before || activeSince > carryUntil) return false;
    carried.delete(key);
    const incident = incidents.find((item) => item.id === before.incidentId);
    if (!incident) return false;
    const text = narrate(detector, info, cond.evidence, cond);
    const finding = {
      key,
      detector,
      path: info.path,
      notifyKey: info.notifyKey,
      severity: SEVERITY_RANK[before.severity] > SEVERITY_RANK[cond.severity] ? before.severity : cond.severity,
      openedAt: before.openedAt,
      updatedAt: t,
      clearedAt: undefined,
      title: text.title,
      message: text.message,
      evidence: cond.evidence,
      incidentId: incident.id
    };
    findings.set(key, finding);
    updateIncidentEntry(finding, t);
    return true;
  }

  /** Findings that did not come back after the restart are closed as of it, and their incidents with them. */
  function expireCarried(t) {
    if (carried.size === 0 || t <= carryUntil) return;
    const at = restartedAt !== undefined ? restartedAt : carryUntil;
    for (const [key, before] of [...carried]) {
      // Back before the deadline and still waiting out its persistence:
      // resumeCarried() decides it.
      const tracker = trackers.get(key);
      if (tracker && tracker.pendingSince !== undefined && tracker.pendingSince <= carryUntil) continue;
      carried.delete(key);
      const incident = incidents.find((item) => item.id === before.incidentId);
      if (!incident) continue;
      const entry = incident.findings.find((item) => item.key === key && item.openedAt === before.openedAt);
      if (entry && entry.clearedAt === undefined) {
        entry.clearedAt = at;
        logClosed(entry, at);
      }
      if (incident.status === 'active' && incident.findings.every((item) => item.clearedAt !== undefined)) {
        incident.status = 'resolved';
        incident.resolvedAt = at;
        incident.interrupted = true;
      }
      refreshIncident(incident);
    }
  }

  /** A finding that closed, into the log the report reads. */
  function logClosed(entry, clearedAt) {
    findingLog.push({
      detector: entry.detector,
      path: entry.path,
      severity: entry.severity,
      title: entry.title,
      openedAt: entry.openedAt,
      clearedAt
    });
    if (findingLog.length > MAX_FINDING_LOG) findingLog = findingLog.slice(-MAX_FINDING_LOG);
  }

  function pathInfo(state) {
    return {
      path: state.path,
      units: state.units,
      displayName: state.displayName,
      notifyKey: state.path
    };
  }

  /** Run every time-based check. Call every few seconds. */
  function tick(t) {
    lastTick = t;
    compileMutes(t);
    settleGates(t);
    expireCarried(t);

    // Feed-wide silence first: when half the vessel goes quiet at once that is
    // one fact (a gateway or the server's input died), not forty dropouts -
    // as long as the paths went quiet together and nothing else on their
    // connection still reports (feedSilence()). Muted paths are left out of
    // it: a feed made silent only by paths the operator muted is not
    // reported.
    const dropouts = new Map();
    const watched = [];
    for (const state of paths.values()) {
      const cond = monitor.evaluateDropout(state, t, options);
      if (!cond) continue;
      dropouts.set(state.path, cond);
      watched.push([state, cond, Boolean(mutesCompiled(state.path))]);
    }
    const feedMuted = mutesCompiled('feed');
    // Whether the feed went silent is decided over every path; it is
    // reported unless the silence is only the muted paths': at least half of
    // the unmuted regular paths are silent too (a gateway that died takes
    // muted and unmuted paths alike). Dropouts fold into the feed while it is
    // reported, and while a muted feed is silent: muting the one fact does
    // not unleash forty. While a connection in it is undecided (a slower
    // path on it is not overdue yet), its silent paths are neither, and
    // while the feed depends on it, the feed is left as it is.
    const silence = feedSilence(watched, feedMembers, { feedMuted, now: t });
    const { regularAll, silentAll, sources: silentSources, members, held, holding, reportable } = silence;
    // The paths whose dropouts fold into the feed: while it is held, those
    // of a feed already reported stay folded.
    const folded = holding ? feedMembers : silence.feedSilent ? members : new Set();
    if (!holding) {
      feedMembers = folded;
      applyCondition(
        'feed',
        'feed',
        { path: 'feed', notifyKey: 'dataFeed' },
        // A muted feed finding clears like any muted one.
        regularAll >= 4 && !feedMuted
          ? { active: reportable, severity: 'alert', evidence: { silent: silentAll, regular: regularAll, sources: silentSources } }
          : null,
        t
      );
    }

    for (const state of paths.values()) {
      monitor.applyPendingRestore(state, t);
      const wasDeparting = monitor.departing(state);
      monitor.learnFromTick(state, t, options);
      if (Number.isFinite(state.startupSettledAt)) {
        // The restart's own departure of this path is over: how long it
        // takes to settle once heard again (restarts.cjs).
        if (restartedAt !== undefined) {
          state.restartSettles = restartLearning.noteSettle(state.restartSettles, state.startupSettledAt - (Number.isFinite(state.reacquiredAt) ? state.reacquiredAt : restartedAt));
        }
        state.startupSettledAt = undefined;
      }
      const departing = monitor.departing(state);
      if (departing && !wasDeparting) {
        // A departure began: counted against the changes just before it.
        const { credited, learnedNow } = learnedStates.noteOnset(drivers, state.path, t);
        state.departureDrivers = credited.length > 0 ? credited : undefined;
        state.departureSince = t;
        for (const driver of learnedNow) adoptLearned(driver, t);
      } else if (!departing && wasDeparting) {
        learnedStates.noteEpisodeEnd(drivers, state.path, state.departureDrivers, t - (state.departureSince || t));
        state.departureDrivers = undefined;
      }
      const muted = mutesCompiled(state.path);
      const info = pathInfo(state);
      const factor = sensitivityFactor(state.path, t);
      const pathOptions = factor === 1 ? options : { ...options, zWarn: options.zWarn * factor, zAlert: options.zAlert * factor };
      const dropout = dropouts.get(state.path) || null;
      // A dismissed dropout needs a proportionally longer silence.
      const dropoutCond =
        dropout && factor > 1 ? { ...dropout, active: dropout.active && dropout.evidence.silentFor > factor * dropout.evidence.limit } : dropout;
      const checks = [
        ['shift', muted ? null : monitor.evaluateShift(state, t, pathOptions, findings.has(`shift:${state.path}`))],
        [
          'dropout',
          // A held path's dropout is not reported yet; one already open stays.
          muted || folded.has(state.path) || (held.has(state.path) && !findings.has(`dropout:${state.path}`)) ? null : dropoutCond
        ],
        ['frozen', muted ? null : monitor.evaluateFrozen(state, t, options)],
        ['newState', muted ? null : monitor.evaluateNewState(state, t, options)],
        ['cycling', muted ? null : monitor.evaluateCycling(state, t, options, findings.has(`cycling:${state.path}`))],
        ['rate', muted ? null : monitor.evaluateRate(state, t, options)],
        ['forecast', muted ? null : monitor.evaluateForecast(state, t, options)],
        ['disagree', muted || !state.sources ? null : sources.evaluateDisagree(state.sources, t, {
          ...pathOptions,
          scale: monitor.noiseFloor(state),
          isOpen: findings.has(`disagree:${state.path}`)
        })],
        ['failover', muted || !state.sources ? null : sources.evaluateFailover(state.sources, t, options.eventHoldMs)]
      ];
      for (const [detector, cond] of checks) {
        const key = `${detector}:${state.path}`;
        if (cond === null && !findings.has(key) && !trackers.has(key)) continue;
        applyCondition(key, detector, info, cond, t);
      }
    }

    for (const entry of sourceOnly.values()) {
      const muted = mutesCompiled(entry.path);
      const info = { path: entry.path, units: entry.units, displayName: entry.displayName, notifyKey: entry.path };
      const checks = [
        ['disagree', muted ? null : sources.evaluateDisagree(entry.sources, t, {
          ...options,
          // The same feedback factor as a watched path: "Not useful" on two
          // disagreeing compasses has to raise their threshold too.
          zWarn: options.zWarn * sensitivityFactor(entry.path, t),
          zAlert: options.zAlert * sensitivityFactor(entry.path, t),
          scale: monitor.noiseFloor(entry),
          isOpen: findings.has(`disagree:${entry.path}`)
        })],
        ['failover', muted ? null : sources.evaluateFailover(entry.sources, t, options.eventHoldMs)]
      ];
      for (const [detector, cond] of checks) {
        const key = `${detector}:${entry.path}`;
        if (cond === null && !findings.has(key) && !trackers.has(key)) continue;
        applyCondition(key, detector, info, cond, t);
      }
    }

    for (const rule of activeRules) {
      let memory = ruleMemory.get(rule.id);
      if (!memory) {
        // A mute that ended before the rule existed (or before an edit moved
        // it here) is not one it has to start after.
        const current = latest.get(rule.path);
        memory = { mutedApplied: current && current.mutedTo };
        ruleMemory.set(rule.id, memory);
      }
      const ruleMuted = mutesCompiled(rule.path);
      if (ruleMuted && rule.op === 'changes') {
        // Changes while muted were not wanted: follow the value, so the
        // first tick after the mute does not report what happened during it.
        const current = latest.get(rule.path);
        if (current) {
          memory.last = current.value;
          memory.seen = current.changes;
        }
        memory.changedAt = undefined;
        memory.pausedAt = undefined;
        const muted = current && current.mutedTo;
        if (muted) memory.mutedApplied = muted;
      } else if (rule.op === 'changes') {
        // After a mute - even one that began and ended between two ticks -
        // start from the last value that arrived muted, once: changes made
        // while muted are not reported, changes after it are.
        const current = latest.get(rule.path);
        const muted = current && current.mutedTo;
        if (muted && memory.mutedApplied !== muted) {
          memory.mutedApplied = muted;
          memory.last = muted.value;
          memory.seen = muted.changes;
        }
      }
      const cond = ruleMuted ? null : rules.evaluateRule(rule, (path) => latest.get(path), t, memory);
      const state = paths.get(rule.path);
      applyCondition(
        `rule:${rule.id}`,
        'rule',
        {
          path: rule.path,
          units: state && state.units,
          displayName: state && state.displayName,
          notifyKey: `rules.${rule.id}`,
          infoFor
        },
        cond,
        t,
        { persistMs: Math.max(TIMING.rule.persistMs, rule.forSeconds * 1000), clearMs: TIMING.rule.clearMs }
      );
      // A change counts as reported once its finding exists - not when it was
      // first seen, or a guard going stale before the finding opened would
      // lose it for good.
      if (rule.op === 'changes' && memory.changedAt !== undefined && findings.has(`rule:${rule.id}`)) {
        memory.reported = memory.changedAt;
      }
    }

    const gnssMuted = mutesCompiled('navigation.position');
    const indicators = evaluateGnss(gnss, t, options);
    const activeIndicators = Object.values(indicators).filter((cond) => cond && cond.active).length;
    for (const [name, cond] of Object.entries(indicators)) {
      const key = `gnss.${name}`;
      if (cond === null && !findings.has(key) && !trackers.has(key)) continue;
      // Two independent indicators at once is corroboration: an alert, not a
      // warning, whichever two they are.
      const escalated = cond && cond.active && activeIndicators >= 2 ? { ...cond, severity: 'alert' } : cond;
      applyCondition(key, key, { path: 'navigation.position', notifyKey: 'gnss' }, gnssMuted ? null : escalated, t);
    }
  }

  // ---- inventory -----------------------------------------------------------

  function roleOf(state, t) {
    if (t < state.relearnUntil) return 'relearning';
    return monitor.isReady(state, t, options) ? 'watching' : 'learning';
  }

  /**
   * Everything the watch has discovered on this vessel, and what that makes
   * possible. Nothing here is configured per boat: paths are found as they
   * are published, classified from their own values and metadata, and each
   * check reports whether this vessel's data is enough to run it.
   */
  function inventory(t = lastTick) {
    const branches = new Map();
    const branchOf = (path) => {
      const name = path.split('.')[0];
      if (!branches.has(name)) branches.set(name, { branch: name, watched: 0, excluded: 0 });
      return branches.get(name);
    };
    const rows = [];
    let withMeta = 0;
    let multiSource = 0;
    let zoned = 0;
    let depletion = 0;
    for (const state of paths.values()) {
      branchOf(state.path).watched += 1;
      if (state.units) withMeta += 1;
      if (Array.isArray(state.zones) && state.zones.length > 0) zoned += 1;
      if (monitor.hasDepletionTarget(state.path)) depletion += 1;
      const sourceList = sources.sourceSummary(state.sources, t) || [];
      if (sourceList.length > 1) multiSource += 1;
      rows.push({
        path: state.path,
        role: roleOf(state, t),
        kind: monitor.isCounterState(state) ? 'counter' : state.kind,
        ...(state.counterOptIn ? { counterBy: state.counterOptIn } : {}),
        units: state.units,
        displayName: state.displayName,
        intervalMs: state.intervalMean === undefined ? undefined : Math.round(state.intervalMean),
        samples: state.n,
        sources: sourceList,
        ...(sensitivityFactor(state.path, t) > 1 ? { lessSensitive: sensitivityFactor(state.path, t) } : {})
      });
    }
    for (const [path, pattern] of excluded) {
      branchOf(path).excluded += 1;
      const entry = sourceOnly.get(path);
      const sourceList = entry ? sources.sourceSummary(entry.sources, t) : undefined;
      if (sourceList && sourceList.length > 1) multiSource += 1;
      rows.push({
        path,
        role: gnssInputs.has(path) ? 'gnss-input' : 'skipped',
        excludedBy: pattern,
        ...(sourceList ? { sources: sourceList } : {})
      });
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));

    const gatesSeen = [...gateRegimes.entries()].map(([path, regime]) => `${path} (${regime})`);
    const positionSources = Object.keys(gnss.fixes).length;
    const hasHeading = gnss.heading !== undefined || (gnss.headingMagnetic !== undefined && gnss.variation !== undefined);
    const hasLog = gnss.stw !== undefined;
    const drMissing = [
      positionSources > 0 ? undefined : 'navigation.position',
      hasHeading ? undefined : 'navigation.headingTrue (or headingMagnetic with magneticVariation)',
      hasLog ? undefined : 'navigation.speedThroughWater'
    ].filter(Boolean);
    const capabilities = [
      {
        id: 'baselines',
        label: 'Learned baselines',
        available: paths.size > 0,
        detail: `${paths.size} paths watched; ${withMeta} with units from their own metadata, the rest from Signal K naming`
      },
      {
        id: 'gnss-position',
        label: 'GNSS position checks (jumps, frozen fix)',
        available: positionSources > 0,
        detail: positionSources > 0 ? `${positionSources} position source${positionSources === 1 ? '' : 's'}` : 'needs navigation.position'
      },
      {
        id: 'gnss-dead-reckoning',
        label: 'Dead reckoning cross-check',
        available: drMissing.length === 0,
        detail: drMissing.length === 0 ? 'heading and speed through water available' : `needs ${drMissing.join(', ')}`
      },
      {
        id: 'gnss-receivers',
        label: 'Second GNSS receiver comparison',
        available: positionSources >= 2,
        detail: positionSources >= 2 ? `${positionSources} receivers` : 'needs a second source publishing navigation.position'
      },
      {
        id: 'gnss-quality',
        label: 'Satellite and dilution checks',
        available: gnss.satellites !== undefined || gnss.hdop !== undefined,
        detail:
          gnss.satellites !== undefined || gnss.hdop !== undefined
            ? [gnss.satellites !== undefined ? 'satellite count' : undefined, gnss.hdop !== undefined ? 'dilution' : undefined]
                .filter(Boolean)
                .join(' and ') + ' available'
            : 'needs navigation.gnss.satellites or navigation.gnss.horizontalDilution'
      },
      {
        id: 'gnss-clock',
        label: 'GNSS clock check',
        available: gnss.clockSamples > 0,
        detail: gnss.clockSamples > 0 ? 'navigation.datetime available' : 'needs navigation.datetime'
      },
      {
        id: 'regimes',
        label: 'Operating-state awareness',
        available: gatesSeen.length > 0,
        detail: gatesSeen.length > 0 ? gatesSeen.slice(0, 6).join(', ') : 'needs propulsion.*.revolutions or .state, a charger or inverter mode, or navigation.state'
      },
      {
        id: 'redundancy',
        label: 'Redundant sensors compared',
        available: multiSource > 0,
        detail: multiSource > 0 ? `${multiSource} path${multiSource === 1 ? '' : 's'} with more than one source` : 'no path has more than one source'
      },
      {
        id: 'forecasts',
        label: 'Trend forecasts',
        available: depletion + zoned > 0,
        detail: depletion + zoned > 0
          ? `${depletion} tank or battery level${depletion === 1 ? '' : 's'}, ${zoned} path${zoned === 1 ? '' : 's'} with zones`
          : 'needs tanks.*.*.currentLevel, a battery stateOfCharge, or meta.zones on a path'
      }
    ];

    return {
      totals: {
        seen: paths.size + excluded.size,
        watched: paths.size,
        skipped: excluded.size,
        capped,
        gnssInputs: gnssInputs.size,
        multiSource
      },
      branches: [...branches.values()].sort((a, b) => a.branch.localeCompare(b.branch)),
      capabilities,
      paths: rows.slice(0, 3000),
      ...(rows.length > 3000 ? { truncated: rows.length - 3000 } : {}),
      // Operating states learned from the data: which changes which paths answer.
      learnedStates: learnedStates.summary(drivers),
      // How each source came back after restarts.
      restarts: restartLearning.summary(restarts)
    };
  }

  /**
   * The paths furthest from their own normal right now, alarming or not.
   *
   * The answer to "something feels off": every continuous path ranked by how
   * many of its own normal variations it sits from its baseline for the
   * current operating state, plus discrete paths sitting in a state they are
   * rarely in. Nothing has to cross a threshold to appear here.
   */
  function unusual(t = lastTick, limit = 10) {
    const rows = [];
    for (const state of paths.values()) {
      if (!monitor.isReady(state, t, options) || mutesCompiled(state.path)) continue;
      if (state.kind === 'continuous' && !monitor.isCounterState(state)) {
        const cond = monitor.evaluateShift(state, t, options, false);
        if (!cond) continue;
        // Ranked by how far it is from where its average usually strays.
        const z = Number.isFinite(cond.evidence.departure) ? cond.evidence.departure : cond.evidence.z;
        if (!Number.isFinite(z) || Math.abs(z) < 1.5) continue;
        const text = narrate('shift', pathInfo(state), cond.evidence);
        rows.push({ path: state.path, score: Math.abs(z), title: text.title.replace(/unusually/, Math.abs(z) >= options.zWarn ? 'unusually' : 'somewhat'), message: text.message, regime: regimeKeyFor(state.path) || undefined });
      } else if (state.kind === 'discrete' && state.lastValue !== undefined) {
        const total = Object.values(state.seen).reduce((sum, count) => sum + count, 0);
        const share = total > 0 ? (state.seen[state.lastValue] || 0) / total : 1;
        if (total < 100 || share >= 0.05) continue;
        // Rarity on the same rough scale as the z-scores: 5% -> 1.6, 1% -> 2.3, 0.1% -> 3.
        const score = -Math.log10(share) + 0.3;
        const info = pathInfo(state);
        rows.push({
          path: state.path,
          score,
          title: `${narrate('newState', info, { value: state.lastValue }).title.replace('changed to', 'is')}`,
          message: `In this state ${(share * 100).toFixed(share < 0.01 ? 2 : 1)} % of the time it has been watched`
        });
      }
    }
    rows.sort((a, b) => b.score - a.score);
    return { at: t, rows: rows.slice(0, limit).map((row) => ({ ...row, score: Number(row.score.toFixed(1)) })) };
  }

  // ---- operator rules --------------------------------------------------------

  function infoFor(path) {
    const state = paths.get(path) || sourceOnly.get(path);
    return state ? { units: state.units, displayName: state.displayName } : undefined;
  }

  /**
   * A value this path has carried, for judging whether it has states: the
   * latest one, or - after a restart, before it publishes again - a word
   * standing for the states its saved baseline learned. A flag rule is not
   * refused for a measurement-like name just because the flag is quiet.
   */
  function seenValueFor(path) {
    const current = latest.get(path);
    if (current && current.value !== null && current.value !== undefined) return current.value;
    const state = paths.get(path);
    // Discrete from words or flags (no numeric values kept) has states; a
    // numeric discrete path (0 rpm, a pump code) stands for a number.
    if (!state || state.kind !== 'discrete') return undefined;
    return state.distinct === null ? '' : 0;
  }

  function valueTypeOf(value) {
    if (value === null || value === undefined) return undefined;
    return typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : typeof value === 'string' ? 'string' : 'object';
  }

  /** Every path a rule could be about, with what is known of it. */
  function knownPaths(t = lastTick) {
    const out = [];
    for (const path of latest.keys()) {
      if (path.startsWith('navigation.position.')) continue;
      const state = paths.get(path);
      const info = infoFor(path) || {};
      out.push({
        path,
        units: info.units,
        displayName: info.displayName,
        // What the data is, so a rule on a path that carries words or flags
        // is not refused for a measurement-like name.
        valueType: valueTypeOf(seenValueFor(path)),
        role: state ? roleOf(state, t) : gnssInputs.has(path) ? 'gnss-input' : 'skipped'
      });
    }
    return out;
  }

  function setRules(list) {
    const previous = new Map(activeRules.map((rule) => [rule.id, rule]));
    activeRules = rules.normalizeRules(list);
    ruleInputs = new Set(activeRules.flatMap((rule) => [rule.path, rule.when && rule.when.path].filter(Boolean)));
    for (const path of [...overflowInputs]) {
      if (!ruleInputs.has(path)) {
        overflowInputs.delete(path);
        latest.delete(path);
      }
    }
    const ids = new Set(activeRules.map((rule) => rule.id));
    for (const id of [...ruleMemory.keys()]) {
      if (!ids.has(id)) ruleMemory.delete(id);
    }
    // An edit under the same id that moves the rule to another path, or
    // changes what it compares, starts from nothing: the old path's change
    // count says nothing about the new one.
    for (const rule of activeRules) {
      const before = previous.get(rule.id);
      // Its pending duration goes too: the new path must hold for the full
      // duration itself.
      if (!before) continue;
      const movedOrReworded = before.path !== rule.path || before.op !== rule.op;
      // A new threshold or guard is a new condition too: the time the old
      // one held says nothing about it (12.5 V held "above 12" for 55 s, not
      // "above 13.5").
      const conditionChanged =
        movedOrReworded || JSON.stringify(before.value) !== JSON.stringify(rule.value) || JSON.stringify(before.when) !== JSON.stringify(rule.when);
      if (conditionChanged) {
        // The change count only belongs to the path and operator it counted.
        if (movedOrReworded) ruleMemory.delete(rule.id);
        else {
          // A change already reported stays reported: the closing finding
          // below must not open again for it under the edited guard.
          const memory = ruleMemory.get(rule.id);
          if (memory && memory.reported !== undefined && memory.reported === memory.changedAt) memory.changedAt = undefined;
        }
        // A finding it had open was about the old condition: it closes, and
        // the new one opens its own once it has held for the duration.
        const key = `rule:${rule.id}`;
        const open = findings.get(key);
        if (open) applyCondition(key, 'rule', { path: open.path, notifyKey: open.notifyKey }, null, lastTick, { persistMs: 0, clearMs: 0 });
        trackers.delete(key);
      }
    }
    // Findings of rules that no longer exist clear now, through the ordinary
    // path (no condition means inactive), which also drops their trackers.
    for (const key of [...findings.keys()]) {
      if (key.startsWith('rule:') && !ids.has(key.slice(5))) {
        applyCondition(key, 'rule', { path: findings.get(key).path, notifyKey: findings.get(key).notifyKey }, null, lastTick, { persistMs: 0, clearMs: 0 });
      }
    }
    // A removed rule's pending persistence goes with it: the same rule added
    // again later starts its duration afresh, instead of counting the time it
    // was gone and firing at once.
    for (const key of [...trackers.keys()]) {
      if (key.startsWith('rule:') && !ids.has(key.slice(5))) trackers.delete(key);
    }
    return activeRules;
  }

  /**
   * What a candidate rule would say now, and how often it would have been
   * true over the watch's own recent record of the path - evidence for the
   * operator before they store it.
   */
  function proveRule(candidate, t = lastTick) {
    const rule = rules.normalizeRule(candidate, t);
    // However the rule was written - parser, model or by hand - a condition
    // the data can never meet is refused here, before the operator adds it.
    for (const condition of [rule, rule.when].filter(Boolean)) {
      const info = infoFor(condition.path) || {};
      const problem = rules.measuredValueError(condition, info.units, seenValueFor(condition.path));
      if (problem) {
        const error = new Error(problem);
        error.code = 'validation-failed';
        throw error;
      }
    }
    const current = latest.get(rule.path);
    const verdict = rules.evaluateRule(rule, (path) => latest.get(path), t, {});
    const state = paths.get(rule.path);
    let recent;
    if (state && rules.NUMERIC_OPS.has(rule.op) && state.kind === 'continuous') {
      const minutes = monitor.seriesWithOpen(state, 'minutes', 'minuteBucket', 60000);
      if (minutes.length > 0) {
        const hits = minutes.filter(([, value]) => rules.compare(rule.op, value, rule.value)).length;
        recent = { minutes: minutes.length, share: hits / minutes.length };
      }
    }
    return {
      rule,
      description: rules.describeRule(rule, infoFor),
      current: current
        ? { value: current.value, text: rules.describeValue(rule.path, current.value, infoFor(rule.path)), ageMs: t - current.at }
        : undefined,
      wouldFireNow: verdict === null ? null : verdict.active,
      ...(recent ? { recent } : {})
    };
  }

  function ruleStatus(t) {
    return activeRules.map((rule) => {
      const current = latest.get(rule.path);
      return {
        ...rule,
        description: rules.describeRule(rule, infoFor),
        firing: findings.has(`rule:${rule.id}`),
        current: current ? rules.describeValue(rule.path, current.value, infoFor(rule.path)) : undefined,
        currentAgeMs: current ? t - current.at : undefined
      };
    });
  }

  // ---- outputs -------------------------------------------------------------

  /**
   * One notification per path (or per GNSS / data feed), carrying the worst
   * open finding for it: `Map<notifyKey, { state, message, findings }>`.
   */
  function notificationStates() {
    const out = new Map();
    for (const finding of findings.values()) {
      const current = out.get(finding.notifyKey);
      if (!current) {
        out.set(finding.notifyKey, { state: finding.severity, title: finding.title, message: `${finding.title}: ${finding.message}`, count: 1 });
        continue;
      }
      current.count += 1;
      if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[current.state]) {
        current.state = finding.severity;
        current.title = finding.title;
        current.message = `${finding.title}: ${finding.message}`;
      }
    }
    for (const value of out.values()) {
      if (value.count > 1) value.message = `${value.message} (+${value.count - 1} more)`;
    }
    return out;
  }

  function gnssSummary(t) {
    const indicators = evaluateGnss(gnss, t, options);
    const summary = {};
    let any = false;
    for (const [name, cond] of Object.entries(indicators)) {
      const open = findings.has(`gnss.${name}`);
      summary[name] = cond === null ? 'unavailable' : open ? 'active' : 'ok';
      if (cond !== null) any = true;
    }
    const active = Object.values(summary).filter((value) => value === 'active').length;
    // Before the lost check has learned the fix rate, a fix older than a
    // minute still must not read as "ok".
    const stale = gnss.lastFix !== undefined && t - gnss.lastFix.at > 60000;
    return {
      status:
        !any && !gnss.lastFix
          ? 'unavailable'
          : summary.lost === 'active' || (stale && summary.lost !== 'ok')
            ? 'lost'
            : active >= 2
              ? 'suspect'
              : active === 1
                ? 'degraded'
                : 'ok',
      lastFixAt: gnss.lastFix ? gnss.lastFix.at : undefined,
      indicators: summary
    };
  }

  function status(t = lastTick) {
    let learning = 0;
    let ready = 0;
    let relearning = 0;
    for (const state of paths.values()) {
      if (t < state.relearnUntil) relearning += 1;
      else if (monitor.isReady(state, t, options)) ready += 1;
      else learning += 1;
    }
    return {
      startedAt,
      sensitivity: watchConfig.watchSensitivity,
      learningMinutes: watchConfig.watchLearningMinutes,
      paths: { watched: paths.size, ready, learning, relearning, excluded: excluded.size, capped },
      sourcesCompared: sourceOnly.size + [...paths.values()].filter((state) => state.sources && Object.keys(state.sources.entries).length > 1).length,
      activeFindings: [...findings.values()].map(snapshotWithIncident),
      incidents: incidents.map(publicIncident),
      regimeChanges: regimeChanges.slice(),
      gnss: gnssSummary(t),
      rules: ruleStatus(t),
      lessSensitive: feedbackSummary(t),
      habits: learnedHabits(t).slice(0, 20),
      mutes: mutes.map((mute) => ({ ...mute }))
    };
  }

  function snapshotWithIncident(finding) {
    return { ...snapshot(finding), incidentId: finding.incidentId };
  }

  function publicIncident(incident) {
    const { groups, lead, namedBy, ...rest } = incident;
    return { ...rest, findings: incident.findings.map((entry) => ({ ...entry })) };
  }

  /** Learned series for one path, for the panel's evidence sparkline. */
  function series(path) {
    const state = paths.get(path);
    if (!state) return undefined;
    return {
      path,
      units: state.units,
      minutes: monitor.seriesWithOpen(state, 'minutes', 'minuteBucket', 60000),
      recent: monitor.seriesWithOpen(state, 'recent', 'recentBucket', 10000)
    };
  }

  function mute(path, untilMs, t) {
    const clean = String(path || '').trim();
    if (!clean) return;
    mutes = mutes.filter((item) => item.path !== clean);
    mutes.push({ path: clean, until: untilMs });
    compileMutes(t);
    // Muting something that just fired says it was not worth the interruption.
    if (!clean.includes('*') && [...findings.values()].some((finding) => finding.path === clean)) {
      giveFeedback(clean, false, t);
    }
  }

  // ---- operator feedback ---------------------------------------------------

  function decayedDismissals(entry, t) {
    if (!entry) return 0;
    return entry.dismissals * 0.5 ** (Math.max(0, t - entry.at) / FEEDBACK_HALF_LIFE_MS);
  }

  /**
   * How much harder this path has to try before it is reported: 1 normally,
   * up to 2 after repeated dismissals. Applied to the level and source
   * checks' thresholds and to the silence a dropout needs.
   */
  function sensitivityFactor(path, t) {
    const dismissals = decayedDismissals(feedback.get(path), t);
    return dismissals < 0.5 ? 1 : Number((1 + 0.25 * Math.min(4, dismissals)).toFixed(2));
  }

  /**
   * `useful: false` for a dismissal ("not useful", a mute), true to undo one,
   * `'reset'` to forget all feedback for the path.
   */
  function giveFeedback(path, useful, t) {
    const clean = String(path || '').trim();
    if (!clean) return undefined;
    // A finding the operator found useful (or whose feedback they reset) is
    // one the watch must not get used to: what it learned this path's
    // departures usually look like is forgotten.
    const state = paths.get(clean);
    if (state && useful !== false) monitor.forgetHabits(state);
    if (useful === 'reset') {
      feedback.delete(clean);
      return { path: clean, factor: 1 };
    }
    const current = decayedDismissals(feedback.get(clean), t);
    const dismissals = Math.max(0, useful ? current - 1 : current + 1);
    if (dismissals < 0.01) feedback.delete(clean);
    else feedback.set(clean, { dismissals, at: t });
    return { path: clean, factor: sensitivityFactor(clean, t) };
  }

  function feedbackSummary(t) {
    return [...feedback.entries()]
      .map(([path, entry]) => ({ path, dismissals: Number(decayedDismissals(entry, t).toFixed(1)), factor: sensitivityFactor(path, t) }))
      .filter((item) => item.factor > 1)
      .sort((a, b) => b.factor - a.factor);
  }

  /** The departures paths make and come back from often enough to be expected (habits.cjs). */
  function learnedHabits(t) {
    const rows = [];
    for (const state of paths.values()) {
      for (const habit of monitor.habitSummary(state, t)) rows.push({ path: state.path, ...habit });
    }
    return rows.sort((a, b) => b.count - a.count);
  }

  // ---- watch report --------------------------------------------------------

  /**
   * What the watch saw over the last `hours`, as facts and as plain lines -
   * a template, like everything else here, so it can go straight into a
   * logbook. The operator can hand it to the model for a summary.
   */
  function report(t = lastTick, hours = 24) {
    const span = Math.min(7 * 24, Math.max(1, Number(hours) || 24)) * HOUR;
    const from = t - span;
    const closed = findingLog.filter((entry) => entry.clearedAt >= from);
    const open = [...findings.values()].map((finding) => ({
      detector: finding.detector,
      path: finding.path,
      severity: finding.severity,
      title: finding.title,
      openedAt: finding.openedAt,
      clearedAt: undefined
    }));
    const all = [...closed, ...open];
    const inWindow = incidents.filter((incident) => (incident.resolvedAt ?? t) >= from);
    // An incident that reached alert counts as one, even if what is left of it is a warning.
    const alerts = inWindow.filter((incident) => (incident.peakSeverity || incident.severity) === 'alert').length;
    const byTitle = new Map();
    for (const entry of all) byTitle.set(entry.title, (byTitle.get(entry.title) || 0) + 1);
    const frequent = [...byTitle.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const longest = all
      .map((entry) => ({ ...entry, duration: (entry.clearedAt ?? t) - entry.openedAt }))
      .sort((a, b) => b.duration - a.duration)[0];
    const sensorTrouble = all.filter((entry) => ['dropout', 'frozen', 'failover', 'disagree', 'feed'].includes(entry.detector));
    const gnssEntries = all.filter((entry) => entry.detector.startsWith('gnss.'));
    const ruleEntries = all.filter((entry) => entry.detector === 'rule');
    const changes = regimeChanges.filter((change) => change.at >= from).slice().reverse();
    const clock = (at) => {
      const date = new Date(at);
      return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
    };
    const minutes = (ms) => (ms >= 90 * MINUTE ? `${(ms / HOUR).toFixed(1)} h` : `${Math.max(1, Math.round(ms / MINUTE))} min`);
    const unique = (entries) => [...new Set(entries.map((entry) => entry.title))];

    const lines = [];
    lines.push(
      inWindow.length === 0
        ? 'Nothing unusual was found.'
        : `${inWindow.length} incident${inWindow.length === 1 ? '' : 's'} (${alerts} alert${alerts === 1 ? '' : 's'}, ` +
            `${inWindow.length - alerts} warning${inWindow.length - alerts === 1 ? '' : 's'}) from ${all.length} finding${all.length === 1 ? '' : 's'}.`
    );
    if (open.length > 0) lines.push(`Still active: ${unique(open).slice(0, 4).join('; ')}.`);
    if (longest && longest.duration >= 5 * MINUTE) lines.push(`Longest: ${longest.title}, ${minutes(longest.duration)}.`);
    if (frequent.length > 0) lines.push(`Repeated: ${frequent.map(([title, count]) => `${title} ×${count}`).join('; ')}.`);
    if (sensorTrouble.length > 0) lines.push(`Sensors and data: ${unique(sensorTrouble).slice(0, 4).join('; ')}.`);
    if (gnssEntries.length > 0) lines.push(`GNSS: ${unique(gnssEntries).join('; ')}.`);
    else if (gnss.lastFix || gnss.crossCheckedAt !== undefined) {
      // "Corroborated" only when something independent was checking: dead
      // reckoning or a second receiver. A fix with nothing to compare it to is
      // merely unchallenged.
      // Judged on the report's own window: when dead reckoning or a second
      // receiver last compared against the fix, not on what happens to be
      // set up at the moment the report is written.
      const checkedAt = gnss.crossCheckedAt;
      const checked = checkedAt !== undefined && checkedAt >= from;
      if (!gnss.lastFix) {
        // Restarted, and no fix since: what was checked before says nothing
        // about a receiver that has not been heard from.
        lines.push(
          checked
            ? `GNSS: no fix since the watch restarted (the fix was last cross-checked at ${clock(checkedAt)}, before it).`
            : 'GNSS: no fix since the watch restarted.'
        );
      } else {
        lines.push(
          checked
            ? `GNSS: no warnings; dead reckoning or a second receiver cross-checked the fix (last at ${clock(checkedAt)}).`
            : 'GNSS: no warnings, but nothing independent cross-checked the fix in this period.'
        );
      }
    }
    if (ruleEntries.length > 0) lines.push(`Your watches fired: ${unique(ruleEntries).slice(0, 4).join('; ')}.`);
    if (changes.length > 0) {
      lines.push(`Operating changes: ${changes.slice(0, 6).map((change) => `${change.label} at ${clock(change.at)}`).join(', ')}.`);
    }
    const habitual = learnedHabits(t);
    if (habitual.length > 0) {
      lines.push(
        `Learned to expect, and no longer reports: ${habitual
          .slice(0, 4)
          .map((item) => `${describePathName(item.path)} ${HABIT_WORDS[item.key] || item.key} (${item.count} times in ${item.sinceMs >= 2 * 24 * HOUR ? `${Math.round(item.sinceMs / (24 * HOUR))} days` : minutes(item.sinceMs)})`)
          .join('; ')}.`
      );
    }
    const lowered = feedbackSummary(t);
    if (lowered.length > 0) {
      lines.push(`Less sensitive after your dismissals: ${lowered.slice(0, 4).map((item) => describePathName(item.path)).join(', ')}.`);
    }

    return {
      from,
      to: t,
      hours: span / HOUR,
      incidents: inWindow.length,
      alerts,
      findings: all.length,
      byDetector: all.reduce((acc, entry) => ({ ...acc, [entry.detector]: (acc[entry.detector] || 0) + 1 }), {}),
      lines
    };
  }

  function unmute(path, t) {
    mutes = mutes.filter((item) => item.path !== String(path || '').trim());
    compileMutes(t);
  }

  function exportState(t) {
    return {
      version: STATE_VERSION,
      savedAt: t,
      // Each path's longestGap is its rhythm only; outages are kept apart
      // (outageGap). Saves without this mixed the two (importState()).
      rhythmGaps: true,
      paths: [...paths.values()].map(monitor.exportPathState),
      incidents: incidents.map((incident) => ({ ...incident, findings: incident.findings.map((entry) => ({ ...entry })) })),
      mutes,
      feedback: [...feedback.entries()],
      findingLog,
      gateRegimes: [...gateRegimes.entries()],
      gatePrefixes: [...gatePrefixes.entries()],
      // Only what the report needs across a restart; the detection state of
      // GNSS is rebuilt from live fixes.
      gnss: { crossCheckedAt: gnss.crossCheckedAt },
      drivers: learnedStates.exportDrivers(drivers),
      restarts
    };
  }

  /** Restore a saved baseline. Open incidents are closed: their findings did not survive. */
  function importState(saved, t) {
    if (!saved || saved.version !== STATE_VERSION || !Array.isArray(saved.paths)) {
      return false;
    }
    const legacyGaps = saved.rhythmGaps !== true;
    for (const item of saved.paths) {
      if (!item || typeof item.path !== 'string' || isExcluded(item.path) || paths.size >= watchConfig.watchMaxPaths) continue;
      const state = monitor.importPathState(item, t, { legacyGaps, savedAt: saved.savedAt });
      if (!state) continue;
      // A save from before a settled stretch needed short gaps may call a
      // slow, irregular path settled: it is not, so its outage cycle can be
      // learned again and its death reported.
      // A path that merely slowed down (its "outages" are its new interval,
      // not silences well beyond it) is not a cycle, and is left as it is.
      const cycle = state.cycleMax || state.cycleRun;
      const slowedDown = Number.isFinite(cycle) && cycle <= 1.5 * state.intervalMean;
      if (state.settled && state.intervalMean > options.maxRegularIntervalMs && !slowedDown) {
        state.settled = false;
        state.regularRun = 0;
        // ...and the cycle it had learned, if that save also dropped it.
        if (!Number.isFinite(state.cycleLimit) && Number.isFinite(cycle)) state.cycleLimit = 2 * cycle;
      }
      const listedBy = isCounterPath(state.path);
      // Listed differently than when it was saved (or saved before listings
      // were kept as they are now): its kind was decided under the old
      // listing, so it is decided again, from new samples.
      // Only a change in what the listing does counts - not a pattern
      // reworded or moved in the list.
      // What the listing did to the path when it was saved: recorded since
      // this version, else worked out from the saved listing.
      const before = item.counterListing || monitor.counterListingFor(item.path, item.counterOptIn);
      const now = monitor.counterListingFor(state.path, listedBy);
      // A save from before the effect was recorded, of a whole-number path
      // that a listing forced continuous and that now classifies itself:
      // forced by an older rule, so it too is decided again - once.
      const forcedBefore =
        !item.counterListing &&
        now === 'self' &&
        item.counterOptIn &&
        item.kind !== 'discrete' &&
        item.distinct === null &&
        item.allInteger === true;
      if (before !== now || forcedBefore) {
        monitor.redecideKind(state, t, options.learningMs);
      }
      state.counterListing = now;
      state.counterOptIn = listedBy;
      if (state.sources && state.sources.entries) {
        // Older saves kept one shared gap (diffMean/diffVar/diffN) instead of
        // a table of pairs; those statistics do not carry over.
        // Pairs saved before the offset was learned signed (the mean of
        // |difference|) learn it again.
        state.sources.pairs = sources.migratePairs(state.sources.pairs);
        delete state.sources.diffMean;
        delete state.sources.diffVar;
        delete state.sources.diffN;
        delete state.sources.lastDiff;
        // Like lastAt: the gap while the plugin was down is not a failover.
        for (const entry of Object.values(state.sources.entries)) entry.at = t;
        state.sources.failover = undefined;
      }
      paths.set(state.path, state);
    }
    // How the sources came back after earlier restarts: each path is given
    // its source's time to be heard again, and to come back from its detour.
    restarts = restartLearning.importRestarts(saved.restarts);
    restartedAt = t;
    for (const state of paths.values()) {
      state.reacquireNoted = false;
      state.startupUntil = t + restartLearning.startupFor(restarts, sourceKey(state), state.restartSettles);
      state.reacquireUntil = t + restartLearning.windowFor(restarts, sourceKey(state), 'reacquire');
      if (state.restartFrom !== undefined) state.restartUntil = t + restartLearning.windowFor(restarts, sourceKey(state), 'detour');
    }
    // A start-up after a restart, as after the first start, for as long as
    // the sources take to come back.
    options.startupUntil = t + restartLearning.startupMs(restarts);
    // A restart this soon after the save carries its open findings over
    // until the slowest source is heard again (resumeCarried()); after a
    // longer one they are closed.
    const carry = Number.isFinite(saved.savedAt) && saved.savedAt <= t && t - saved.savedAt <= CARRY_MAX_GAP_MS;
    carried = new Map();
    carryUntil = carry ? t + restartLearning.carryMs(restarts) : -Infinity;
    const interrupted = [];
    if (Array.isArray(saved.incidents)) {
      incidents = saved.incidents.slice(0, MAX_INCIDENTS).map((incident) => {
        if (incident.status !== 'active') return incident;
        const open = (incident.findings || []).filter((entry) => entry && entry.clearedAt === undefined && typeof entry.key === 'string');
        if (carry && open.length > 0 && Array.isArray(incident.groups)) {
          for (const entry of open) carried.set(entry.key, { incidentId: incident.id, openedAt: entry.openedAt, severity: entry.severity });
          // Named and rated by what is open, as it would be now (a save from
          // before that kept its first finding's name and its worst).
          const kept = { ...incident, findings: incident.findings.filter((entry) => entry && typeof entry === 'object').map((entry) => ({ ...entry })) };
          refreshIncident(kept);
          return kept;
        }
        // Closed by the restart: logged, so the report counts them.
        for (const entry of open) interrupted.push(entry);
        return {
          ...incident,
          status: 'resolved',
          resolvedAt: t,
          interrupted: true,
          // Resolved: remembered at the worst it reached.
          severity: incident.peakSeverity || incident.severity,
          findings: (incident.findings || []).map((entry) => ({ ...entry, clearedAt: entry.clearedAt ?? t }))
        };
      });
    }
    if (Array.isArray(saved.feedback)) {
      for (const [path, entry] of saved.feedback) {
        if (typeof path === 'string' && entry && Number.isFinite(entry.dismissals)) feedback.set(path, entry);
      }
    }
    if (Array.isArray(saved.findingLog)) {
      findingLog = saved.findingLog.filter((entry) => entry && t - entry.clearedAt < 7 * 24 * HOUR).slice(-MAX_FINDING_LOG);
    }
    for (const entry of interrupted) logClosed(entry, t);
    if (Array.isArray(saved.mutes)) {
      mutes = saved.mutes.filter((item) => item && typeof item.path === 'string' && item.until > t);
      compileMutes(t);
    }
    if (saved.gnss && Number.isFinite(saved.gnss.crossCheckedAt) && saved.gnss.crossCheckedAt <= t) {
      gnss.crossCheckedAt = saved.gnss.crossCheckedAt;
    }
    if (Array.isArray(saved.gateRegimes)) {
      for (const [path, regime] of saved.gateRegimes) gateRegimes.set(path, regime);
    }
    if (Array.isArray(saved.gatePrefixes)) {
      for (const [path, prefixes] of saved.gatePrefixes) {
        if (Array.isArray(prefixes)) gatePrefixes.set(path, prefixes);
      }
    }
    // Operating states learned before: their paths move with them again.
    drivers = learnedStates.importDrivers(saved.drivers, t);
    for (const driver of Object.keys(drivers.learned)) adoptLearned(driver, t);
    // Each path's operating state, for the runs it learns there.
    for (const state of paths.values()) state.regimeKey = regimeKeyFor(state.path);
    return true;
  }

  return {
    config: watchConfig,
    options,
    exportState,
    importState,
    ingest,
    inventory,
    giveFeedback,
    knownPaths,
    report,
    proveRule,
    // For tests: how many leaves the latest-value table holds.
    latestSize: () => latest.size,
    setRules,
    unusual,
    mute,
    notificationStates,
    series,
    setMeta,
    status,
    tick,
    unmute,
    hasPath: (path) => paths.has(path),
    paths: () => [...paths.keys()],
    stats: () => ({ ...counters, byDetector: { ...counters.byDetector } })
  };
}

module.exports = {
  DEFAULT_EXCLUDE,
  SENSITIVITY,
  compileGlob,
  createWatchEngine,
  detectorOptions,
  feedSilence,
  normalizeWatchConfig
};
