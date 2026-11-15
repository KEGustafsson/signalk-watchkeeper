'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const createPlugin = require('../index.cjs');
const packageJson = require('../package.json');

function createHost() {
  const statuses = [];
  return {
    selfId: 'vessels.urn:mrn:signalk:uuid:test',
    statuses,
    subscriptionmanager: { subscribe() {} },
    handleMessage() {},
    getSelfPath() {},
    setPluginStatus(message) {
      statuses.push(message);
    }
  };
}

function recorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function routesOf(plugin) {
  const routes = {};
  plugin.registerWithRouter({
    get(route, handler) {
      routes[`GET ${route}`] = handler;
    },
    post(route, handler) {
      routes[`POST ${route}`] = handler;
    }
  });
  return routes;
}

describe('the plugin', () => {
  it('is the package it ships in', () => {
    const plugin = createPlugin(createHost());
    assert.equal(plugin.id, packageJson.name);
    assert.equal(typeof plugin.name, 'string');
    assert.equal(typeof plugin.description, 'string');
    for (const name of ['start', 'stop', 'schema', 'uiSchema', 'registerWithRouter']) {
      assert.equal(typeof plugin[name], 'function', name);
    }
  });

  it('describes its settings in sections, with the watch off and the built-in reader alone by default', () => {
    const plugin = createPlugin(createHost());
    const schema = plugin.schema();
    assert.deepEqual(Object.keys(schema.properties), ['watchEnabled', 'alerts', 'watching', 'ruleAssist', 'replay', 'advanced']);
    assert.equal(schema.properties.watchEnabled.default, false);
    assert.equal(schema.properties.ruleAssist.properties.ruleAssistEnabled.default, false);
    assert.match(schema.description, /only the first switch/i);
    assert.match(plugin.uiSchema().replay.historyApiKey['ui:widget'], /^password$/);
  });

  it('registers its routes once, and serves nothing while stopped', async () => {
    const plugin = createPlugin(createHost());
    const routes = routesOf(plugin);
    let again = 0;
    plugin.registerWithRouter({ get: () => (again += 1), post: () => (again += 1) });
    assert.equal(again, 0);
    assert.deepEqual(Object.keys(routes).sort(), [
      'GET /watch/inventory',
      'GET /watch/report',
      'GET /watch/series',
      'GET /watch/status',
      'GET /watch/unusual',
      'POST /watch/feedback',
      'POST /watch/mute',
      'POST /watch/replay',
      'POST /watch/rules/add',
      'POST /watch/rules/compile',
      'POST /watch/rules/remove',
      'POST /watch/rules/save',
      'POST /watch/unmute'
    ]);
    for (const [route, handler] of Object.entries(routes)) {
      const response = recorder();
      await handler({ body: {} }, response);
      assert.equal(response.statusCode, 503, route);
      assert.equal(response.body.error.code, 'disabled', route);
    }
  });

  it('starts, reports its state, and stops', async () => {
    const host = createHost();
    const plugin = createPlugin(host);
    const routes = routesOf(plugin);
    plugin.start({ watchEnabled: true });
    try {
      assert.match(host.statuses.at(-1), /watching/);
      const status = recorder();
      await routes['GET /watch/status']({}, status);
      assert.equal(status.statusCode, 200);
      assert.equal(status.body.running, true);
    } finally {
      plugin.stop();
    }
    assert.match(host.statuses.at(-1), /stopped/);
    plugin.start({});
    try {
      assert.match(host.statuses.at(-1), /off/);
    } finally {
      plugin.stop();
    }
  });

  it('reads a rule the parser cannot with the configured model only', async () => {
    const asked = [];
    const host = createHost();
    let onDelta;
    host.subscriptionmanager = {
      subscribe(command, unsubscribes, onError, callback) {
        onDelta = callback;
      }
    };
    const plugin = createPlugin(host, {
      fetchImpl: async (url, init) => {
        asked.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ message: { content: '{}' } }), { status: 200 });
      }
    });
    const routes = routesOf(plugin);
    plugin.start({ watchEnabled: true, ollamaUrl: 'http://gpu.local:11434', ruleAssistModel: 'qwen3:0.6b' });
    try {
      onDelta({ updates: [{ values: [{ path: 'propulsion.main.temperature', value: 353 }] }] });
      const response = recorder();
      await routes['POST /watch/rules/compile']({ body: { text: 'shout if the engine is cooking' } }, response);
      assert.equal(response.statusCode, 200);
      assert.equal(asked.length, 1);
      assert.equal(asked[0].url, 'http://gpu.local:11434/api/chat');
      assert.equal(asked[0].body.model, 'qwen3:0.6b');
    } finally {
      plugin.stop();
    }
  });
});

