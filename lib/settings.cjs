'use strict';

const { DEFAULT_HISTORY_TIMEOUT_MS } = require('./history-service.cjs');

/**
 * The plugin's settings: the form the Signal K admin page shows, and the one
 * function that reads what that form stores.
 *
 * The form is grouped into sections (nested objects, which the admin page's
 * react-jsonschema-form renders as titled fieldsets). The rest of the plugin
 * - normalizeWatchConfig, normalizeHistoryConfig, the watch service - reads
 * one flat object with the long-standing keys (`watchSensitivity`,
 * `historyServerUrl`, ...), and readSettings() makes that object. Inside a
 * section the keys keep those names, so a key means the same thing wherever
 * it is written, and settings stored flat (as every version before the
 * sections did) still read.
 */

const DOCS_URL = 'https://github.com/KEGustafsson/signalk-watchkeeper/blob/main/docs/watchkeeper.md';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_RULE_ASSIST_MODEL = 'qwen3:0.6b';

/** Which keys each section of the form holds, in the form's order. */
const SECTIONS = Object.freeze({
  alerts: Object.freeze(['watchNotifications', 'watchSound']),
  watching: Object.freeze([
    'watchSensitivity',
    'watchLearningMinutes',
    'watchDefaultExclusions',
    'watchExcludePaths',
    'watchCounterPaths'
  ]),
  ruleAssist: Object.freeze(['ruleAssistEnabled', 'ollamaUrl', 'ruleAssistModel']),
  replay: Object.freeze(['historyServerUrl', 'historyApiKey', 'historyProvider', 'historyTimeoutMs']),
  advanced: Object.freeze(['watchMaxPaths'])
});

/**
 * Keys outside every section: the on/off switch, and the watch rules, which
 * the panel writes and the form does not show.
 */
const TOP_LEVEL_KEYS = Object.freeze(['watchEnabled', 'watchRules']);

/**
 * What the form calls a setting, for a message that tells the operator which
 * one to change: the section, then the field.
 */
const SETTING_LABELS = Object.freeze({
  watchEnabled: 'Turn on Watchkeeper',
  ollamaUrl: 'Rules in your own words → Ollama server address'
});

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The flat settings the rest of the plugin reads, from the options Signal K
 * stored.
 *
 * Each key is read from its section, and from the top level when the section
 * does not have it (settings stored before the sections existed). A key given
 * nowhere is left out, so the normaliser's own default - or an environment
 * variable that stands in for a blank setting - still applies.
 *
 * Help from a model counts as on only when its switch is on and a model is
 * named. Settings from before the switch existed have no switch: for them a
 * model named is on, as it always was. Off is a blank `ruleAssistModel`, which
 * is what the watch service reads as "the built-in reader only".
 */
function readSettings(options) {
  const source = isPlainObject(options) ? options : {};
  const flat = {};
  for (const key of TOP_LEVEL_KEYS) {
    if (source[key] !== undefined) flat[key] = source[key];
  }
  for (const [section, keys] of Object.entries(SECTIONS)) {
    const nested = isPlainObject(source[section]) ? source[section] : {};
    for (const key of keys) {
      const value = nested[key] !== undefined ? nested[key] : source[key];
      if (value !== undefined) flat[key] = value;
    }
  }

  const { ruleAssistEnabled, ...settings } = flat;
  const model = typeof settings.ruleAssistModel === 'string' ? settings.ruleAssistModel.trim() : '';
  const switchedOn = ruleAssistEnabled === undefined || ruleAssistEnabled === true;
  settings.ruleAssistModel = switchedOn ? model : '';
  return settings;
}

