'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHistoryConfig } = require('../lib/history-service.cjs');
const { normalizeWatchConfig } = require('../lib/watch/engine.cjs');
const {
  DOCS_URL,
  SECTIONS,
  TOP_LEVEL_KEYS,
  migrateSettings,
  readSettings,
  settingsSchema,
  settingsUiSchema
} = require('../lib/settings.cjs');

/** Options as the admin page stores them once the form is saved with everything changed. */
const NESTED = Object.freeze({
  watchEnabled: true,
  alerts: { watchNotifications: false, watchSound: true },
  watching: {
    watchSensitivity: 'high',
    watchLearningMinutes: 45,
    watchDefaultExclusions: false,
    watchExcludePaths: ['environment.inside'],
    watchCounterPaths: ['plugins.example.pulses']
  },
  ruleAssist: { ruleAssistEnabled: true, ollamaUrl: 'http://gpu.local:11434', ruleAssistModel: 'gemma3:1b' },
  replay: { historyServerUrl: 'http://nas.local:3000', historyApiKey: 'k', historyProvider: 'signalk-parquet', historyTimeoutMs: 60000 },
  advanced: { watchMaxPaths: 200 },
  watchRules: []
});

/** The same settings as every version before the sections stored them. */
const FLAT = Object.freeze({
  watchEnabled: true,
  watchNotifications: false,
  watchSound: true,
  watchSensitivity: 'high',
  watchLearningMinutes: 45,
  watchDefaultExclusions: false,
  watchExcludePaths: ['environment.inside'],
  watchCounterPaths: ['plugins.example.pulses'],
  ollamaUrl: 'http://gpu.local:11434',
  ruleAssistModel: 'gemma3:1b',
  historyServerUrl: 'http://nas.local:3000',
  historyApiKey: 'k',
  historyProvider: 'signalk-parquet',
  historyTimeoutMs: 60000,
  watchMaxPaths: 200,
  watchRules: []
});

/** A form field's schema, wherever it is: a section's properties or its "on" branch. */
function fieldsOf(section) {
  const fields = { ...section.properties };
  for (const dependency of Object.values(section.dependencies || {})) {
    for (const branch of dependency.oneOf || []) {
      for (const [name, field] of Object.entries(branch.properties)) {
        if (!(name in fields)) fields[name] = field;
      }
    }
  }
  return fields;
}

describe('readSettings', () => {
  it('flattens the sections into the keys the plugin reads', () => {
    assert.deepEqual(readSettings(NESTED), FLAT);
  });

  it('reads settings stored flat, from before the sections, unchanged', () => {
    assert.deepEqual(readSettings(FLAT), FLAT);
  });

  it('takes a section over a flat key, and a flat key where the section has none', () => {
    const settings = readSettings({
      ...FLAT,
      watching: { watchSensitivity: 'low' },
      replay: { historyServerUrl: '' }
    });
    assert.equal(settings.watchSensitivity, 'low');
    // Blank in the section is a setting, not a gap: the flat URL is not used.
    assert.equal(settings.historyServerUrl, '');
    assert.equal(settings.watchLearningMinutes, 45);
    assert.equal(settings.historyProvider, 'signalk-parquet');
  });

  it('leaves out what is set nowhere, so the normalisers and environment variables still apply', () => {
    assert.deepEqual(readSettings({}), { ruleAssistModel: '' });
    assert.deepEqual(readSettings(undefined), { ruleAssistModel: '' });
    assert.deepEqual(readSettings({ alerts: 'not a section', watching: null }), { ruleAssistModel: '' });
    const history = normalizeHistoryConfig(readSettings({ replay: {} }), { SIGNALK_WATCHKEEPER_HISTORY_TIMEOUT_MS: '90000' });
    assert.equal(history.historyTimeoutMs, 90000);
  });

  it('turns on help from a model only with the switch on and a model named', () => {
    const assist = (ruleAssist) => readSettings({ ruleAssist }).ruleAssistModel;
    assert.equal(assist({ ruleAssistEnabled: true, ruleAssistModel: ' qwen3:0.6b ' }), 'qwen3:0.6b');
    // Switched off with the fields' values kept, as the form leaves them.
    assert.equal(assist({ ruleAssistEnabled: false, ruleAssistModel: 'qwen3:0.6b' }), '');
    assert.equal(assist({ ruleAssistEnabled: true, ruleAssistModel: '  ' }), '');
    assert.equal(assist({ ruleAssistEnabled: true }), '');
    // A switch stored as anything but true is off.
    assert.equal(assist({ ruleAssistEnabled: 'yes', ruleAssistModel: 'qwen3:0.6b' }), '');
    // From before the switch: a model named is on.
    assert.equal(readSettings({ ruleAssistModel: 'qwen3:0.6b' }).ruleAssistModel, 'qwen3:0.6b');
    assert.equal(readSettings({ ruleAssistModel: '' }).ruleAssistModel, '');
    // A switch in the section turns off a flat model left behind.
    assert.equal(readSettings({ ruleAssistModel: 'qwen3:0.6b', ruleAssist: { ruleAssistEnabled: false } }).ruleAssistModel, '');
    assert.equal('ruleAssistEnabled' in readSettings(NESTED), false);
  });

  it('gives the watch and the history client what the flat settings gave them', () => {
    const watch = normalizeWatchConfig(readSettings(NESTED));
    assert.deepEqual(watch, normalizeWatchConfig(FLAT));
    assert.equal(watch.watchSensitivity, 'high');
    assert.equal(watch.ollamaUrl, 'http://gpu.local:11434');
    assert.equal(watch.ruleAssistModel, 'gemma3:1b');
    assert.deepEqual(normalizeHistoryConfig(readSettings(NESTED), {}), normalizeHistoryConfig(FLAT, {}));
    // Read twice, the same: the plugin may hand flat settings on.
    assert.deepEqual(readSettings(readSettings(NESTED)), readSettings(NESTED));
    assert.deepEqual(readSettings(readSettings({ ruleAssist: { ruleAssistEnabled: false, ruleAssistModel: 'x' } })).ruleAssistModel, '');
  });

  it('does not change the options it reads', () => {
    const options = JSON.parse(JSON.stringify(NESTED));
    readSettings(options);
    assert.deepEqual(options, NESTED);
  });
});

