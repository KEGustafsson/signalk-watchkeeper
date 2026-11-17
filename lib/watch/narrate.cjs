'use strict';

const {
  describePathParts,
  formatDelta,
  formatDuration,
  formatPlain,
  formatPlainDelta,
  formatValue,
  plainDecimals,
  plainDuration
} = require('./format.cjs');
const rules = require('./rules.cjs');

/**
 * Finding text, from templates.
 *
 * Deliberately not a language model. Every number below is one the detector
 * measured, rendered in the operator's units, so the text cannot drift from
 * the data and needs no verification - and it costs nothing to produce.
 *
 * Each finding has two texts. `title` and `message` are for the owner - the
 * panel, the copied incident and the Signal K notification: numbers rounded
 * to what matters (13.3 V, 87 %), "usually X", and how far out it is in
 * words. `detail` keeps the exact figures (the measured value to the
 * detector's precision, how many normal variations it is out, the rate of
 * change) for the panel's tooltip and the API. A level's `brief` is its
 * value and usual alone, for a line about a departure that is already over.
 */

const GNSS_TITLES = {
  jump: 'GNSS position jumped',
  deadReckoning: 'GNSS fix disagrees with dead reckoning',
  sourcesDisagree: 'GNSS receivers disagree',
  quality: 'GNSS fix quality dropped',
  frozen: 'GNSS fix stopped moving',
  clock: 'GNSS clock jumped',
  lost: 'GNSS position lost'
};

function displayValue(value) {
  if (value === 'true' || value === true) return 'on (true)';
  if (value === 'false' || value === false) return 'off (false)';
  return `"${value}"`;
}

/** `"alarm" or "off"`, `"a", "b" or "c"`. */
function orList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** "; it has had 6 such rises in the past 3 days, up to 8.1×, lasting up to 2 min" */
function habitClause(usual, noun, size) {
  if (!usual || !Number.isFinite(usual.count)) return '';
  const days = usual.sinceMs >= 2 * 24 * 60 * 60 * 1000 ? `${Math.round(usual.sinceMs / (24 * 60 * 60 * 1000))} days` : formatDuration(usual.sinceMs);
  return `; it has had ${usual.count} such ${noun} in the past ${days}, usually up to ${size(usual.peak)}, lasting up to ${formatDuration(usual.durationMs)}`;
}

/** `the past 15 h`, `the past 3 days`. */
function plainSince(sinceMs) {
  return sinceMs >= 2 * 24 * 60 * 60 * 1000 ? `${Math.round(sinceMs / (24 * 60 * 60 * 1000))} days` : plainDuration(sinceMs);
}

// How far outside its normal variation a level is, in words: under 5 of its
// normal variations "a little", under 10 "clearly", beyond that "far".
function strengthWords(z) {
  const size = Math.abs(z);
  if (!Number.isFinite(size)) return '';
  if (size < 5) return 'a little';
  if (size < 10) return 'clearly';
  return 'far';
}

// A leaf that names a share - `memoryUtilisation`, `fillRatio` - is a ratio
// when its source published no units, but only if the numbers are one (0..1):
// a CPU load sent as 0..100 under the same name stays a plain number.
const RATIO_LEAF = /(?:Utili[sz]ation|Ratio|Fraction)$/i;

function plainUnits(path, units, values) {
  if (typeof units === 'string') return units;
  const leaf = String(path || '').slice(String(path || '').lastIndexOf('.') + 1);
  if (!RATIO_LEAF.test(leaf)) return undefined;
  const finite = values.filter((value) => typeof value === 'number');
  return finite.length > 0 && finite.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ? 'ratio' : undefined;
}

function narrate(detector, info, evidence = {}, cond = {}) {
  const path = info && info.path;
  const names = describePathParts(path, info && info.displayName);
  return { ...narrateText(detector, info, evidence, cond, names.name), name: names.name, system: names.system, part: names.part };
}