/**
 * The options with every setting still stored flat moved into its section.
 *
 * The admin page shows only what the sections hold, so settings an earlier
 * version stored flat would appear as the defaults, and the first save of the
 * form would put those defaults over them. Moving them once, on start, makes
 * the form show the values the plugin runs on. Until then - and a plugin that
 * is off is not started - settingsSchema() shows them as its defaults.
 *
 * A value already in the section wins over the flat one (it is the newer: the
 * form wrote it), and the flat key goes either way. The switch, the watch
 * rules and any key this plugin does not know are kept as they are. A section
 * stored as something other than an object is left alone, with its flat keys,
 * rather than overwritten. Nothing is changed in place.
 *
 * Before the AI help had a switch, a model named meant on and a blank one
 * off. A `ruleAssistModel` - flat, or already in the section - therefore
 * also sets the switch when none is stored: on with the model, or off - and a
 * blank flat model is dropped,
 * so that switching on later offers the default model rather than a blank
 * field. readSettings() reads the result exactly as it read the flat options.
 *
 * Returns { options, moved, kept }: `moved` lists the flat keys whose value
 * went into a section, `kept` the flat keys dropped because the section had a
 * value of its own. With nothing flat, `options` is the object given, so a
 * caller can tell "nothing to do" by identity.
 */
function migrateSettings(options) {
  const source = isPlainObject(options) ? options : {};
  const moved = [];
  const kept = [];
  let result;
  for (const [section, keys] of Object.entries(SECTIONS)) {
    const flatKeys = keys.filter((key) => source[key] !== undefined);
    if (source[section] !== undefined && !isPlainObject(source[section])) continue;
    const stored = isPlainObject(source[section]) ? source[section] : {};
    // A model named, flat or already in the section, with no switch stored:
    // the form would show the switch off, and its first save would turn the
    // AI help off, though the plugin runs with it on.
    const switchMissing =
      section === 'ruleAssist' &&
      stored.ruleAssistEnabled === undefined &&
      source.ruleAssistEnabled === undefined &&
      (flatKeys.includes('ruleAssistModel') || stored.ruleAssistModel !== undefined);
    if (flatKeys.length === 0 && !switchMissing) continue;
    result = result || { ...source };
    const nested = { ...(isPlainObject(source[section]) ? source[section] : {}) };
    for (const key of flatKeys) {
      if (nested[key] === undefined) {
        nested[key] = source[key];
        moved.push(key);
      } else {
        kept.push(key);
      }
      delete result[key];
    }
    if (switchMissing && nested.ruleAssistEnabled === undefined) {
      const model = typeof nested.ruleAssistModel === 'string' ? nested.ruleAssistModel.trim() : '';
      nested.ruleAssistEnabled = model.length > 0;
      if (!model && moved.includes('ruleAssistModel')) delete nested.ruleAssistModel;
    }
    result[section] = nested;
  }
  return { options: result || options, moved, kept };
}

/**
 * The values the form should show for settings still stored flat: for each
 * section, what migrateSettings() would put there that the stored section
 * does not hold yet. Empty when nothing is flat.
 */
function storedValues(options) {
  if (!isPlainObject(options)) return {};
  const migrated = migrateSettings(options).options;
  if (migrated === options) return {};
  const values = {};
  for (const [section, keys] of Object.entries(SECTIONS)) {
    if (!isPlainObject(migrated[section])) continue;
    const before = isPlainObject(options[section]) ? options[section] : {};
    for (const key of keys) {
      if (migrated[section][key] !== undefined && before[key] === undefined) {
        values[section] = values[section] || {};
        values[section][key] = migrated[section][key];
      }
    }
  }
  return values;
}

/**
 * Whether the form can take `value` as the field's default: the field's type,
 * and its choices or range where it has them. A default the form rejects
 * would stop it from being saved at all.
 */
function fitsField(field, value) {
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') return false;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return false;
      break;
    case 'integer':
      if (!Number.isInteger(value)) return false;
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      break;
    case 'array':
      if (!Array.isArray(value) || !value.every((item) => fitsField(field.items || {}, item))) return false;
      break;
    default:
      return false;
  }
  if (Array.isArray(field.enum) && !field.enum.includes(value)) return false;
  if (Array.isArray(field.oneOf) && !field.oneOf.some((option) => option.const === value)) return false;
  if (typeof field.minimum === 'number' && value < field.minimum) return false;
  if (typeof field.maximum === 'number' && value > field.maximum) return false;
  return true;
}

/** Added to a field whose flat value the form cannot take. */
const STORED_VALUE_NOT_SHOWN =
  'The value an earlier version saved here is not one this field takes, so the default is shown instead.';

