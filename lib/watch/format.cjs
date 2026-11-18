'use strict';

const { isAnglePath, isSpeedPath, isTemperaturePath } = require('../signalk-units.cjs');

/**
 * Operator-unit formatting for watch messages.
 *
 * Incident text is built from templates, not generated: every number in it is
 * the number the detector measured, so there is nothing for a model to get
 * wrong and nothing to verify. The unit comes from the path's own `meta.units`
 * when the server knows it, and from the path's leaf name when it does not.
 */

const KELVIN_OFFSET = 273.15;
// Directions relative to north. Angles relative to the bow - apparent and
// true wind angle (negative to port), roll, pitch, yaw, rudder - are signed.
const CYCLIC_ANGLE = /^(?:heading[A-Za-z]*|course[A-Za-z]*|bearing[A-Za-z]*|track[A-Za-z]*|direction[A-Za-z]*|set|[a-z]+(?:Heading|Bearing|Course|Track|Direction)[A-Za-z]*)$/;

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** The display unit for a path: a function from SI to display value, and its label. */
/**
 * The Signal K unit a leaf name implies, for paths whose source published no
 * metadata. Signal K fixes the unit per path in its specification, so the
 * leaf name is a reliable guess for the common ones.
 */
function inferUnits(leaf) {
  if (leaf === 'voltage') return 'V';
  if (leaf === 'current') return 'A';
  if (leaf === 'power') return 'W';
  if (/[Pp]ressure$/.test(leaf)) return 'Pa';
  if (leaf === 'revolutions') return 'Hz';
  if (leaf === 'fuelRate' || leaf === 'rate') return 'm3/s';
  return undefined;
}

function displayUnit(path, units) {
  const leaf = String(path || '').slice(String(path || '').lastIndexOf('.') + 1);
  const unit = typeof units === 'string' ? units : inferUnits(leaf);

  if (unit === 'rad' || (!unit && isAnglePath(path))) {
    if (leaf === 'rateOfTurn') {
      return { convert: (v) => v * (180 / Math.PI) * 60, label: '°/min', decimals: 1, delta: (v) => v * (180 / Math.PI) * 60 };
    }
    return { convert: (v) => v * (180 / Math.PI), label: '°', decimals: 1, delta: (v) => v * (180 / Math.PI) };
  }
  if (unit === 'K' || (!unit && isTemperaturePath(path))) {
    return { convert: (v) => v - KELVIN_OFFSET, label: '°C', decimals: 1, delta: (v) => v };
  }
  if (unit === 'm/s' || (!unit && isSpeedPath(path))) {
    return { convert: (v) => v / 0.514444, label: 'kn', decimals: 2, delta: (v) => v / 0.514444 };
  }
  if (unit === 'Pa') {
    return { convert: (v) => v / 100, label: 'hPa', decimals: 1, delta: (v) => v / 100 };
  }
  if (unit === 'ratio' || (!unit && /^(?:stateOfCharge|currentLevel|relativeHumidity|stateOfHealth)$/.test(leaf))) {
    return { convert: (v) => v * 100, label: '%', decimals: 1, delta: (v) => v * 100 };
  }
  if (unit === 'Hz' && leaf === 'revolutions') {
    return { convert: (v) => v * 60, label: 'rpm', decimals: 0, delta: (v) => v * 60 };
  }
  if (unit === 'm3/s') {
    return { convert: (v) => v * 3.6e6, label: 'L/h', decimals: 1, delta: (v) => v * 3.6e6 };
  }
  if (unit === 'm3') {
    return { convert: (v) => v * 1000, label: 'L', decimals: 0, delta: (v) => v * 1000 };
  }
  if (unit) {
    return { convert: (v) => v, label: unit, decimals: 2, delta: (v) => v };
  }
  return { convert: (v) => v, label: '', decimals: 3, delta: (v) => v };
}