describe('the Ollama server for wordings the built-in reader cannot read', () => {
  /** Compile a rule the parser cannot read, with `options`, recording every fetch. */
  async function compileWith(options, fetchImpl) {
    const asked = [];
    const host = createHost();
    let onDelta;
    host.subscriptionmanager = {
      subscribe(command, unsubscribes, onError, callback) {
        onDelta = callback;
      }
    };
    const plugin = createPlugin(host, {
      fetchImpl: async (url, init) => {
        asked.push(String(url));
        if (fetchImpl) return fetchImpl(url, init);
        return new Response(JSON.stringify({ message: { content: '{}' } }), { status: 200 });
      }
    });
    const routes = routesOf(plugin);
    plugin.start({ watchEnabled: true, ruleAssistModel: 'qwen3:0.6b', ...options });
    try {
      onDelta({ updates: [{ values: [{ path: 'propulsion.main.temperature', value: 353 }] }] });
      const response = recorder();
      await routes['POST /watch/rules/compile']({ body: { text: 'shout if the engine is cooking' } }, response);
      return { asked, response };
    } finally {
      plugin.stop();
    }
  }

  it('asks nothing, and says why, for a URL with credentials in it', async () => {
    const { asked, response } = await compileWith({ ollamaUrl: 'http://user:s3cret@gpu.local:11434' });
    assert.equal(asked.length, 0);
    assert.match(response.body.assistNote, /Rules in your own words → Ollama server address/);
    assert.match(response.body.assistNote, /user name or password/);
    assert.doesNotMatch(JSON.stringify(response.body), /s3cret/);
  });

  it('refuses a server without a scheme instead of asking localhost in its place', async () => {
    const { asked, response } = await compileWith({ ollamaUrl: 'gpu.local:11434' });
    assert.equal(asked.length, 0);
    assert.match(response.body.assistNote, /Rules in your own words → Ollama server address/);
    assert.match(response.body.assistNote, /http:\/\//);
  });

  it('refuses a URL with a query or a fragment, even an empty one', async () => {
    for (const ollamaUrl of ['http://gpu.local:11434/?x=1', 'http://gpu.local:11434#top', 'http://gpu.local:11434?', 'ftp://gpu.local']) {
      const { asked, response } = await compileWith({ ollamaUrl });
      assert.equal(asked.length, 0, ollamaUrl);
      assert.match(response.body.assistNote, /Rules in your own words → Ollama server address/, ollamaUrl);
    }
  });

  it('does not say a model was asked when the URL is refused, and says so at start', async () => {
    const { response } = await compileWith({ ollamaUrl: 'gpu.local:11434' });
    assert.equal(response.body.model, undefined);
    assert.equal(response.body.assist, 'not-asked');

    const host = createHost();
    const statuses = [];
    const errors = [];
    host.setPluginStatus = (message) => statuses.push(message);
    host.error = (message) => errors.push(message);
    const plugin = createPlugin(host, { fetchImpl: async () => new Response('{}') });
    plugin.start({ watchEnabled: true, ollamaUrl: 'gpu.local:11434', ruleAssistModel: 'qwen3:0.6b' });
    try {
      assert.match(statuses[statuses.length - 1], /not sent to qwen3:0\.6b.*Rules in your own words → Ollama server address/);
      assert.equal(errors.length, 1);
    } finally {
      plugin.stop();
    }
    // A good URL, or no model, raises nothing.
    const quiet = createHost();
    const said = [];
    quiet.setPluginStatus = (message) => said.push(message);
    const other = createPlugin(quiet, { fetchImpl: async () => new Response('{}') });
    other.start({ watchEnabled: true, ollamaUrl: 'gpu.local:11434' });
    other.stop();
    assert.doesNotMatch(said.join(' '), /Rules in your own words → Ollama server address/);
  });

  it('names the cause when Ollama is not running there', async () => {
    const { asked, response } = await compileWith({ ollamaUrl: 'http://gpu.local:11434' }, async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    });
    assert.equal(asked.length, 1);
    assert.match(response.body.assistNote, /fetch failed: ECONNREFUSED/);
  });

  it('does not repeat credentials a fetch error quotes', async () => {
    const { response } = await compileWith({ ollamaUrl: 'http://gpu.local:11434' }, async () => {
      throw new Error('request to http://user:s3cret@gpu.local:11434/api/chat failed');
    });
    assert.doesNotMatch(response.body.assistNote, /s3cret/);
    assert.match(response.body.assistNote, /http:\/\/gpu\.local:11434\/api\/chat/);
  });
});

