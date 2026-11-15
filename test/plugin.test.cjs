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

  it('describes its settings, with the watch off and the parser alone by default', () => {
    const { properties } = createPlugin(createHost()).schema();
    assert.equal(properties.watchEnabled.default, false);
    assert.equal(properties.watchSensitivity.default, 'normal');
    assert.equal(properties.ruleAssistModel.default, '');
    assert.equal(properties.ollamaUrl.default, 'http://localhost:11434');
    assert.match(properties.watchNotifications.description, /notifications\.watchkeeper\./);
    for (const [name, property] of Object.entries(properties)) {
      assert.ok(property.title, `${name} has a title`);
      assert.ok('default' in property, `${name} has a default`);
    }
    assert.deepEqual(createPlugin(createHost()).uiSchema(), { historyApiKey: { 'ui:widget': 'password' } });
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