/** `92.0 °C`, `13.2 V`, `41 %`: a value on a path in the operator's unit. */
function formatValue(path, value, units) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return String(value);
  }
  const unit = displayUnit(path, units);
  let display = unit.convert(value);
  // Only directions wrap: a heading of −10° is 350°, but a roll, pitch,
  // rudder angle or leeway of −10° is −10°, and showing it as 350° would read
  // back an operator's threshold as something they never typed.
  if (unit.label === '°' && CYCLIC_ANGLE.test(String(path || '').slice(String(path || '').lastIndexOf('.') + 1))) {
    display = ((display % 360) + 360) % 360;
  }
  const text = roundTo(display, unit.decimals).toFixed(unit.decimals);
  return unit.label ? `${text} ${unit.label}` : text;
}

/** A difference on a path (no offset applied), e.g. `+3.2 °C`. */
function formatDelta(path, delta, units, { signed = true } = {}) {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) {
    return String(delta);
  }
  const unit = displayUnit(path, units);
  const display = unit.delta(delta);
  const text = roundTo(Math.abs(display), unit.decimals).toFixed(unit.decimals);
  const sign = signed ? (display >= 0 ? '+' : '−') : '';
  return unit.label ? `${sign}${text} ${unit.label}` : `${sign}${text}`;
}

/** `12 s`, `4 min`, `2.5 h`. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return 'unknown';
  }
  const seconds = ms / 1000;
  if (seconds < 90) {
    return `${Math.round(seconds)} s`;
  }
  const minutes = seconds / 60;
  if (minutes < 90) {
    return `${Math.round(minutes)} min`;
  }
  const hours = minutes / 60;
  if (hours < 48) {
    return `${roundTo(hours, 1)} h`;
  }
  return `${roundTo(hours / 24, 1)} d`;
}

/** `12 s`, `4 min`, `21 h`, `3 d`: a duration rounded as an owner would say it. */
function plainDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return 'unknown';
  }
  const seconds = ms / 1000;
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}

// The most decimals a unit is worth reading in, and the fewest: a voltage in
// tenths, a temperature in whole degrees or tenths, a percentage whole.
const PLAIN_DECIMALS = {
  V: [1, 1],
  '°C': [0, 1],
  '%': [0, 0],
  kn: [1, 1],
  hPa: [0, 0],
  rpm: [0, 0],
  '°': [0, 0],
  '°/min': [0, 1],
  L: [0, 0],
  'L/h': [0, 1]
};

/**
 * The decimals that matter for a set of values on a path: enough to show the
 * difference that was measured (`scale`, in SI), within what the unit is worth
 * reading in, and at most two - plus one more while two different values
 * would otherwise print the same.
 */
function plainDecimals(path, units, scale, values = []) {
  const unit = displayUnit(path, units);
  const shown = Math.abs(unit.delta(scale));
  let decimals = Number.isFinite(shown) && shown > 0 ? Math.min(2, Math.max(0, Math.ceil(-Math.log10(shown)))) : 1;
  const [min, max] = PLAIN_DECIMALS[unit.label] || [0, 2];
  decimals = Math.min(max, Math.max(min, decimals));
  const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  const print = (d) => finite.map((value) => roundTo(unit.convert(value), d).toFixed(d));
  const hidden = (d) => {
    const printed = print(d);
    // Two different values that print the same, or a value that is not zero
    // printing as zero ("usually 0.0" for 0.02), say less than was measured.
    return (new Set(finite).size > 1 && new Set(printed).size === 1) || finite.some((value, index) => unit.convert(value) !== 0 && Number(printed[index]) === 0);
  };
  while (decimals < 2 && finite.length > 0 && hidden(decimals)) {
    decimals += 1;
  }
  return decimals;
}

/** A difference in the operator's unit, signed and rounded as plainDecimals() says: `+0.5 °C`. */
function formatPlainDelta(path, delta, units) {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) {
    return String(delta);
  }
  const unit = displayUnit(path, units);
  const display = unit.delta(delta);
  const decimals = plainDecimals(path, units, delta);
  const text = roundTo(Math.abs(display), decimals).toFixed(decimals);
  const label = unit.label === 'Hz' && /fps$/i.test(String(path || '')) ? 'frames/s' : unit.label;
  return `${display >= 0 ? '+' : '−'}${label ? `${text} ${label}` : text}`;
}