/**
 * What the admin page's form does with stored options before they are
 * saved: fill each field it shows and that has no value with its default
 * (react-jsonschema-form's getDefaultFormState, for this schema's shape).
 * Fields a switch hides are not filled; keys it does not know are kept.
 */
function fillFormDefaults(schema, options) {
  const filled = { ...options };
  for (const [key, field] of Object.entries(schema.properties)) {
    if (field.type !== 'object') {
      if (filled[key] === undefined) filled[key] = field.default;
      continue;
    }
    const section = { ...(filled[key] || {}) };
    for (const [name, sub] of Object.entries(field.properties)) {
      if (section[name] === undefined) section[name] = sub.default;
    }
    for (const [switchKey, dependency] of Object.entries(field.dependencies || {})) {
      const branch = dependency.oneOf.find((item) => item.properties[switchKey].enum.includes(section[switchKey]));
      for (const [name, sub] of Object.entries(branch ? branch.properties : {})) {
        if (name !== switchKey && section[name] === undefined) section[name] = sub.default;
      }
    }
    filled[key] = section;
  }
  return filled;
}

describe('migrateSettings', () => {
  const FLAT_KEYS = Object.values(SECTIONS).flat().filter((key) => key !== 'ruleAssistEnabled');

  it('moves every setting stored flat into its section, with the same value, and drops the flat key', () => {
    const { options, moved, kept } = migrateSettings(FLAT);
    assert.deepEqual(options, NESTED);
    assert.deepEqual([...moved].sort(), [...FLAT_KEYS].sort());
    assert.deepEqual(kept, []);
    for (const key of FLAT_KEYS) assert.equal(key in options, false, key);
    assert.deepEqual(readSettings(options), readSettings(FLAT));
    assert.deepEqual(normalizeWatchConfig(readSettings(options)), normalizeWatchConfig(FLAT));
    assert.deepEqual(normalizeHistoryConfig(readSettings(options), {}), normalizeHistoryConfig(FLAT, {}));
  });

  it('turns a flat model into the AI help switch: on with the model, off without one', () => {
    assert.deepEqual(migrateSettings({ ruleAssistModel: 'qwen3:0.6b' }).options, {
      ruleAssist: { ruleAssistModel: 'qwen3:0.6b', ruleAssistEnabled: true }
    });
    // A blank model was "off": the switch says so, and the blank is dropped,
    // so switching on later offers the default model.
    for (const blank of ['', '  ']) {
      assert.deepEqual(migrateSettings({ ruleAssistModel: blank, ollamaUrl: 'http://gpu.local:11434' }).options, {
        ruleAssist: { ollamaUrl: 'http://gpu.local:11434', ruleAssistEnabled: false }
      });
    }
    // A switch already in the section stays as it is.
    assert.deepEqual(migrateSettings({ ruleAssistModel: 'qwen3:0.6b', ruleAssist: { ruleAssistEnabled: false } }).options, {
      ruleAssist: { ruleAssistEnabled: false, ruleAssistModel: 'qwen3:0.6b' }
    });
    // A model already in the section, with the address still flat: the
    // switch is set from it, so the form does not show the help as off
    // (CodeRabbit's review of 220b520).
    assert.deepEqual(
      migrateSettings({ ollamaUrl: 'http://gpu.local:11434', ruleAssist: { ruleAssistModel: 'gemma3:1b' } }).options,
      { ruleAssist: { ruleAssistModel: 'gemma3:1b', ollamaUrl: 'http://gpu.local:11434', ruleAssistEnabled: true } }
    );
    // The same with nothing flat at all.
    assert.deepEqual(migrateSettings({ ruleAssist: { ruleAssistModel: 'gemma3:1b' } }).options, {
      ruleAssist: { ruleAssistModel: 'gemma3:1b', ruleAssistEnabled: true }
    });
    assert.deepEqual(migrateSettings({ ruleAssist: { ruleAssistModel: '' } }).options, {
      ruleAssist: { ruleAssistModel: '', ruleAssistEnabled: false }
    });
    // A switch the form stored is left alone.
    const switched = { ruleAssist: { ruleAssistEnabled: false, ruleAssistModel: 'gemma3:1b' } };
    assert.equal(migrateSettings(switched).options, switched);
    // No flat model, no switch added.
    assert.deepEqual(migrateSettings({ ollamaUrl: 'http://gpu.local:11434' }).options, {
      ruleAssist: { ollamaUrl: 'http://gpu.local:11434' }
    });
    // Read the same, every one of them.
    for (const stored of [
      { ruleAssistModel: 'qwen3:0.6b' },
      { ruleAssistModel: '' },
      { ruleAssistModel: 'qwen3:0.6b', ruleAssist: { ruleAssistEnabled: false } },
      { ruleAssistModel: 'a', ruleAssist: { ruleAssistModel: 'b' } },
      { ruleAssistModel: 'a', ruleAssist: { ruleAssistModel: '' } },
      { ollamaUrl: 'http://gpu.local:11434', ruleAssist: { ruleAssistModel: 'gemma3:1b' } },
      { ruleAssist: { ruleAssistModel: 'gemma3:1b' } }
    ]) {
      assert.deepEqual(readSettings(migrateSettings(stored).options), readSettings(stored), JSON.stringify(stored));
    }
  });

  it('keeps a value already in the section over the flat one', () => {
    const { options, moved, kept } = migrateSettings({
      watchSensitivity: 'high',
      watchMaxPaths: 200,
      watching: { watchSensitivity: 'low' }
    });
    assert.deepEqual(options, { watching: { watchSensitivity: 'low' }, advanced: { watchMaxPaths: 200 } });
    assert.deepEqual(moved, ['watchMaxPaths']);
    assert.deepEqual(kept, ['watchSensitivity']);
  });

  it('changes nothing, and gives the same object back, when nothing is flat', () => {
    for (const stored of [NESTED, {}, { watchEnabled: true, watchRules: [] }, { watching: {}, somethingElse: 1 }]) {
      const result = migrateSettings(stored);
      assert.equal(result.options, stored);
      assert.deepEqual(result.moved, []);
    }
    const once = migrateSettings(FLAT).options;
    assert.equal(migrateSettings(once).options, once);
  });

  it('keeps the switch, the watch rules and keys it does not know where they are', () => {
    const rules = [{ id: 'r' }];
    const { options } = migrateSettings({ watchEnabled: false, watchRules: rules, futureKey: 1, watchSound: true });
    assert.deepEqual(options, { watchEnabled: false, watchRules: rules, futureKey: 1, alerts: { watchSound: true } });
  });

  it('loses no value: a section stored as something else is left alone, with its flat keys', () => {
    const { options, moved } = migrateSettings({ watching: 'not a section', watchSensitivity: 'high', watchMaxPaths: 200 });
    assert.deepEqual(options, { watching: 'not a section', watchSensitivity: 'high', advanced: { watchMaxPaths: 200 } });
    assert.deepEqual(moved, ['watchMaxPaths']);
    assert.equal(readSettings(options).watchSensitivity, 'high');
  });

  it('does not change the options it is given', () => {
    const stored = JSON.parse(JSON.stringify({ ...FLAT, watching: { watchSensitivity: 'low' } }));
    const copy = JSON.parse(JSON.stringify(stored));
    migrateSettings(stored);
    assert.deepEqual(stored, copy);
  });

  it('leaves nothing for the form to fill over a stored value on its first save', () => {
    const schema = settingsSchema();
    const before = fillFormDefaults(schema, FLAT);
    assert.notDeepEqual(readSettings(before), readSettings(FLAT));
    for (const stored of [FLAT, { ...FLAT, ruleAssistModel: '' }]) {
      const after = fillFormDefaults(schema, migrateSettings(stored).options);
      assert.deepEqual(readSettings(after), readSettings(stored));
    }
  });
});

