'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { narrate } = require('../lib/watch/narrate.cjs');
const { describePath, describePathParts, formatPlain, plainDecimals, plainDuration } = require('../lib/watch/format.cjs');

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const KELVIN = 273.15;

// The incident an owner found "not informative or easy to read": the
// numbers below are the ones the watch measured on that boat.
const OWNER = {
  memory: ['shift', { path: 'environment.nano.memoryUtilisation' }, { value: 0.87, baseline: 0.718, delta: 0.152, z: 7.6 }],
  dcdc: ['shift', { path: 'electrical.victron.dcdc.voltageIn', units: 'V' }, { value: 13.3, baseline: 13.84, delta: -0.54, z: -10.8 }],
  fps: ['shift', { path: 'vision.system.inferenceFps', units: 'Hz' }, { value: 11.96, baseline: 12.09, delta: -2.55, z: -4.0, slopePerMinute: -3.79 }],
  sd: ['shift', { path: 'environment.nano.sdUtilisation' }, { value: 0.3, baseline: 0.292, delta: 0.008, z: 5.5 }],
  memoryLow: ['shift', { path: 'environment.nano.memoryUtilisation' }, { value: 0.72, baseline: 0.786, delta: -0.065, z: -3.1 }],
  cpu: [
    'shift',
    { path: 'environment.nano.cpuTemperature', units: 'K' },
    { value: KELVIN + 53.4, baseline: KELVIN + 50.7, delta: 2.7, z: 3.6, usual: { count: 8, peak: 4.0, durationMs: 11 * MINUTE, sinceMs: 14.9 * HOUR } }
  ],
  clearance: [
    'dropout',
    { path: 'navigation.underKeel.clearance', units: 'm' },
    { silentFor: 20.6 * HOUR, unavailableSince: 1, unavailableFor: 20.6 * HOUR, intervalMean: 10000, source: 'signalk-underkeel' }
  ],
  state: ['newState', { path: 'navigation.underKeel.state' }, { value: 'unknown', known: ['alarm', 'off'] }],
  switching: ['cycling', { path: 'control.remoteController.plugin.hhLive' }, { lastHour: 4, baselinePerHour: 0.3 }]
};

const say = (key) => narrate(...OWNER[key]);

describe('finding text: names an owner would use', () => {
  it('maps the abbreviations whose meaning is not in doubt, and leaves the rest as words', () => {
    assert.equal(describePath('electrical.victron.dcdc.voltageIn'), 'Victron DC-DC input voltage');
    assert.equal(describePath('environment.nano.sdUtilisation'), 'Nano SD card use');
    assert.equal(describePath('environment.nano.cpuTemperature'), 'Nano CPU temperature');
    assert.equal(describePath('environment.nano.memoryUtilisation'), 'Nano memory use');
    assert.equal(describePath('sensors.headingHold.gnssValid'), 'Heading hold GNSS valid');
    assert.equal(describePath('vision.system.inferenceFps'), 'Vision system inference frames/s');
    assert.equal(describePath('navigation.underKeel.escapeHeading'), 'Under-keel escape heading');
    // "hh" means something on that boat, but nothing the path says: kept.
    assert.equal(describePath('control.remoteController.plugin.hhLive'), 'Remote controller plugin hh live');
    assert.equal(describePath('electrical.inverters.main.inverterMode'), 'Main inverter mode');
  });

  it('drops the top-level branch only where a name is left, and reads a trailing in/out only after a quantity', () => {
    assert.equal(describePath('navigation.speedOverGround'), 'Speed over ground');
    assert.equal(describePath('navigation.position'), 'Navigation position');
    assert.equal(describePath('electrical.batteries.house.voltage'), 'House battery voltage');
    assert.equal(describePath('propulsion.main.temperature'), 'Main engine temperature');
    assert.equal(describePath('electrical.charger.powerOut'), 'Charger output power');
    assert.equal(describePath('electrical.shore.pluggedIn'), 'Shore plugged in');
  });

  it('prefers the path\'s own display name, and still knows its system', () => {
    assert.deepEqual(describePathParts('propulsion.main.temperature', 'Engine temp'), { name: 'Engine temp', system: 'main engine', part: 'Engine temp' });
    assert.equal(narrate('shift', { path: 'propulsion.main.temperature', units: 'K', displayName: 'Engine temp' }, OWNER.cpu[2]).title, 'Engine temp higher than usual');
    assert.deepEqual(describePathParts('navigation.underKeel.state'), { name: 'Under-keel state', system: 'under-keel', part: 'state' });
  });
});