/** A value in the operator's unit, rounded to `decimals`: `13.3 V`, `87 %`. */
function formatPlain(path, value, units, decimals) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return String(value);
  }
  const unit = displayUnit(path, units);
  let display = unit.convert(value);
  if (unit.label === '°' && CYCLIC_ANGLE.test(String(path || '').slice(String(path || '').lastIndexOf('.') + 1))) {
    display = ((display % 360) + 360) % 360;
  }
  const text = roundTo(display, decimals).toFixed(decimals);
  // A frame rate in Hz reads as frames a second.
  const label = unit.label === 'Hz' && /fps$/i.test(String(path || '')) ? 'frames/s' : unit.label;
  return label ? `${text} ${label}` : text;
}

function words(text) {
  return String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s.]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

// The Signal K branches with an instance id in a fixed place, and the noun an
// operator would use for one: `electrical.batteries.house.voltage` reads as
// "House battery voltage", not "Electrical batteries house voltage".
const NAMED_INSTANCES = [
  [/^electrical\.batteries\.([^.]+)\.(.+)$/, 'battery'],
  [/^electrical\.alternators\.([^.]+)\.(.+)$/, 'alternator'],
  [/^electrical\.chargers\.([^.]+)\.(.+)$/, 'charger'],
  [/^electrical\.inverters\.([^.]+)\.(.+)$/, 'inverter'],
  [/^electrical\.solar\.([^.]+)\.(.+)$/, 'solar'],
  [/^propulsion\.([^.]+)\.(.+)$/, 'engine'],
  [/^tanks\.([^.]+)\.([^.]+)\.(.+)$/, 'tank'],
  [/^environment\.inside\.([^.]+)\.(.+)$/, ''],
  [/^environment\.(outside|water)\.(.+)$/, '']
];

// Top-level branches that say where in the tree a path lives, not what it is:
// `electrical.victron.dcdc.voltageIn` is the Victron DC-DC's input voltage,
// and "Electrical" in front of it adds nothing. Dropped only when at least
// two words are left, so `navigation.position` keeps its first word.
const GROUP_WORDS = new Set([
  'electrical',
  'environment',
  'navigation',
  'sensors',
  'steering',
  'communication',
  'performance',
  'sails',
  'design',
  'platform',
  'control'
]);

// Abbreviations an owner would write differently, and words with a plainer
// equivalent. Only ones whose meaning is not in doubt: a token not listed
// here ("hh") stays as the word it is, rather than being guessed at.
const TOKENS = {
  ac: 'AC',
  dc: 'DC',
  dcdc: 'DC-DC',
  acdc: 'AC-DC',
  cpu: 'CPU',
  gpu: 'GPU',
  ram: 'RAM',
  sd: 'SD card',
  usb: 'USB',
  gnss: 'GNSS',
  gps: 'GPS',
  ais: 'AIS',
  nmea: 'NMEA',
  n2k: 'NMEA 2000',
  vhf: 'VHF',
  uhf: 'UHF',
  lte: 'LTE',
  wifi: 'Wi-Fi',
  imu: 'IMU',
  ip: 'IP',
  id: 'ID',
  mppt: 'MPPT',
  pv: 'PV',
  bms: 'BMS',
  ecu: 'ECU',
  hvac: 'HVAC',
  led: 'LED',
  rssi: 'RSSI',
  snr: 'SNR',
  hdop: 'HDOP',
  pdop: 'PDOP',
  vdop: 'VDOP',
  utc: 'UTC',
  fps: 'frames/s',
  rpm: 'rpm',
  rx: 'received',
  tx: 'sent',
  temp: 'temperature',
  avg: 'average',
  utilisation: 'use',
  utilization: 'use'
};

// A trailing "in"/"out" after a quantity is its input or output:
// `voltageIn` is the input voltage. Only after these words, so "plugged in"
// stays as it is.
const IN_OUT_QUANTITY = new Set(['voltage', 'current', 'power', 'temperature', 'pressure', 'frequency', 'flow', 'rate', 'energy']);