describe('settings stored in sections', () => {
  /** Options as the admin page stores them, with every section. */
  const sectioned = () => ({
    watchEnabled: true,
    alerts: { watchNotifications: true, watchSound: false },
    watching: {
      watchSensitivity: 'high',
      watchLearningMinutes: 30,
      watchDefaultExclusions: true,
      watchExcludePaths: [],
      watchCounterPaths: []
    },
    ruleAssist: { ruleAssistEnabled: false, ollamaUrl: 'http://gpu.local:11434', ruleAssistModel: 'qwen3:0.6b' },
    replay: { historyServerUrl: 'http://nas.local:3000', historyApiKey: 'k', historyProvider: '', historyTimeoutMs: 30000 },
    advanced: { watchMaxPaths: 1500 }
  });

  /** A running plugin on `options`, its routes, every fetch and every save. */
  function startWith(options, respond) {
    const host = createHost();
    const saved = [];
    host.savePluginOptions = (stored, done) => {
      saved.push(JSON.parse(JSON.stringify(stored)));
      done();
    };
    let onDelta;
    host.subscriptionmanager = {
      subscribe(command, unsubscribes, onError, callback) {
        onDelta = callback;
      }
    };
    const asked = [];
    const plugin = createPlugin(host, {
      fetchImpl: async (url, init) => {
        asked.push(String(url));
        return respond ? respond(url, init) : new Response(JSON.stringify({ message: { content: '{}' } }), { status: 200 });
      }
    });
    const routes = routesOf(plugin);
    plugin.start(options);
    onDelta({ updates: [{ values: [{ path: 'propulsion.main.temperature', value: 353 }] }] });
    return { host, plugin, routes, saved, asked };
  }

  it('keeps every section as it was when a rule is added or removed, and adds no flat keys', async () => {
    const options = sectioned();
    const { plugin, routes, saved } = startWith(options);
    try {
      const rule = { id: 'r-hot', text: 'coolant above 95', path: 'propulsion.main.temperature', op: 'above', value: 368, forSeconds: 0, severity: 'warn' };
      const added = recorder();
      await routes['POST /watch/rules/add']({ body: { rule } }, added);
      assert.equal(added.statusCode, 200);
      const removed = recorder();
      await routes['POST /watch/rules/remove']({ body: { id: 'r-hot' } }, removed);
      assert.equal(removed.statusCode, 200);
      const replaced = recorder();
      await routes['POST /watch/rules/save']({ body: { rules: [rule] } }, replaced);
      assert.equal(replaced.statusCode, 200);

      assert.equal(saved.length, 3);
      for (const stored of saved) {
        const { watchRules, ...rest } = stored;
        assert.deepEqual(rest, sectioned());
        assert.ok(Array.isArray(watchRules));
      }
      assert.deepEqual(saved[0].watchRules.map((item) => item.id), ['r-hot']);
      assert.deepEqual(saved[1].watchRules, []);
      assert.deepEqual(Object.keys(saved[2]).sort(), ['advanced', 'alerts', 'replay', 'ruleAssist', 'watchEnabled', 'watchRules', 'watching']);
      // The options it was started with are not changed in place.
      assert.deepEqual(options, sectioned());
    } finally {
      plugin.stop();
    }
  });

  it('reads the sections: the watch runs, and a model is asked only with the AI help switched on', async () => {
    const compile = async (ruleAssist) => {
      const { host, plugin, routes, asked } = startWith({ ...sectioned(), ruleAssist });
      try {
        assert.match(host.statuses.at(-1), /watching/);
        const response = recorder();
        await routes['POST /watch/rules/compile']({ body: { text: 'shout if the engine is cooking' } }, response);
        return { asked, body: response.body };
      } finally {
        plugin.stop();
      }
    };
    const off = await compile({ ruleAssistEnabled: false, ollamaUrl: 'http://gpu.local:11434', ruleAssistModel: 'qwen3:0.6b' });
    assert.equal(off.asked.length, 0);
    assert.equal(off.body.assist, 'off');

    const on = await compile({ ruleAssistEnabled: true, ollamaUrl: 'http://gpu.local:11434', ruleAssistModel: 'qwen3:0.6b' });
    assert.deepEqual(on.asked, ['http://gpu.local:11434/api/chat']);

    const noModel = await compile({ ruleAssistEnabled: true, ollamaUrl: 'http://gpu.local:11434', ruleAssistModel: '' });
    assert.equal(noModel.asked.length, 0);
    assert.equal(noModel.body.assist, 'off');

    // A refused address is reported only when the help is on.
    const quiet = startWith({ ...sectioned(), ruleAssist: { ruleAssistEnabled: false, ollamaUrl: 'gpu.local:11434', ruleAssistModel: 'qwen3:0.6b' } });
    quiet.plugin.stop();
    assert.doesNotMatch(quiet.host.statuses.join(' '), /Ollama server address/);
  });

  it('replays from the history server its section names', async () => {
    const { plugin, routes, asked } = startWith(sectioned(), async () => new Response('[]', { status: 200 }));
    try {
      const response = recorder();
      await routes['POST /watch/replay']({ headers: {}, body: { duration: 'PT1H' } }, response);
      assert.ok(asked.length >= 1);
      assert.ok(asked.every((url) => url.startsWith('http://nas.local:3000/')), asked.join(', '));
    } finally {
      plugin.stop();
    }
  });
});