function narrateText(detector, info, evidence, cond, name) {
  const path = info && info.path;
  const units = info && info.units;

  switch (detector) {
    case 'shift': {
      const high = evidence.z > 0;
      const slope =
        typeof evidence.slopePerMinute === 'number' && Math.abs(evidence.slopePerMinute) > 0
          ? `, changing ${formatDelta(path, evidence.slopePerMinute, units)}/min`
          : '';
      const detail =
        `${formatValue(path, evidence.value, units)}, ${formatDelta(path, evidence.delta, units)} from its usual ` +
        `${formatValue(path, evidence.baseline, units)} (${Math.abs(evidence.z).toFixed(1)}× its normal variation)${slope}` +
        habitClause(evidence.usual, high ? 'rises' : 'drops', (peak) => `${peak.toFixed(1)}×`);
      const plain = plainUnits(path, units, [evidence.value, evidence.baseline]);
      const gaps = [evidence.delta, evidence.value - evidence.baseline].filter((gap) => Number.isFinite(gap) && gap !== 0).map(Math.abs);
      const decimals = plainDecimals(path, plain, gaps.length > 0 ? Math.min(...gaps) : 0, [evidence.value, evidence.baseline]);
      const strength = strengthWords(evidence.z);
      // The rate is worth saying only while the reading itself is still
      // moving away from normal: still beyond the average that tripped the
      // check, and heading further out. A spike already on its way back has
      // a steep slope too, and saying so only adds a number to read.
      const moving =
        slope &&
        Number.isFinite(evidence.delta) &&
        Math.sign(evidence.slopePerMinute) === Math.sign(evidence.delta) &&
        Math.abs(evidence.value - evidence.baseline) >= Math.abs(evidence.delta);
      let habit = '';
      if (evidence.usual && Number.isFinite(evidence.usual.count)) {
        const size = Math.abs(evidence.z);
        const peak = evidence.usual.peak;
        const compared = !(size > peak) ? 'no bigger than those' : size <= 1.5 * peak ? 'a little bigger' : 'clearly bigger';
        habit =
          `. It has ${high ? 'risen' : 'dropped'} like this ${evidence.usual.count} times in the past ${plainSince(evidence.usual.sinceMs)}, ` +
          `for up to ${plainDuration(evidence.usual.durationMs)} each; this one is ${compared}`;
      }
      const brief = `${formatPlain(path, evidence.value, plain, decimals)}, usually ${formatPlain(path, evidence.baseline, plain, decimals)}`;
      return {
        title: `${name} ${high ? 'higher' : 'lower'} than usual`,
        // The value and its usual, without how far out or how often: what
        // a line about a departure that is already over needs.
        brief,
        message:
          brief +
          (strength ? ` – ${strength} outside its normal range` : '') +
          (moving ? `, still changing ${formatPlainDelta(path, evidence.slopePerMinute, plain)}/min` : '') +
          habit,
        detail
      };
    }
    case 'dropout': {
      const usual = `it normally updates every ${formatDuration(evidence.intervalMean)}${evidence.source ? ` (source ${evidence.source})` : ''}`;
      const plainUsual = `It normally updates every ${plainDuration(evidence.intervalMean)}${evidence.source ? ` (source ${evidence.source})` : ''}`;
      if (Number.isFinite(evidence.unavailableSince)) {
        const silent = Math.max(evidence.silentFor || 0, evidence.unavailableFor || 0);
        const spells = evidence.usual && Number.isFinite(evidence.usual.count)
          ? `. It has had ${evidence.usual.count} spells of no value in the past ${plainSince(evidence.usual.sinceMs)}, lasting up to ${plainDuration(evidence.usual.durationMs)}`
          : '';
        return {
          title: `${name} sending no data`,
          message: plainUsual + spells,
          detail:
            `No reading for ${formatDuration(silent)}: the sensor is sending "no value" (null); ${usual}` +
            habitClause(evidence.usual, 'spells of no value', () => 'none').replace(/, usually up to none/, ''),
          kind: 'noData',
          // How long it has been without data: the finding may have opened
          // later (after a restart), and "since" is when the data stopped.
          ago: silent
        };
      }
      return {
        title: `${name} stopped updating`,
        message: plainUsual,
        detail: `No update for ${formatDuration(evidence.silentFor)}; ${usual}`,
        kind: 'stopped',
        ago: evidence.silentFor
      };
    }
    case 'frozen': {
      const usualRun = Number.isFinite(evidence.usualRunMs);
      return {
        title: `${name} looks stuck`,
        message:
          `Showing ${formatValue(path, evidence.value, units)} unchanged for ${plainDuration(evidence.frozenFor)} ` +
          `(${evidence.repeats} updates)` +
          (usualRun ? `; normally it changes within ${plainDuration(evidence.usualRunMs)}` : '; normally it changes on most updates'),
        detail:
          `Repeating exactly ${formatValue(path, evidence.value, units)} for ${formatDuration(evidence.frozenFor)} ` +
          `(${evidence.repeats} updates)` +
          (usualRun ? `; it normally holds a value for ${formatDuration(evidence.usualRunMs)} at most` : '; it normally changes on most updates')
      };
    }
    case 'newState': {
      const known = Array.isArray(evidence.known) ? evidence.known.map(displayValue) : [];
      const before =
        known.length === 0
          ? 'A value it has not had before'
          : known.length <= 5
            ? `Before only ${orList(known)}`
            : `A value it has not had before (it has read ${known.slice(0, 5).join(', ')} and ${known.length - 5} more)`;
      return {
        title: `${name} now reads ${displayValue(evidence.value)}`,
        message: before,
        detail: `A value this path has not taken before${known.length > 0 ? ` (seen before: ${known.slice(0, 5).join(', ')})` : ''}`
      };
    }
    case 'cycling': {
      const perHour = Number(evidence.baselinePerHour || 0);
      const habitual = evidence.usual && Number.isFinite(evidence.usual.count)
        ? `. It has had ${evidence.usual.count} such spells in the past ${plainSince(evidence.usual.sinceMs)}, up to ${Math.round(evidence.usual.peak)} switches an hour`
        : '';
      return {
        title: `${name} switching unusually often`,
        message:
          `${evidence.lastHour} switches in the last hour, normally ${perHour < 1 ? 'under 1' : `about ${Math.round(perHour)}`} an hour` + habitual,
        detail:
          `${evidence.lastHour} changes in the last hour, against about ` +
          `${perHour.toFixed(1)} per hour normally` +
          habitClause(evidence.usual, 'spells', (peak) => `${Math.round(peak)} changes an hour`),
        kind: 'switching'
      };
    }
    case 'rate':
      return {
        title: `${name} counting unusually fast`,
        message:
          `${formatDelta(path, evidence.ratePerMinute, units)}/min over the last ${formatDuration(evidence.windowMs)}, ` +
          (Number.isFinite(evidence.factor)
            ? `${evidence.factor.toFixed(1)}× the fastest it counted in the past week ` +
              `(${formatDelta(path, evidence.recordPerMinute, units)}/min)`
            : 'after not counting at all in the past week')
      };
    case 'forecast': {
      const limit = evidence.label ? `${evidence.zone} limit (${evidence.label})` : `${evidence.zone} zone (${formatValue(path, evidence.limit, units)})`;
      return {
        title: `${name} heading for its ${evidence.zone === 'low' ? 'limit' : `${evidence.zone} zone`}`,
        message:
          `${formatValue(path, evidence.value, units)} now, changing ${formatDelta(path, evidence.slopePerMinute, units)}/min: ` +
          `reaches the ${limit} in about ${formatDuration(evidence.etaMs)} if the trend holds`
      };
    }
    case 'disagree': {
      const gap = formatDelta(path, Math.abs(evidence.diff), units, { signed: false });
      const usual = formatDelta(path, evidence.usualGap || 0, units, { signed: false });
      const offset = evidence.usualOffset;
      // A gap on the other side of the usual offset, or narrower than it, is
      // news for its side, not its size: say which side is usual.
      const sided =
        Number.isFinite(offset) &&
        offset !== 0 &&
        Number.isFinite(evidence.diff) &&
        (offset * evidence.diff < 0 || Math.abs(evidence.diff) < Math.abs(offset));
      const usually = sided
        ? `where ${evidence.source} usually reads ${usual} ${offset > 0 ? 'above' : 'below'} ${evidence.primary}`
        : `where they are usually within ${usual}`;
      return {
        title: `${name}: sources disagree`,
        message:
          `${evidence.primary} reads ${formatValue(path, evidence.primaryValue, units)}, ${evidence.source} reads ` +
          `${formatValue(path, evidence.value, units)}: ${gap} apart, ${usually}`
      };
    }
    case 'failover':
      return {
        title: `${name} switched source`,
        message: `${evidence.from} went quiet; now reading ${evidence.to}`
      };
    case 'rule': {
      const rule = evidence.rule;
      if (!rule) return { title: 'Watch rule', message: '' };
      const infoFor = (info && info.infoFor) || (() => undefined);
      const now = rules.describeValue(rule.path, evidence.value, infoFor(rule.path) || { units });
      const changed = rule.op === 'changes' && evidence.from !== undefined
        ? `Changed from ${rules.describeValue(rule.path, evidence.from, infoFor(rule.path) || { units })} to ${now}`
        : `Now ${now}`;
      return {
        title: rules.describeRule(rule, infoFor).replace(/^(?:Warn|Alert) when /, ''),
        message: `${changed}. Your watch: "${rule.text || rules.describeRule(rule, infoFor)}"`
      };
    }
    case 'feed':
      return {
        title: 'Signal K data stopped arriving',
        message:
          `${evidence.silent} of ${evidence.regular} regularly updating paths have gone quiet` +
          (Array.isArray(evidence.sources) && evidence.sources.length > 0 ? ` (sources: ${evidence.sources.slice(0, 5).join(', ')})` : '')
      };
    default:
      if (detector && detector.startsWith('gnss.')) {
        const indicator = detector.slice(5);
        return { title: GNSS_TITLES[indicator] || 'GNSS integrity', message: cond.message || '' };
      }
      return { title: `${name}: ${detector}`, message: cond.message || '' };
  }
}

module.exports = { narrate };