describe('the settings form', () => {
  const schema = settingsSchema();

  it('starts with the switch, then the sections in order', () => {
    assert.deepEqual(Object.keys(schema.properties), ['watchEnabled', ...Object.keys(SECTIONS)]);
    assert.deepEqual(Object.keys(SECTIONS), ['alerts', 'watching', 'ruleAssist', 'replay', 'advanced']);
    assert.equal(schema.properties.watchEnabled.type, 'boolean');
    assert.equal(schema.properties.watchEnabled.default, false);
    assert.equal(schema.properties.watchEnabled.title, 'Turn on Watchkeeper');
    assert.match(schema.description, /Only the first switch is needed/);
    assert.ok(schema.description.includes(DOCS_URL));
    const titles = Object.keys(SECTIONS).map((key) => schema.properties[key].title);
    assert.deepEqual(titles, [
      'Alerts',
      'What to watch',
      'Rules in your own words – optional AI help',
      'Replay from history – optional',
      'Advanced'
    ]);
  });

  it('holds every setting readSettings reads, in its section, with a title, a short description and a default', () => {
    const formKeys = [];
    for (const [key, keys] of Object.entries(SECTIONS)) {
      const section = schema.properties[key];
      assert.equal(section.type, 'object', key);
      assert.ok(section.description, `${key} has a description`);
      const fields = fieldsOf(section);
      assert.deepEqual(Object.keys(fields).sort(), [...keys].sort(), key);
      for (const [name, field] of Object.entries(fields)) {
        formKeys.push(name);
        assert.ok(field.title, `${name} has a title`);
        assert.ok('default' in field, `${name} has a default`);
        assert.ok(field.description, `${name} has a description`);
        const sentences = field.description.split(/[.!?](?:\s|$)/).filter((part) => part.trim());
        assert.ok(sentences.length <= 2, `${name}: at most two sentences`);
      }
    }
    assert.deepEqual(TOP_LEVEL_KEYS, ['watchEnabled', 'watchRules']);
    assert.equal(formKeys.length, 15);
    // Everything the plugin reads from the form, it reads through readSettings.
    for (const key of formKeys.filter((name) => name !== 'ruleAssistEnabled')) {
      assert.ok(key in FLAT, key);
    }
  });

  it('offers the sensitivities by friendly names, keeping the stored values', () => {
    const sensitivity = schema.properties.watching.properties.watchSensitivity;
    assert.deepEqual(
      sensitivity.oneOf.map((option) => [option.const, option.title]),
      [
        ['low', 'Calm – fewer alerts'],
        ['normal', 'Normal'],
        ['high', 'Sharp – more alerts']
      ]
    );
    assert.equal(sensitivity.default, 'normal');
  });

  it('shows the Ollama server and the model only once the AI help is switched on', () => {
    const section = schema.properties.ruleAssist;
    assert.deepEqual(Object.keys(section.properties), ['ruleAssistEnabled']);
    assert.equal(section.properties.ruleAssistEnabled.default, false);
    assert.match(section.description, /without any AI/);
    assert.match(section.properties.ruleAssistEnabled.description, /not included/);
    const [off, on] = section.dependencies.ruleAssistEnabled.oneOf;
    assert.deepEqual(off, { properties: { ruleAssistEnabled: { enum: [false] } } });
    assert.deepEqual(on.properties.ruleAssistEnabled, { enum: [true] });
    assert.equal(on.properties.ollamaUrl.default, 'http://localhost:11434');
    assert.equal(on.properties.ollamaUrl.title, 'Ollama server address');
    assert.equal(on.properties.ruleAssistModel.default, 'qwen3:0.6b');
    assert.match(on.properties.ruleAssistModel.description, /two minutes/);
  });

  it('is plain JSON, as the server stores it and plugin-ci checks it', () => {
    const problems = [];
    const walk = (node, path) => {
      if (node === null) return;
      if (typeof node === 'function' || typeof node === 'symbol') problems.push(`${path} is a ${typeof node}`);
      if (typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (value === undefined) problems.push(`${path}.${key} is undefined`);
        else walk(value, `${path}.${key}`);
      }
    };
    walk(schema, 'schema');
    walk(settingsUiSchema(), 'uiSchema');
    assert.deepEqual(problems, []);
    assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema);
  });

  it('orders only properties the form has, masks the API key and shows what blank means', () => {
    const ui = settingsUiSchema();
    assert.deepEqual(ui['ui:order'], ['watchEnabled', 'alerts', 'watching', 'ruleAssist', 'replay', 'advanced', '*']);
    for (const [section, entries] of Object.entries(ui).filter(([key]) => !key.startsWith('ui:'))) {
      const fields = fieldsOf(schema.properties[section]);
      for (const name of Object.keys(entries)) assert.ok(name in fields, `${section}.${name} is in the form`);
    }
    assert.equal(ui.replay.historyApiKey['ui:widget'], 'password');
    assert.ok(ui.replay.historyServerUrl['ui:placeholder']);
    assert.equal(ui.ruleAssist.ollamaUrl['ui:placeholder'], 'http://localhost:11434');
  });
});