function plainWords(list) {
  const out = list.slice();
  const last = out.length - 1;
  if (last >= 1 && (out[last] === 'in' || out[last] === 'out') && IN_OUT_QUANTITY.has(out[last - 1])) {
    out.splice(last - 1, 2, out[last] === 'in' ? 'input' : 'output', out[last - 1]);
  }
  return out
    .map((word) => (Object.prototype.hasOwnProperty.call(TOKENS, word) ? TOKENS[word] : word))
    .join(' ')
    .replace(/\bunder keel\b/g, 'under-keel');
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A path as an owner would name it, in two parts: the system it belongs to
 * and what is measured on it. `navigation.underKeel.escapeHeading` ->
 * `{ name: 'Under-keel escape heading', system: 'under-keel', part: 'escape heading' }`.
 * With the path's own meta.displayName, that is the name (and the part); the
 * system still comes from the path. Deterministic: the same path always reads
 * the same.
 */
function describePathParts(path, displayName) {
  const text = String(path || '');
  let system;
  let part;
  for (const [pattern, noun] of NAMED_INSTANCES) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (noun === 'tank') {
      // tanks.freshWater.main.currentLevel -> "Fresh water tank main current level"
      const instance = /^\d+$/.test(match[2]) || match[2] === 'main' || match[2] === 'default' ? [] : words(match[2]);
      system = [...words(match[1]), 'tank', ...instance];
      part = words(match[3]);
    } else {
      system = /^\d+$/.test(match[1]) ? [noun, match[1]] : [...words(match[1]), ...(noun ? [noun] : [])];
      part = words(match[2]);
    }
    break;
  }
  if (!system) {
    let segments = text.split('.').filter(Boolean);
    if (segments.length > 1 && GROUP_WORDS.has(segments[0].toLowerCase())) {
      const rest = segments.slice(1);
      if (rest.flatMap(words).length >= 2) segments = rest;
    }
    if (segments.length > 1) {
      system = words(segments[0]);
      part = segments.slice(1).flatMap(words);
    } else {
      system = [];
      part = segments.flatMap(words);
    }
  }
  const systemText = plainWords(system);
  const partText = plainWords(part);
  const own = typeof displayName === 'string' && displayName.trim().length > 0 ? displayName.trim() : '';
  // "Main inverter inverter mode" says its noun twice: once is enough.
  const joined = [systemText, partText]
    .filter(Boolean)
    .join(' ')
    .split(' ')
    .filter((word, index, list) => index === 0 || word.toLowerCase() !== list[index - 1].toLowerCase())
    .join(' ');
  return {
    name: own || (joined ? capitalise(joined) : text),
    system: systemText,
    part: own || partText || joined
  };
}

/**
 * `electrical.batteries.house.voltage` -> `House battery voltage`, or the
 * path's own meta.displayName when its source published one.
 */
function describePath(path, displayName) {
  return describePathParts(path, displayName).name;
}

/**
 * What a path measures, from its Signal K units (or its leaf name when it has
 * none): `temperature`, `voltage`, `ratio`, ...
 */
// Leaves that name a state or a label, whatever the path around them says:
// navigation.speedThroughWaterReferenceType is text, not a speed.
const STATE_LEAF = /(?:Type|Mode|State|Status|Name|Source|Reference|Method|Label)$/;

function dimensionOf(path, units) {
  const leaf = String(path || '').slice(String(path || '').lastIndexOf('.') + 1);
  if (typeof units !== 'string' && STATE_LEAF.test(leaf)) return 'number';
  const unit = typeof units === 'string' ? units : inferUnits(leaf) ||
    (isTemperaturePath(path) ? 'K' : isAnglePath(path) ? 'rad' : isSpeedPath(path) ? 'm/s' : undefined) ||
    (/^(?:stateOfCharge|currentLevel|relativeHumidity|stateOfHealth)$/.test(leaf) ? 'ratio' : undefined);
  return {
    K: 'temperature',
    V: 'voltage',
    A: 'current',
    W: 'power',
    ratio: 'ratio',
    'm/s': 'speed',
    Hz: 'frequency',
    Pa: 'pressure',
    m: 'length',
    rad: 'angle',
    m3: 'volume',
    'm3/s': 'flow'
  }[unit] || 'number';
}

