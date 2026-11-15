'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWatchService } = require('../lib/watch-service.cjs');
const createPlugin = require('../index.cjs');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function createHost({ dataDir } = {}) {
  const messages = [];
  const host = {
    selfId: 'vessels.urn:mrn:signalk:uuid:test',
    deltaCallback: undefined,
    subscribeCommand: undefined,
    unsubscribed: 0,
    messages,
    subscriptionmanager: {
      subscribe(command, unsubscribes, onError, onDelta) {
        host.subscribeCommand = command;
        host.deltaCallback = onDelta;
        unsubscribes.push(() => {
          host.unsubscribed += 1;
        });
      }
    },
    handleMessage(id, delta) {
      messages.push({ id, delta });
    },
    getSelfPath(selfPath) {
      if (selfPath === 'propulsion.main.temperature') {
        return { value: 353, meta: { units: 'K', displayName: 'Engine temp' } };
      }
      return undefined;
    },
    setPluginStatus() {}
  };
  if (dataDir) {
    host.getDataDirPath = () => dataDir;
  }
  return host;
}

function notificationsFor(host, notificationPath) {
  return host.messages
    .flatMap((message) => message.delta.updates.flatMap((update) => update.values))
    .filter((value) => value.path === notificationPath)
    .map((value) => value.value);
}

/** Feed a value every second and tick every five, on a virtual clock. */
function drive(host, service, clock, durationMs, valueAt) {
  const end = clock.t + durationMs;
  while (clock.t < end) {
    host.deltaCallback({
      context: 'vessels.self',
      updates: [{ $source: 'n2k.42', values: [{ path: 'propulsion.main.temperature', value: valueAt(clock.t) }] }]
    });
    clock.t += SECOND;
    if (clock.t % (5 * SECOND) === 0) {
      service.tick();
    }
  }
}