/**
 * The settings form, as JSON Schema (draft-07) for the admin page.
 *
 * Given the options Signal K stored, the form also shows the settings an
 * earlier version stored flat. The admin page fills each field the stored
 * sections leave empty with the field's default, and a save stores what it
 * filled in - over the flat value, since readSettings() prefers the section.
 * start() moves flat settings into their sections, but a plugin that is off
 * is never started. So each such setting becomes its field's default here,
 * and the form shows it, and a save stores it, while the plugin is off too.
 * So does the AI help switch the move sets from a model named without one.
 * A value the field does not take (outside its range or choices, or of the
 * wrong type) keeps the field's own default, with a note saying so. Without
 * options, or with nothing flat, the form is the same as always.
 */
function settingsSchema(stored) {
  const schema = formSchema();
  for (const [section, values] of Object.entries(storedValues(stored))) {
    const sectionSchema = schema.properties[section];
    const branches = Object.values(sectionSchema.dependencies || {}).flatMap((dependency) => dependency.oneOf || []);
    for (const properties of [sectionSchema.properties, ...branches.map((branch) => branch.properties || {})]) {
      for (const [key, value] of Object.entries(values)) {
        const field = properties[key];
        if (!field || !('default' in field)) continue;
        if (fitsField(field, value)) {
          field.default = JSON.parse(JSON.stringify(value));
        } else {
          field.description = `${field.description} ${STORED_VALUE_NOT_SHOWN}`;
        }
      }
    }
  }
  return schema;
}

function formSchema() {
  return {
    type: 'object',
    title: 'Watchkeeper',
    description:
      'Watchkeeper learns how each reading on your boat normally behaves and tells you when one departs from it: ' +
      'a sensor that freezes or goes quiet, a temperature creeping up, a pump running more often than usual. ' +
      'Only the first switch is needed – everything below has working defaults and can be left as it is. ' +
      `How it works, and every setting in detail: ${DOCS_URL}`,
    properties: {
      watchEnabled: {
        type: 'boolean',
        title: 'Turn on Watchkeeper',
        description:
          'Start learning what is normal on this boat and watching for anything unusual. An extra pair of eyes, not a replacement for real alarms.',
        default: false
      },
      alerts: {
        type: 'object',
        title: 'Alerts',
        description: 'How Watchkeeper tells you about something unusual.',
        properties: {
          watchNotifications: {
            type: 'boolean',
            title: 'Send alerts as Signal K notifications',
            description:
              'Shown by any app that shows Signal K notifications. Watchkeeper only warns or alerts – it never raises an alarm or emergency.',
            default: true
          },
          watchSound: {
            type: 'boolean',
            title: 'Sound on serious alerts',
            description: 'Asks your displays to sound for alert-level findings. Warnings stay silent.',
            default: false
          }
        }
      },
      watching: {
        type: 'object',
        title: 'What to watch',
        description: 'How sharp the watch is, and which readings it leaves alone.',
        properties: {
          watchSensitivity: {
            type: 'string',
            title: 'Sensitivity',
            description:
              'How far from normal a reading must move before you are told. Start at Normal; the replay in the panel shows what a change would have raised.',
            oneOf: [
              { const: 'low', title: 'Calm – fewer alerts' },
              { const: 'normal', title: 'Normal' },
              { const: 'high', title: 'Sharp – more alerts' }
            ],
            default: 'normal'
          },
          watchLearningMinutes: {
            type: 'integer',
            title: 'Learning period (minutes)',
            description:
              'How long a new reading is observed before it can raise anything. What is learned is kept across restarts.',
            default: 30,
            minimum: 1,
            maximum: 1440
          },
          watchDefaultExclusions: {
            type: 'boolean',
            title: 'Skip readings that move with the helm, wind and seabed',
            description:
              'Heading, speed, wind, depth and the like change all the time, so they are not watched. Position is still checked.',
            default: true
          },
          watchExcludePaths: {
            type: 'array',
            title: 'Also skip these paths',
            description: 'Signal K paths, or patterns, to leave alone.',
            items: { type: 'string' },
            default: []
          },
          watchCounterPaths: {
            type: 'array',
            title: 'Counters under other names',
            description:
              'Paths that only count up, such as engine hours or energy used, under names of their own. The usual names are recognised already.',
            items: { type: 'string' },
            default: []
          }
        }
      },
      ruleAssist: {
        type: 'object',
        title: 'Rules in your own words – optional AI help',
        description:
          'In the panel you can write a watch in plain words, such as "tell me if the coolant goes above 95". ' +
          'The built-in reader handles that without any AI; turn this on only if you want a small AI model to try the wordings it cannot read.',
        properties: {
          ruleAssistEnabled: {
            type: 'boolean',
            title: "Use a small AI model for wordings the built-in reader can't handle",
            description:
              'Needs Ollama, which is not included: install and run it separately. Every answer is shown to you to confirm before it is saved.',
            default: false
          }
        },
        dependencies: {
          ruleAssistEnabled: {
            oneOf: [
              { properties: { ruleAssistEnabled: { enum: [false] } } },
              {
                properties: {
                  ruleAssistEnabled: { enum: [true] },
                  ollamaUrl: {
                    type: 'string',
                    title: 'Ollama server address',
                    description: 'Where Ollama runs. Blank means this machine.',
                    default: DEFAULT_OLLAMA_URL
                  },
                  ruleAssistModel: {
                    type: 'string',
                    title: 'Model',
                    description:
                      'A small model you have pulled into Ollama, such as qwen3:0.6b or gemma3:1b. It is unloaded two minutes after use.',
                    default: DEFAULT_RULE_ASSIST_MODEL
                  }
                }
              }
            ]
          }
        }
      },
      replay: {
        type: 'object',
        title: 'Replay from history – optional',
        description:
          "The panel's replay runs the watch over recorded data to show what it would have raised. It needs a history plugin such as signalk-parquet.",
        properties: {
          historyServerUrl: {
            type: 'string',
            title: 'History server address',
            description: 'Leave blank to use this Signal K server. Set it only for history kept on another one.',
            default: ''
          },
          historyApiKey: {
            type: 'string',
            title: 'History API key',
            description: 'Only for a history server other than this one. Leave blank otherwise.',
            default: ''
          },
          historyProvider: {
            type: 'string',
            title: 'History provider',
            description: 'The plugin id of one provider, such as signalk-parquet. Blank uses the server default.',
            default: ''
          },
          historyTimeoutMs: {
            type: 'integer',
            title: 'Wait per request (ms)',
            description: 'How long each history request may take. Anything under 30000 counts as 30000.',
            default: DEFAULT_HISTORY_TIMEOUT_MS,
            minimum: 0,
            maximum: 120000
          }
        }
      },
      advanced: {
        type: 'object',
        title: 'Advanced',
        description: 'Limits you rarely need to change.',
        properties: {
          watchMaxPaths: {
            type: 'integer',
            title: 'Most paths to watch',
            description: 'Caps memory and CPU use. Paths beyond it are counted in the panel but not watched.',
            default: 1500,
            minimum: 10,
            maximum: 10000
          }
        }
      }
    }
  };
}