describe('write access on a secured server', () => {
  const WRITES = [
    ['POST /watch/mute', { path: 'propulsion.main.temperature', minutes: 60 }],
    ['POST /watch/unmute', { path: 'propulsion.main.temperature' }],
    ['POST /watch/feedback', { path: 'propulsion.main.temperature', useful: false }],
    ['POST /watch/replay', {}],
    ['POST /watch/rules/compile', { text: 'coolant above 95' }],
    ['POST /watch/rules/add', { rule: { text: 'x', path: 'propulsion.main.temperature', op: 'above', value: 360 } }],
    ['POST /watch/rules/remove', { id: 'r-x' }],
    ['POST /watch/rules/save', { rules: [] }]
  ];

  function securedPlugin(securityStrategy) {
    const host = createHost();
    host.securityStrategy = securityStrategy;
    const saved = [];
    host.savePluginOptions = (options, done) => {
      saved.push(options);
      done();
    };
    const plugin = createPlugin(host, { fetchImpl: async () => new Response('[]', { status: 200 }) });
    const routes = routesOf(plugin);
    plugin.start({ watchEnabled: true });
    return { plugin, routes, saved };
  }

  it('refuses every write without a login, with a read-only principal, or a read-only or failing login status', async () => {
    const cases = [
      ['anonymous', { isDummy: () => false, getLoginStatus: () => ({ status: 'notLoggedIn' }) }, {}],
      ['read-only principal', { isDummy: () => false }, { skPrincipal: { permissions: 'readonly' } }],
      ['read-only login status', { isDummy: () => false, getLoginStatus: () => ({ status: 'loggedIn', userLevel: 'readonly' }) }, {}],
      ['login status with no level', { isDummy: () => false, getLoginStatus: () => ({ status: 'loggedIn' }) }, {}],
      [
        'login status that throws',
        {
          isDummy: () => false,
          getLoginStatus: () => {
            throw new Error('no session');
          }
        },
        {}
      ],
      ['no way to tell', { isDummy: () => false }, {}]
    ];
    for (const [name, strategy, request] of cases) {
      const { plugin, routes, saved } = securedPlugin(strategy);
      try {
        for (const [route, body] of WRITES) {
          const response = recorder();
          await routes[route]({ headers: {}, ...request, body }, response);
          assert.equal(response.statusCode, 401, `${name}: ${route}`);
          assert.equal(response.body.error.code, 'unauthorized', `${name}: ${route}`);
        }
        assert.equal(saved.length, 0, name);
      } finally {
        plugin.stop();
      }
    }
  });

  it('allows writes for a read-write login status, or an admin or read-write principal', async () => {
    const cases = [
      ['read-write login status', { isDummy: () => false, getLoginStatus: () => ({ status: 'loggedIn', userLevel: 'readwrite' }) }, {}],
      // readOnlyAccess is the server's "Allow Readonly Access" setting, not
      // the login's level: an admin on such a server may still write.
      [
        'admin login status on a server that allows read-only visitors',
        { isDummy: () => false, getLoginStatus: () => ({ status: 'loggedIn', readOnlyAccess: true, userLevel: 'admin' }) },
        {}
      ],
      ['admin principal', { isDummy: () => false }, { skPrincipal: { permissions: 'admin' } }],
      ['read-write principal', { isDummy: () => false }, { skPrincipal: { permissions: 'readwrite' } }],
      ['dummy strategy', { isDummy: () => true }, {}]
    ];
    for (const [name, strategy, request] of cases) {
      const { plugin, routes } = securedPlugin(strategy);
      try {
        const response = recorder();
        await routes['POST /watch/rules/save']({ headers: {}, ...request, body: { rules: [] } }, response);
        assert.equal(response.statusCode, 200, name);
      } finally {
        plugin.stop();
      }
    }
  });
});