describe('watch service', () => {
  it('does nothing until enabled', () => {
    const host = createHost();
    const service = createWatchService(host, {});
    assert.equal(service.start({}), false);
    assert.equal(host.subscribeCommand, undefined);
    const status = service.status();
    assert.equal(status.enabled, false);
    assert.equal(status.usesLanguageModel, false);
  });

  it('keeps the rest of a delta when one value cannot be watched', () => {
    const host = createHost();
    const clock = { t: Date.parse('2026-06-01T08:00:00Z') };
    const service = createWatchService(host, { now: () => clock.t });
    assert.equal(service.start({ watchEnabled: true }), true);
    const broken = {
      get latitude() {
        throw new Error('unreadable fix');
      },
      longitude: 24
    };
    assert.doesNotThrow(() =>
      host.deltaCallback({
        context: 'vessels.self',
        updates: [
          {
            $source: 'gps.1',
            values: [
              { path: 'navigation.position', value: broken },
              { path: 'propulsion.main.temperature', value: 353 }
            ]
          }
        ]
      })
    );
    const status = service.status();
    assert.match(status.lastError, /Could not watch navigation\.position: unreadable fix/);
    assert.equal(status.samples, 2);
    assert.ok(service.inventory().paths.some((item) => item.path === 'propulsion.main.temperature'), 'the value after the bad one is still watched');
  });

  it('keeps the rest of the metadata, and the stream bus, when one entry cannot be read', () => {
    const host = createHost();
    const clock = { t: Date.parse('2026-06-01T08:00:00Z') };
    const service = createWatchService(host, { now: () => clock.t });
    service.start({ watchEnabled: true });
    const brokenMeta = {
      get units() {
        throw new Error('unreadable meta');
      }
    };
    host.deltaCallback({
      context: 'vessels.self',
      updates: [{ $source: 'n2k.1', values: [{ path: 'a.one', value: 1 }, { path: 'b.two', value: 2 }] }]
    });
    assert.doesNotThrow(() =>
      host.deltaCallback({
        context: 'vessels.self',
        updates: [{ meta: [{ path: 'a.one', value: brokenMeta }, { path: 'b.two', value: { units: 'V' } }] }]
      })
    );
    assert.match(service.status().lastError, /Could not read metadata for a\.one: unreadable meta/);
    assert.equal(service.inventory().paths.find((item) => item.path === 'b.two').units, 'V', 'the entry after the bad one is applied');
    service.stop();

    // A server without a subscription manager: the stream bus.
    let onValue;
    const bus = { onValue: (callback) => ((onValue = callback), () => {}) };
    const busHost = { ...createHost(), subscriptionmanager: undefined, streambundle: { getSelfBus: () => bus } };
    const busService = createWatchService(busHost, { now: () => clock.t });
    busService.start({ watchEnabled: true });
    const broken = {
      get latitude() {
        throw new Error('unreadable fix');
      },
      longitude: 24
    };
    assert.doesNotThrow(() => onValue({ path: 'navigation.position', value: broken, $source: 'gps.1' }));
    assert.match(busService.status().lastError, /Could not watch navigation\.position: unreadable fix/);
    busService.stop();
  });

  it('subscribes to the self vessel and publishes findings as Signal K notifications', () => {
    const host = createHost();
    const clock = { t: Date.parse('2026-06-01T08:00:00Z') };
    const service = createWatchService(host, { now: () => clock.t });
    assert.equal(service.start({ watchEnabled: true, watchLearningMinutes: 10 }), true);
    assert.deepEqual(host.subscribeCommand.subscribe[0].path, '*');
    assert.equal(host.subscribeCommand.context, 'vessels.self');

    let seed = 1;
    const jitter = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647 - 0.5) * 0.4;
    };
    drive(host, service, clock, 30 * MINUTE, () => 353 + jitter());
    const notificationPath = 'notifications.watchkeeper.propulsion.main.temperature';
    assert.deepEqual(notificationsFor(host, notificationPath), []);

    drive(host, service, clock, MINUTE, () => 365 + jitter());
    const raised = notificationsFor(host, notificationPath);
    assert.equal(raised.length, 1);
    assert.equal(raised[0].state, 'alert');
    assert.deepEqual(raised[0].method, ['visual']);
    // The display name and units came from the path's own metadata.
    assert.match(raised[0].message, /^Engine temp unusually high: 9\d\.\d °C/);
    assert.equal(host.messages[0].id, 'signalk-watchkeeper');

    const status = service.status();
    assert.equal(status.running, true);
    assert.equal(status.activeFindings.length, 1);
    assert.equal(status.paths.watched, 1);

    service.stop();
    const cleared = notificationsFor(host, notificationPath);
    assert.equal(cleared[cleared.length - 1].state, 'normal');
    assert.equal(host.unsubscribed, 1);
  });

  it('keeps the learned baseline across a restart', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
    try {
      const host = createHost({ dataDir });
      const clock = { t: Date.parse('2026-06-01T08:00:00Z') };
      const service = createWatchService(host, { now: () => clock.t });
      service.start({ watchEnabled: true, watchLearningMinutes: 10 });
      drive(host, service, clock, 15 * MINUTE, () => 353);
      await service.saveState();
      service.stop();

      const again = createWatchService(createHost({ dataDir }), { now: () => clock.t });
      again.start({ watchEnabled: true });
      const status = again.status();
      assert.equal(status.restoredBaseline, true);
      assert.equal(status.paths.watched, 1);
      again.stop();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('gives up on a path listing that never answers, whatever historyTimeoutMs says, and can replay again', async () => {
    for (const historyTimeoutMs of [0, 10]) {
      const host = createHost();
      let listings = 0;
      // Never answers, until the request is aborted.
      const fetchImpl = (url, init = {}) =>
        new Promise((resolve, reject) => {
          if (String(url).includes('/history/paths')) listings += 1;
          if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      // A short floor keeps the test fast; the plugin's own is 30 s.
      const service = createWatchService(host, { now: () => Date.parse('2026-06-02T08:00:00Z'), fetchImpl, replayTimeoutMs: 200 });
      service.start({ watchEnabled: true });
      try {
        const started = Date.now();
        const first = await Promise.race([
          service.replay({ duration: 'PT1H' }, { historyTimeoutMs }),
          new Promise((resolve) => setTimeout(() => resolve('hung'), 2000))
        ]);
        assert.notEqual(first, 'hung', `historyTimeoutMs ${historyTimeoutMs}: the listing has a limit`);
        assert.equal(first.ok, false);
        assert.ok(Date.now() - started >= 150, `historyTimeoutMs ${historyTimeoutMs}: the listing waits the floor, not less`);
        // Not left busy: a second replay runs.
        const second = await service.replay({ duration: 'PT1H' }, { historyTimeoutMs });
        assert.equal(second.ok, false);
        assert.equal(listings, 2);
      } finally {
        service.stop();
      }
    }
  });

  it('replays recorded history through a fresh watch', async () => {
    const host = createHost();
    const end = Date.parse('2026-06-02T08:00:00Z');
    const start = end - 6 * 60 * MINUTE;
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      if (url.includes('/history/paths')) {
        return new Response(JSON.stringify(['propulsion.main.temperature', 'navigation.headingTrue', 'notifications.x']), { status: 200 });
      }
      const data = [];
      for (let at = start; at <= end; at += 10 * SECOND) {
        const late = at > end - 30 * MINUTE;
        data.push([new Date(at).toISOString(), late ? 368 : 353 + ((at / 10000) % 3) * 0.05]);
      }
      return new Response(JSON.stringify({ values: [{ path: 'propulsion.main.temperature', method: 'average' }], data }), { status: 200 });
    };
    const service = createWatchService(host, { now: () => end, fetchImpl });
    service.start({ watchEnabled: true });
    const result = await service.replay({ duration: 'PT6H' }, { historyTimeoutMs: 5000 });
    assert.equal(result.ok, true);
    // Heading is not watched on its own, but the GNSS check reads it for dead
    // reckoning; notifications are never replayed.
    assert.equal(result.pathsReplayed, 2);
    assert.ok(result.findingsOpened >= 1);
    assert.ok(result.byDetector.shift >= 1);
    assert.match(result.incidents[0].title, /temperature unusually high/);
    assert.ok(requests.some((url) => url.includes('/signalk/v2/api/history/values')));
    service.stop();
  });
});

describe('watch service: review fixes', () => {
  it('retries a notification the server refused, instead of recording it as sent', () => {
    const host = createHost();
    let refuse = true;
    const accepted = [];
    host.handleMessage = (id, delta) => {
      if (refuse) throw new Error('server busy');
      accepted.push(delta);
    };
    const clock = { t: Date.parse('2026-06-01T08:00:00Z') };
    const service = createWatchService(host, { now: () => clock.t });
    service.start({ watchEnabled: true, watchLearningMinutes: 10 });
    // Fractional readings, like a real sensor: whole numbers would be read as a set of states.
    drive(host, service, clock, 30 * MINUTE, (t) => 353.15 + ((t / 1000) % 3) * 0.05);
    drive(host, service, clock, MINUTE, (t) => 365.15 + ((t / 1000) % 3) * 0.05);
    assert.equal(accepted.length, 0);
    assert.match(service.status().lastError, /server busy/);
    refuse = false;
    service.tick();
    const values = accepted.flatMap((delta) => delta.updates.flatMap((update) => update.values));
    assert.ok(values.some((value) => value.path === 'notifications.watchkeeper.propulsion.main.temperature' && value.value.state === 'alert'));
    service.stop();
  });
});

describe('watch routes', () => {
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

  function registerRoutes(plugin) {
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

  it('reports watch status, and refuses to mute without write access', async () => {
    const host = createHost();
    host.securityStrategy = { isDummy: () => false };
    const plugin = createPlugin(host, { fetchImpl: async () => new Response('{}', { status: 503 }) });
    const routes = registerRoutes(plugin);
    plugin.start({ watchEnabled: true });
    try {
      const status = recorder();
      await routes['GET /watch/status']({}, status);
      assert.equal(status.statusCode, 200);
      assert.equal(status.body.running, true);
      assert.equal(status.body.usesLanguageModel, false);

      const denied = recorder();
      await routes['POST /watch/mute']({ body: { path: 'propulsion.main.temperature' } }, denied);
      assert.equal(denied.statusCode, 401);

      const allowed = recorder();
      await routes['POST /watch/mute'](
        { body: { path: 'propulsion.main.temperature', minutes: 30 }, skPrincipal: { permissions: 'admin' } },
        allowed
      );
      assert.equal(allowed.statusCode, 200);
      assert.equal(allowed.body.mutes[0].path, 'propulsion.main.temperature');

      const report = recorder();
      await routes['GET /watch/report']({ query: { hours: '12' } }, report);
      assert.equal(report.statusCode, 200);
      assert.equal(report.body.hours, 12);
      assert.deepEqual(report.body.lines, ['Nothing unusual was found.']);

      const deniedFeedback = recorder();
      await routes['POST /watch/feedback']({ body: { path: 'a.b', useful: false } }, deniedFeedback);
      assert.equal(deniedFeedback.statusCode, 401);
      // Overlapping writes: three watch rules, all in flight at once
      // against a slow save. Every change must survive.
      host.savePluginOptions = (options, done) => {
        setTimeout(() => {
          host.saved = options;
          done();
        }, 5);
      };
      const writer = { skPrincipal: { permissions: 'admin' } };
      const rule = (id, value) => ({ id, text: id, path: 'propulsion.main.temperature', op: 'above', value, forSeconds: 0, severity: 'warn' });
      const responses = [recorder(), recorder(), recorder()];
      await Promise.all([
        routes['POST /watch/rules/add']({ ...writer, body: { rule: rule('r-zero', 350) } }, responses[0]),
        routes['POST /watch/rules/add']({ ...writer, body: { rule: rule('r-one', 360) } }, responses[1]),
        routes['POST /watch/rules/add']({ ...writer, body: { rule: rule('r-two', 370) } }, responses[2])
      ]);
      assert.deepEqual(responses.map((item) => item.statusCode), [200, 200, 200]);
      assert.deepEqual(host.saved.watchRules.map((item) => item.id).sort(), ['r-one', 'r-two', 'r-zero']);

      // At the 50-watch cap, adding one is refused rather than dropped.
      host.saved.watchRules = Array.from({ length: 50 }, (_, index) => rule(`r-fill-${index}`, 300 + index));
      const filler = recorder();
      await routes['POST /watch/rules/save']({ ...writer, body: { rules: host.saved.watchRules } }, filler);
      assert.equal(filler.body.rules.length, 50);
      const overflow = recorder();
      await routes['POST /watch/rules/add']({ ...writer, body: { rule: rule('r-new', 400) } }, overflow);
      assert.equal(overflow.statusCode, 409);
      assert.equal(overflow.body.error.code, 'conflict');
      assert.ok(!host.saved.watchRules.some((item) => item.id === 'r-new'));
      // Replacing one of the fifty is not adding: it is kept, at the cap.
      const replaced = recorder();
      await routes['POST /watch/rules/add']({ ...writer, body: { rule: rule('r-fill-7', 399) } }, replaced);
      assert.equal(replaced.statusCode, 200);
      assert.equal(host.saved.watchRules.length, 50);
      assert.equal(host.saved.watchRules.find((item) => item.id === 'r-fill-7').value, 399);
      const restore = recorder();
      await routes['POST /watch/rules/save']({ ...writer, body: { rules: [rule('r-one', 360), rule('r-two', 370)] } }, restore);

      const removed = recorder();
      await routes['POST /watch/rules/remove']({ ...writer, body: { id: 'r-one' } }, removed);
      assert.deepEqual(removed.body.rules.map((item) => item.id), ['r-two']);
      assert.deepEqual(host.saved.watchRules.map((item) => item.id), ['r-two']);

      const feedback = recorder();
      await routes['POST /watch/feedback']({ body: { path: 'a.b', useful: false }, skPrincipal: { permissions: 'readwrite' } }, feedback);
      assert.deepEqual(feedback.body, { path: 'a.b', factor: 1.25 });
    } finally {
      plugin.stop();
    }

    const stopped = recorder();
    await routes['GET /watch/status']({}, stopped);
    assert.equal(stopped.statusCode, 503);
  });
});

describe('watch service: restart and saves', () => {
  it('restarts from the final in-memory snapshot, not a file whose save is still in flight', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
    const host = createHost({ dataDir });
    const clock = { t: Date.parse('2026-06-01T08:00:00Z') };
    const service = createWatchService(host, { now: () => clock.t });
    try {
      service.start({ watchEnabled: true, watchLearningMinutes: 10 });
      drive(host, service, clock, 15 * MINUTE, (t) => 353.15 + ((t / 1000) % 3) * 0.05);
      // No file yet; restart straight away, as a settings change does.
      service.start({ watchEnabled: true, watchLearningMinutes: 10 });
      const status = service.status();
      assert.equal(status.restoredBaseline, true);
      assert.equal(status.paths.watched, 1);
      service.stop();
      // Both pending saves complete in order and leave a readable file.
      await service.whenSaved();
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'watch-state.json'), 'utf8'));
      assert.equal(saved.paths.length, 1);
    } finally {
      // No write may still be queued when the directory goes.
      service.stop();
      await service.whenSaved();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('stored settings and the write queue', () => {
  function routesFor(host) {
    const plugin = createPlugin(host, { fetchImpl: async () => new Response('{}', { status: 503 }) });
    const routes = {};
    plugin.registerWithRouter({
      get(route, handler) {
        routes[`GET ${route}`] = handler;
      },
      post(route, handler) {
        routes[`POST ${route}`] = handler;
      }
    });
    return { plugin, routes };
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


  const rule = (id, value = 360) => ({ id, text: id, path: 'propulsion.main.temperature', op: 'above', value, forSeconds: 0, severity: 'warn' });
  const ids = (rules) => rules.map((item) => item.id);

  it('puts the restart\'s options back on disk when a redone change has nothing left to do', async () => {
    const host = createHost();
    let finish;
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      if (saves.length === 1) finish = done;
      else done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ watchEnabled: true, watchSensitivity: 'low', watchRules: [rule('r-a'), rule('r-b', 370)] });
    try {
      const reply = recorder();
      const removing = routes['POST /watch/rules/remove']({ body: { id: 'r-b' } }, reply);
      await new Promise((resolve) => setImmediate(resolve));
      plugin.stop();
      // The restart's list no longer has r-b: the redone remove finds nothing.
      plugin.start({ watchEnabled: true, watchSensitivity: 'high', watchRules: [rule('r-a')] });
      finish();
      await removing;
      const last = saves[saves.length - 1];
      assert.equal(last.watchSensitivity, 'high', 'disk holds the restart\'s options, not the older copy');
      assert.deepEqual(ids(last.watchRules), ['r-a']);
    } finally {
      plugin.stop();
    }
  });

  it('ends with the newest options on disk after two restarts during one save', async () => {
    const host = createHost();
    const pending = [];
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      pending.push(done);
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ watchEnabled: true, watchSensitivity: 'low', watchRules: [rule('r-a'), rule('r-b', 370)] });
    try {
      const removing = routes['POST /watch/rules/remove']({ body: { id: 'r-b' } }, recorder());
      await new Promise((resolve) => setImmediate(resolve));
      // Restart 1: r-b is gone, so the redone remove has nothing to do and
      // the restart's options are written back.
      plugin.stop();
      plugin.start({ watchEnabled: true, watchSensitivity: 'normal', watchRules: [rule('r-a')] });
      pending.shift()();
      await new Promise((resolve) => setImmediate(resolve));
      // Restart 2 while that re-save is in flight.
      plugin.stop();
      plugin.start({ watchEnabled: true, watchSensitivity: 'high', watchRules: [rule('r-a')] });
      while (pending.length > 0) {
        pending.shift()();
        await new Promise((resolve) => setImmediate(resolve));
      }
      await removing;
      assert.equal(saves[saves.length - 1].watchSensitivity, 'high');
    } finally {
      plugin.stop();
    }
  });

  it('says a change was saved when the plugin stops after storing it', async () => {
    const host = createHost();
    let finish;
    host.savePluginOptions = (options, done) => {
      finish = done;
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ watchEnabled: true });
    const reply = recorder();
    const saving = routes['POST /watch/rules/add']({ body: { rule: rule('r-a') } }, reply);
    await new Promise((resolve) => setImmediate(resolve));
    plugin.stop();
    finish();
    await saving;
    assert.doesNotMatch(JSON.stringify(reply.body), /nothing was saved/);
  });

  it('redoes a change on the restart\'s options when a restart lands while its save is in flight', async () => {
    const host = createHost();
    let finish;
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      if (saves.length === 1) finish = done;
      else done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ watchEnabled: true, watchSensitivity: 'low', watchRules: [rule('r-a')] });
    try {
      const reply = recorder();
      const adding = routes['POST /watch/rules/add']({ body: { rule: rule('r-b', 370) } }, reply);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(typeof finish, 'function', 'the save is in flight');
      plugin.stop();
      plugin.start({ watchEnabled: true, watchSensitivity: 'high', watchRules: [rule('r-a'), rule('r-c', 380)] });
      finish();
      await adding;
      // The add is made again on the restart's options, and that is what is
      // stored and answered: no older copy on disk or in memory.
      const last = saves[saves.length - 1];
      assert.equal(last.watchSensitivity, 'high');
      assert.deepEqual(ids(last.watchRules), ['r-a', 'r-c', 'r-b']);
      assert.deepEqual(ids(reply.body.rules), ['r-a', 'r-c', 'r-b']);
    } finally {
      plugin.stop();
    }
  });

  it('writes nothing for a save that waits in the queue while the plugin stops', async () => {
    const host = createHost();
    let finish;
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      if (saves.length === 1) finish = done;
      else done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ watchEnabled: true, watchSensitivity: 'low' });
    const first = routes['POST /watch/rules/add']({ body: { rule: rule('r-a') } }, recorder());
    await new Promise((resolve) => setImmediate(resolve));
    const queuedReply = recorder();
    const queued = routes['POST /watch/rules/add']({ body: { rule: rule('r-b', 370) } }, queuedReply);
    plugin.stop();
    finish();
    await first;
    await queued;
    assert.equal(saves.length, 1, 'the queued save must not store just its own change over the stopped options');
    assert.equal(saves[0].watchSensitivity, 'low');
    assert.equal(queuedReply.statusCode, 503);
  });

  it('refuses a hand-written watch that a measurement can never meet', async () => {
    const writer = { skPrincipal: { permissions: 'admin' } };
    const host = createHost();
    host.savePluginOptions = (options, done) => done();
    const { plugin, routes } = routesFor(host);
    plugin.start({ watchEnabled: true });
    try {
      host.deltaCallback({ context: 'vessels.self', updates: [{ values: [{ path: 'propulsion.main.coolantTemperature', value: 353 }] }] });
      const bad = { id: 'r-bad', text: 'x', path: 'propulsion.main.coolantTemperature', op: 'equals', value: true, forSeconds: 0, severity: 'warn', source: 'manual' };
      const added = recorder();
      await routes['POST /watch/rules/add']({ ...writer, body: { rule: bad } }, added);
      assert.equal(added.statusCode, 400);
      assert.match(added.body.error.message, /is a measurement/);
      const saved = recorder();
      await routes['POST /watch/rules/save']({ ...writer, body: { rules: [bad] } }, saved);
      assert.equal(saved.statusCode, 400);
    } finally {
      plugin.stop();
    }
  });

  it('does not lock a stored watch, or the rest of the list, out of saving', async () => {
    const writer = { skPrincipal: { permissions: 'admin' } };
    const legacy = { id: 'r-legacy', text: 'hot', path: 'propulsion.main.coolantTemperature', op: 'equals', value: 'hot', forSeconds: 0, severity: 'warn', source: 'manual', createdAt: 1 };
    const good = { id: 'r-good', text: 'warm', path: 'propulsion.main.coolantTemperature', op: 'above', value: 360, forSeconds: 0, severity: 'warn', source: 'manual', createdAt: 2 };
    const host = createHost();
    host.savePluginOptions = (options, done) => done();
    const { plugin, routes } = routesFor(host);
    // Stored before the measurement check existed.
    plugin.start({ watchEnabled: true, watchRules: [legacy] });
    try {
      const saved = recorder();
      await routes['POST /watch/rules/save']({ ...writer, body: { rules: [legacy, good] } }, saved);
      assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
      const readded = recorder();
      await routes['POST /watch/rules/add']({ ...writer, body: { rule: legacy } }, readded);
      assert.equal(readded.statusCode, 200);
    } finally {
      plugin.stop();
    }
  });

  it('keeps two id-less watches that differ only in their duration', async () => {
    const writer = { skPrincipal: { permissions: 'admin' } };
    const host = createHost();
    host.savePluginOptions = (options, done) => {
      host.saved = options;
      done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ watchEnabled: true });
    try {
      const base = { text: 'hot', path: 'propulsion.main.temperature', op: 'above', value: 360, severity: 'warn' };
      await routes['POST /watch/rules/add']({ ...writer, body: { rule: { ...base, forSeconds: 30 } } }, recorder());
      await routes['POST /watch/rules/add']({ ...writer, body: { rule: { ...base, forSeconds: 600 } } }, recorder());
      assert.deepEqual(host.saved.watchRules.map((item) => item.forSeconds).sort((a, b) => a - b), [30, 600]);
      // The same rule again, without an id, is the same watch: not a third.
      await routes['POST /watch/rules/add']({ ...writer, body: { rule: { ...base, forSeconds: 30 } } }, recorder());
      assert.equal(host.saved.watchRules.length, 2);
    } finally {
      plugin.stop();
    }
  });

  it('numbers a copy afresh when its save is redone after a restart', async () => {
    const writer = { skPrincipal: { permissions: 'admin' } };
    const base = { text: 'hot', path: 'propulsion.main.temperature', op: 'above', value: 360, severity: 'warn', forSeconds: 0 };
    const { normalizeRules } = require('../lib/watch/rules.cjs');
    const [derived] = normalizeRules([base]);
    // A different rule already holds the derived id.
    const holder = { ...base, id: derived.id, value: 999, text: 'other' };
    const host = createHost();
    let finish;
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      if (saves.length === 1) finish = done;
      else done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ watchEnabled: true, watchRules: [holder] });
    try {
      const adding = routes['POST /watch/rules/add']({ ...writer, body: { rule: base } }, recorder());
      await new Promise((resolve) => setImmediate(resolve));
      plugin.stop();
      // The restart brings the same holder and a different -2 copy.
      plugin.start({ watchEnabled: true, watchRules: [holder, { ...holder, id: `${derived.id}-2`, value: 998 }] });
      finish();
      await adding;
      const ids = saves[saves.length - 1].watchRules.map((rule) => rule.id);
      assert.ok(ids.includes(`${derived.id}-3`), JSON.stringify(ids));
      assert.ok(!ids.some((id) => id.endsWith('-2-2')), JSON.stringify(ids));
    } finally {
      plugin.stop();
    }
  });

  it('does not add a rule twice when the plugin restarts from the options its save stored', async () => {
    const writer = { skPrincipal: { permissions: 'admin' } };
    const base = { text: 'hot', path: 'propulsion.main.temperature', op: 'above', value: 360, severity: 'warn', forSeconds: 0 };
    const { normalizeRules } = require('../lib/watch/rules.cjs');
    const [derived] = normalizeRules([base]);
    // With and without a different rule already holding the derived id.
    for (const stored of [[], [{ ...base, id: derived.id, value: 999, text: 'other' }]]) {
      const host = createHost();
      let finish;
      const saves = [];
      host.savePluginOptions = (options, done) => {
        saves.push(options);
        if (saves.length === 1) finish = done;
        else done();
      };
      const { plugin, routes } = routesFor(host);
      plugin.start({ watchEnabled: true, watchRules: stored });
      try {
        const reply = recorder();
        const adding = routes['POST /watch/rules/add']({ ...writer, body: { rule: base } }, reply);
        await new Promise((resolve) => setImmediate(resolve));
        const written = saves[0].watchRules.map((rule) => rule.id);
        // The server restarts the plugin on the options just written.
        plugin.stop();
        plugin.start({ ...saves[0] });
        finish();
        await adding;
        assert.equal(reply.statusCode, 200);
        assert.deepEqual(saves[saves.length - 1].watchRules.map((rule) => rule.id), written, 'no numbered copy of itself');
        assert.deepEqual(reply.body.rules.map((rule) => rule.id), written);
      } finally {
        plugin.stop();
      }
    }
  });

  it('answers a remove as done when the plugin restarts from the options its save stored', async () => {
    const writer = { skPrincipal: { permissions: 'admin' } };
    const rule = { id: 'r-gone', text: 'x', path: 'propulsion.main.temperature', op: 'above', value: 360, forSeconds: 0, severity: 'warn' };
    const host = createHost();
    let finish;
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      if (saves.length === 1) finish = done;
      else done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ watchEnabled: true, watchRules: [rule] });
    try {
      const reply = recorder();
      const removing = routes['POST /watch/rules/remove']({ ...writer, body: { id: 'r-gone' } }, reply);
      await new Promise((resolve) => setImmediate(resolve));
      plugin.stop();
      plugin.start({ ...saves[0] });
      finish();
      await removing;
      assert.equal(reply.statusCode, 200);
      assert.deepEqual(reply.body.rules, []);
    } finally {
      plugin.stop();
    }
  });

  it('answers a remove as done when a restart lands during its save', async () => {
    const writer = { skPrincipal: { permissions: 'admin' } };
    const rule = { id: 'r-gone', text: 'x', path: 'propulsion.main.temperature', op: 'above', value: 360, forSeconds: 0, severity: 'warn' };
    const host = createHost();
    let finish;
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      if (saves.length === 1) finish = done;
      else done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ watchEnabled: true, watchRules: [rule] });
    try {
      const reply = recorder();
      const removing = routes['POST /watch/rules/remove']({ ...writer, body: { id: 'r-gone' } }, reply);
      await new Promise((resolve) => setImmediate(resolve));
      // The plugin restarts on the options just written, without the rule.
      plugin.stop();
      plugin.start({ watchEnabled: true, watchRules: [] });
      finish();
      await removing;
      assert.equal(reply.statusCode, 200);
    } finally {
      plugin.stop();
    }
  });

  it('answers 409 when the plugin restarts during every attempt, and 503 when it is left stopped', async () => {
    for (const stopsAtLast of [false, true]) {
      const host = createHost();
      const options = { watchEnabled: true };
      let saves = 0;
      let plugin;
      host.savePluginOptions = (stored, done) => {
        saves += 1;
        plugin.stop();
        if (saves < 3 || !stopsAtLast) plugin.start({ ...options });
        done();
      };
      const created = routesFor(host);
      plugin = created.plugin;
      plugin.start({ ...options });
      try {
        const reply = recorder();
        await created.routes['POST /watch/rules/add']({ body: { rule: rule('r-busy') } }, reply);
        assert.equal(saves, 3);
        if (stopsAtLast) {
          assert.equal(reply.statusCode, 503);
          assert.equal(reply.body.error.code, 'disabled');
          assert.match(reply.body.error.message, /plugin stopped/);
        } else {
          assert.equal(reply.statusCode, 409);
          assert.match(reply.body.error.message, /kept restarting/);
        }
      } finally {
        plugin.stop();
      }
    }
  });

  it('answers a rule add as done when a restart that left no room is followed by one that does', async () => {
    const host = createHost();
    const full = Array.from({ length: 50 }, (_, index) => rule(`r-fill-${index}`, 300 + index));
    const saves = [];
    let plugin;
    host.savePluginOptions = (stored, done) => {
      saves.push(stored);
      // Restarted during the first write with 50 other rules (no room), and
      // during the second (putting those back) with none; the third lands.
      if (saves.length <= 2) {
        plugin.stop();
        plugin.start({ watchEnabled: true, watchRules: saves.length === 1 ? full : [] });
      }
      done();
    };
    const created = routesFor(host);
    plugin = created.plugin;
    plugin.start({ watchEnabled: true, watchRules: [] });
    try {
      const reply = recorder();
      await created.routes['POST /watch/rules/add']({ body: { rule: rule('r-new', 400) } }, reply);
      assert.equal(reply.statusCode, 200, JSON.stringify(reply.body));
      assert.ok(ids(saves[saves.length - 1].watchRules).includes('r-new'));
    } finally {
      plugin.stop();
    }
  });

  it('does not say the change was written when the last write put the restart\'s options back', async () => {
    const host = createHost();
    const full = Array.from({ length: 50 }, (_, index) => rule(`r-fill-${index}`, 300 + index));
    const saves = [];
    let plugin;
    host.savePluginOptions = (stored, done) => {
      saves.push(stored);
      plugin.stop();
      // Restarted with no room, then disabled while those options are put back.
      if (saves.length === 1) plugin.start({ watchEnabled: true, watchRules: full });
      done();
    };
    const created = routesFor(host);
    plugin = created.plugin;
    plugin.start({ watchEnabled: true, watchRules: [] });
    try {
      const reply = recorder();
      await created.routes['POST /watch/rules/add']({ body: { rule: rule('r-new', 400) } }, reply);
      assert.equal(saves.length, 2);
      assert.equal(reply.statusCode, 503);
      assert.doesNotMatch(reply.body.error.message, /change was written/);
      assert.match(reply.body.error.message, /the ones it restarted with/);
    } finally {
      plugin.stop();
    }
  });

  it('writes nothing for a watch change that changes nothing', async () => {
    const writer = { skPrincipal: { permissions: 'admin' } };
    const rule = (id, value) => ({ id, text: id, path: 'propulsion.main.temperature', op: 'above', value, forSeconds: 0, severity: 'warn' });
    const full = Array.from({ length: 50 }, (_, index) => rule(`r-fill-${index}`, 300 + index));
    // A host that cannot store settings: a refused add is a 409, not a 501.
    const host = createHost();
    const { plugin, routes } = routesFor(host);
    plugin.start({ watchEnabled: true, watchRules: full });
    try {
      const overflow = recorder();
      await routes['POST /watch/rules/add']({ ...writer, body: { rule: rule('r-new', 400) } }, overflow);
      assert.equal(overflow.statusCode, 409);
      const unknown = recorder();
      await routes['POST /watch/rules/remove']({ ...writer, body: { id: 'r-nope' } }, unknown);
      assert.equal(unknown.statusCode, 404, 'removing a rule that is not there is not reported as done');
      assert.equal(unknown.body.rules.length, 50);
    } finally {
      plugin.stop();
    }
    const counting = createHost();
    let writes = 0;
    counting.savePluginOptions = (options, done) => {
      writes += 1;
      done();
    };
    const second = routesFor(counting);
    second.plugin.start({ watchEnabled: true, watchRules: full });
    try {
      await second.routes['POST /watch/rules/add']({ ...writer, body: { rule: rule('r-new', 400) } }, recorder());
      await second.routes['POST /watch/rules/remove']({ ...writer, body: { id: 'r-nope' } }, recorder());
      assert.equal(writes, 0);
    } finally {
      second.plugin.stop();
    }
  });
});