describe('finding text: numbers rounded to what matters', () => {
  it('reads the owner\'s incident in plain words', () => {
    assert.equal(say('memory').title, 'Nano memory use higher than usual');
    assert.equal(say('memory').message, '87 %, usually 72 % – clearly outside its normal range');
    assert.equal(say('dcdc').title, 'Victron DC-DC input voltage lower than usual');
    assert.equal(say('dcdc').message, '13.3 V, usually 13.8 V – far outside its normal range');
    assert.equal(say('dcdc').brief, '13.3 V, usually 13.8 V', 'the short form, for a line about it once it is over');
    assert.equal(say('sd').message, '30 %, usually 29 % – clearly outside its normal range');
    assert.equal(say('memoryLow').message, '72 %, usually 79 % – a little outside its normal range');
    assert.equal(say('fps').message, '12.0 frames/s, usually 12.1 frames/s – a little outside its normal range');
    assert.equal(
      say('cpu').message,
      '53 °C, usually 51 °C – a little outside its normal range. It has risen like this 8 times in the past 15 h, for up to 11 min each; this one is no bigger than those'
    );
    for (const key of Object.keys(OWNER)) {
      const text = say(key);
      assert.doesNotMatch(`${text.title} ${text.message}`, /normal variation|from its usual|×/, key);
    }
  });

  it('keeps the exact figures in the detail', () => {
    assert.equal(say('dcdc').detail, '13.30 V, −0.54 V from its usual 13.84 V (10.8× its normal variation)');
    assert.equal(say('fps').detail, '11.96 Hz, −2.55 Hz from its usual 12.09 Hz (4.0× its normal variation), changing −3.79 Hz/min');
    assert.match(say('clearance').detail, /^No reading for 20\.6 h: the sensor is sending "no value" \(null\)/);
  });

  it('says the rate only while the reading is still moving away from normal', () => {
    // The camera's frame rate was back near normal: its steep slope was the way back.
    assert.doesNotMatch(say('fps').message, /changing/);
    const ramp = narrate('shift', { path: 'electrical.batteries.house.temperature', units: 'K' }, {
      value: KELVIN + 34,
      baseline: KELVIN + 25,
      delta: 6,
      z: 12,
      slopePerMinute: 0.5
    });
    assert.equal(ramp.message, '34 °C, usually 25 °C – far outside its normal range, still changing +0.5 °C/min');
  });

  it('shows a share as a percentage only when it is one', () => {
    assert.match(narrate('shift', { path: 'environment.nano.cpuUtilisation' }, { value: 87, baseline: 40, delta: 47, z: 8 }).message, /^87, usually 40 /);
    assert.match(narrate('shift', { path: 'electrical.batteries.house.stateOfCharge', units: 'ratio' }, { value: 0.5, baseline: 0.8, delta: -0.3, z: -8 }).message, /^50 %, usually 80 %/);
  });

  it('adds a decimal only where the rounding would hide what was measured', () => {
    assert.equal(plainDecimals('a.voltage', 'V', 0.02, [12.81, 12.83]), 2);
    assert.equal(plainDecimals('a.level', 'ratio', 0.001, [0.871, 0.874]), 1);
    assert.equal(formatPlain('a.level', 0.871, 'ratio', 1), '87.1 %');
    assert.equal(plainDecimals('a.temperature', 'K', 2.7, [KELVIN + 53.4, KELVIN + 50.7]), 0);
    assert.equal(plainDuration(20.6 * HOUR), '21 h');
    assert.equal(plainDuration(47 * MINUTE), '47 min');
  });
});

describe('finding text: states and silences', () => {
  it('says what a new state replaced, and that a sensor sends no data', () => {
    assert.equal(say('state').title, 'Under-keel state now reads "unknown"');
    assert.equal(say('state').message, 'Before only "alarm" or "off"');
    assert.equal(say('clearance').title, 'Under-keel clearance sending no data');
    assert.equal(say('clearance').message, 'It normally updates every 10 s (source signalk-underkeel)');
    assert.equal(say('clearance').kind, 'noData');
    assert.equal(say('clearance').ago, 20.6 * HOUR);
  });

  it('counts switches in an hour against the usual rate', () => {
    assert.equal(say('switching').title, 'Remote controller plugin hh live switching unusually often');
    assert.equal(say('switching').message, '4 switches in the last hour, normally under 1 an hour');
    assert.equal(say('switching').system, 'remote controller');
    assert.equal(say('switching').kind, 'switching');
  });
});