// Operator units to SI, by what the operator typed. `dimension` says which
// kind of path the unit can apply to, which also helps pick the path.
const OPERATOR_UNITS = [
  [/^(?:[°º]\s*c(?:elsius)?|deg(?:rees)?\s*c(?:elsius)?|c|celsius|degrees?)$/, 'temperature', (v) => v + KELVIN_OFFSET],
  [/^(?:[°º]\s*f(?:ahrenheit)?|deg(?:rees)?\s*f(?:ahrenheit)?|f|fahrenheit)$/, 'temperature', (v) => ((v - 32) * 5) / 9 + KELVIN_OFFSET],
  [/^(?:k|kelvin)$/, 'temperature', (v) => v],
  [/^(?:v|volts?)$/, 'voltage', (v) => v],
  [/^(?:a|amps?|amperes?)$/, 'current', (v) => v],
  [/^(?:w|watts?)$/, 'power', (v) => v],
  [/^(?:kw|kilowatts?)$/, 'power', (v) => v * 1000],
  [/^(?:%|percent|per\s*cent|pct)$/, 'ratio', (v) => v / 100],
  [/^(?:kn|kts?|knots?)$/, 'speed', (v) => v * 0.514444],
  [/^(?:m\/s|mps)$/, 'speed', (v) => v],
  [/^(?:rpm|revs?)$/, 'frequency', (v) => v / 60],
  [/^(?:hz)$/, 'frequency', (v) => v],
  [/^(?:hpa|mb|mbar|millibars?)$/, 'pressure', (v) => v * 100],
  [/^(?:kpa)$/, 'pressure', (v) => v * 1000],
  [/^(?:bar)$/, 'pressure', (v) => v * 100000],
  [/^(?:psi)$/, 'pressure', (v) => v * 6894.757],
  [/^(?:pa)$/, 'pressure', (v) => v],
  [/^(?:m|metres?|meters?)$/, 'length', (v) => v],
  [/^(?:ft|feet|foot)$/, 'length', (v) => v * 0.3048],
  [/^(?:nm|nmi|nautical\s*miles?)$/, 'length', (v) => v * 1852],
  [/^(?:l|litres?|liters?)$/, 'volume', (v) => v / 1000],
  [/^(?:l\/h|lph)$/, 'flow', (v) => v / 3.6e6]
];

/** `°C` -> { dimension: 'temperature', toSI }, or undefined for an unknown unit. */
function parseOperatorUnit(text) {
  const clean = String(text || '').trim().toLowerCase();
  if (!clean) return undefined;
  for (const [pattern, dimension, toSI] of OPERATOR_UNITS) {
    if (pattern.test(clean)) return { dimension, toSI };
  }
  return undefined;
}

/**
 * A number the operator typed, in SI for this path. With a unit, the unit
 * decides (and must suit the path); without one, it is read in the unit the
 * panel shows for the path - "above 95" on a coolant temperature means 95 °C.
 * Returns undefined when the unit cannot apply to the path.
 */
function fromDisplay(path, units, value, typedUnit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const dimension = dimensionOf(path, units);
  if (typedUnit) {
    const parsed = parseOperatorUnit(typedUnit);
    if (!parsed) return undefined;
    if (dimension !== 'number' && parsed.dimension !== dimension) return undefined;
    return parsed.toSI(value);
  }
  const unit = displayUnit(path, units);
  // Invert the display conversion numerically: every one of them is linear.
  const zero = unit.convert(0);
  const slope = unit.convert(1) - zero;
  return slope === 0 ? undefined : (value - zero) / slope;
}

module.exports = {
  STATE_LEAF,
  describePath,
  describePathParts,
  dimensionOf,
  fromDisplay,
  parseOperatorUnit,
  displayUnit,
  formatDelta,
  formatDuration,
  formatPlain,
  formatPlainDelta,
  formatValue,
  plainDecimals,
  plainDuration
};