/**
 * How the admin page shows the form: the sections in order, examples in the
 * fields where blank means a default, and the API key masked - an ordinary
 * text input would show the token in cleartext on every page load.
 */
function settingsUiSchema() {
  return {
    'ui:order': ['watchEnabled', ...Object.keys(SECTIONS), '*'],
    watching: {
      watchExcludePaths: {
        'ui:help': 'For example environment.inside, propulsion.*.exhaustTemperature or **.signalStrength: * matches one part of a path, ** any number of parts.',
        items: { 'ui:placeholder': 'environment.inside' }
      },
      watchCounterPaths: {
        items: { 'ui:placeholder': 'plugins.example.pulseCount' }
      }
    },
    ruleAssist: {
      ollamaUrl: { 'ui:placeholder': DEFAULT_OLLAMA_URL },
      ruleAssistModel: { 'ui:placeholder': DEFAULT_RULE_ASSIST_MODEL }
    },
    replay: {
      historyServerUrl: { 'ui:placeholder': 'Blank: this Signal K server' },
      historyApiKey: { 'ui:widget': 'password', 'ui:placeholder': 'Only for another server' },
      historyProvider: { 'ui:placeholder': "Blank: the server's default" }
    }
  };
}

module.exports = {
  DOCS_URL,
  SECTIONS,
  SETTING_LABELS,
  STORED_VALUE_NOT_SHOWN,
  TOP_LEVEL_KEYS,
  migrateSettings,
  readSettings,
  settingsSchema,
  settingsUiSchema
};
