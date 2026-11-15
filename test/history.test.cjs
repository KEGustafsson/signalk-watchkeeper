'use strict';

const { afterEach, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  authHeadersFromRequest,
  listHistoryPaths,
  buildValuesUrl,
  normalizeHistoryConfig,
  parseDurationSeconds,
  resolveHistoryBaseUrl
} = require('../lib/history-service.cjs');

// Which ports count as this server depends on the process environment, the
// way it does for Signal K itself. Every test runs with these cleared, so an
// ambient PORT or LISTEN_FDS on the machine running the suite cannot change
// a result, and gets them back afterwards.
const SIGNALK_PORT_ENV = ['PORT', 'SSLPORT', 'LISTEN_FDS', 'EXTERNALPORT'];

function clearSignalkPortEnv() {
  const saved = {};
  for (const key of SIGNALK_PORT_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreSignalkPortEnv(saved) {
  for (const key of SIGNALK_PORT_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

let ambientPortEnv;
beforeEach(() => {
  ambientPortEnv = clearSignalkPortEnv();
});
afterEach(() => {
  restoreSignalkPortEnv(ambientPortEnv);
});

/** Run `fn` with exactly `vars` of the port environment set, restoring it after. */
async function withSignalkEnv(vars, fn) {
  const saved = clearSignalkPortEnv();
  try {
    for (const [key, value] of Object.entries(vars)) process.env[key] = value;
    return await fn();
  } finally {
    restoreSignalkPortEnv(saved);
  }
}

function historyConfig(overrides = {}) {
  return normalizeHistoryConfig(overrides, {});
}

/**
 * One History API read, as the replay makes it: the recorded-path listing,
 * which resolves the server and scopes credentials the same way.
 */
function readHistory(app, config, dependencies, options) {
  return listHistoryPaths(app, config, dependencies, options);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** A History API stub that records the request and answers with `payload`. */
function historyFetch(payload, { status = 200, calls = [] } = {}) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return jsonResponse(payload, status);
  };
}

const SAMPLE_PAYLOAD = {
  context: 'vessels.urn:mrn:signalk:uuid:test-self',
  range: { from: '2026-04-11T09:00:00.000Z', to: '2026-04-11T10:00:00.000Z' },
  values: [
    { path: 'navigation.speedOverGround', method: 'average' },
    { path: 'navigation.courseOverGroundTrue', method: 'average' }
  ],
  data: [
    ['2026-04-11T09:00:00.000Z', 4, 0],
    ['2026-04-11T09:30:00.000Z', 6, Math.PI],
    ['2026-04-11T10:00:00.000Z', 5, null]
  ]
};

describe('history duration parsing', () => {
  it('reads ISO 8601 durations, shorthand and plain seconds', () => {
    assert.equal(parseDurationSeconds('PT15M'), 900);
    assert.equal(parseDurationSeconds('PT1H30M'), 5400);
    assert.equal(parseDurationSeconds('P1DT2H'), 93600);
    assert.equal(parseDurationSeconds('P2W'), 1209600);
    assert.equal(parseDurationSeconds('30m'), 1800);
    assert.equal(parseDurationSeconds('2h'), 7200);
    assert.equal(parseDurationSeconds('900'), 900);
    assert.equal(parseDurationSeconds(900), 900);
  });

  // A month is 28 to 31 days long, so PT1M-style precision is not available for
  // it. Reading it as "some number of seconds" would give the operator a window
  // that quietly changes length in February.
  it('rejects what it cannot read exactly', () => {
    assert.equal(parseDurationSeconds('P1Y'), undefined);
    assert.equal(parseDurationSeconds('P3M'), undefined);
    assert.equal(parseDurationSeconds('P'), undefined);
    assert.equal(parseDurationSeconds('PT'), undefined);
    assert.equal(parseDurationSeconds('last week'), undefined);
    assert.equal(parseDurationSeconds(''), undefined);
    assert.equal(parseDurationSeconds(0), undefined);
    assert.equal(parseDurationSeconds(-60), undefined);
  });
});

describe('history configuration', () => {
  it('defaults to this server, the default provider and a 30 s timeout', () => {
    const config = normalizeHistoryConfig({}, {});
    assert.equal(config.historyServerUrl, '');
    assert.equal(config.historyProvider, '');
    assert.equal(config.historyApiKey, '');
    assert.equal(config.historyTimeoutMs, 30000);
  });

  it('bounds the timeout', () => {
    assert.equal(normalizeHistoryConfig({ historyTimeoutMs: -5 }, {}).historyTimeoutMs, 0);
    assert.equal(normalizeHistoryConfig({ historyTimeoutMs: 10 ** 9 }, {}).historyTimeoutMs, 120000);
  });

  it('reads the server, key and timeout from the environment when the settings are blank', () => {
    const env = {
      SIGNALK_WATCHKEEPER_HISTORY_URL: 'http://nas.local:3000',
      SIGNALK_WATCHKEEPER_HISTORY_API_KEY: 'key',
      SIGNALK_WATCHKEEPER_HISTORY_TIMEOUT_MS: '9000'
    };
    const config = normalizeHistoryConfig({}, env);
    assert.equal(config.historyServerUrl, 'http://nas.local:3000');
    assert.equal(config.historyApiKey, 'key');
    assert.equal(config.historyTimeoutMs, 9000);
    assert.equal(normalizeHistoryConfig({ historyServerUrl: 'http://boat.local:3000' }, env).historyServerUrl, 'http://boat.local:3000');
  });

  it('refuses a server URL with credentials, a query or another scheme, naming where it came from', () => {
    for (const url of ['http://user:pw@nas.local:3000', 'http://nas.local:3000/?x=1', 'ftp://nas.local']) {
      const config = normalizeHistoryConfig({ historyServerUrl: url }, {});
      assert.equal(config.historyServerUrl, '', url);
      assert.ok(config.historyServerUrlProblem, url);
      assert.equal(config.historyServerUrlSource, '"Signal K server URL"');
    }
    const fromEnv = normalizeHistoryConfig({}, { SIGNALK_WATCHKEEPER_HISTORY_URL: 'not a url' });
    assert.equal(fromEnv.historyServerUrlSource, 'SIGNALK_WATCHKEEPER_HISTORY_URL');
  });
});

describe('history endpoint resolution', () => {
  it('calls this server on localhost, honouring its port and TLS setting', () => {
    assert.equal(
      resolveHistoryBaseUrl({ config: { settings: { port: 3001 } } }, historyConfig()),
      'http://localhost:3001'
    );
    assert.equal(
      resolveHistoryBaseUrl({ config: { settings: { sslport: 443, ssl: true } } }, historyConfig()),
      'https://localhost:443'
    );
    assert.equal(resolveHistoryBaseUrl({}, historyConfig()), 'http://localhost:3000');
  });

  // With TLS on, Signal K serves https on its SSL port and only a redirect on
  // `port`: speaking TLS to `port` would reach the redirect, not the API.
  it('calls a TLS server on its SSL port, not on the port carrying the redirect', () => {
    assert.equal(
      resolveHistoryBaseUrl({ config: { settings: { port: 443, ssl: true } } }, historyConfig()),
      'https://localhost:3443'
    );
  });

  it('accepts a configured URL with the API path already on it', () => {
    assert.equal(
      resolveHistoryBaseUrl({}, historyConfig({
        historyServerUrl: 'http://nas.local:3000/signalk/v2/api/history/values/'
      })),
      'http://nas.local:3000'
    );
  });

  it('builds a values request with the documented parameters', () => {
    const config = historyConfig({ historyProvider: 'signalk-parquet' });
    const window = { from: '2026-06-01T08:00:00.000Z', to: '2026-06-01T09:00:00.000Z', resolutionSeconds: 10 };
    const url = new URL(buildValuesUrl('http://localhost:3000', ['a:average', 'b'], window, config));

    assert.equal(url.pathname, '/signalk/v2/api/history/values');
    assert.equal(url.searchParams.get('paths'), 'a:average,b');
    assert.equal(url.searchParams.get('from'), window.from);
    assert.equal(url.searchParams.get('to'), window.to);
    assert.equal(url.searchParams.get('resolution'), String(window.resolutionSeconds));
    assert.equal(url.searchParams.get('provider'), 'signalk-parquet');
  });
});

// The panel's picker: what has the provider actually recorded?
describe('which ports are this server', () => {
  const { isOwnServer, ownServer, ownServerPorts } = require('../lib/history-service.cjs');
  const session = { authHeaders: { cookie: 'JAUTHENTICATION=token' } };

  async function cookieSentTo(app, historyServerUrl) {
    const calls = [];
    await readHistory(
      app,
      historyConfig({ ...(historyServerUrl ? { historyServerUrl } : {}) }),
      { fetchImpl: historyFetch(SAMPLE_PAYLOAD, { calls }) },
      session
    );
    return { url: calls[0].url, cookie: calls[0].init.headers.cookie };
  }

  // A signalk-server-setup install on port 80: systemd hands the server its
  // socket (LISTEN_FDS=1) and the unit sets EXTERNALPORT=80, the socket's own
  // port. Nothing listens on 3000 (Grafana, typically), which is not sent the
  // session.
  it('takes the socket-activated port from the advertised port, not the default 3000', async () => {
    await withSignalkEnv({ LISTEN_FDS: '1', EXTERNALPORT: '80' }, async () => {
      const app = { config: { settings: {}, getExternalPort: () => Number(process.env.EXTERNALPORT) || 3000 } };
      assert.deepEqual([...ownServerPorts(app)], ['80']);
      assert.equal(isOwnServer('http://localhost:3000', ownServer(app)), false);
      assert.equal(resolveHistoryBaseUrl(app, historyConfig()), 'http://localhost:80');
      assert.equal((await cookieSentTo(app, 'http://localhost:3000')).cookie, undefined);
      const own = await cookieSentTo(app);
      assert.match(own.url, /^http:\/\/localhost:80\/signalk\//);
      assert.equal(own.cookie, 'JAUTHENTICATION=token');
    });
  });

  // The same install on the default port: no EXTERNALPORT, and the server
  // advertises (and holds) 3000.
  it('keeps the session for a socket-activated server on the default port', async () => {
    await withSignalkEnv({ LISTEN_FDS: '1' }, async () => {
      const app = { config: { settings: {}, getExternalPort: () => 3000 } };
      assert.deepEqual([...ownServerPorts(app)], ['3000']);
      assert.equal((await cookieSentTo(app)).cookie, 'JAUTHENTICATION=token');
    });
  });

  // The listener object is a server internal that plugins may not use (the
  // Signal K plugin CI rejects it), so whatever it says is not read.
  it('does not read the server\'s internal listener', async () => {
    const app = { config: { settings: { port: 3000 } }, server: { address: () => assert.fail('the listener must not be read') } };
    assert.deepEqual([...ownServerPorts(app)], ['3000']);
  });

  // With no valid advertised port nothing names the socket, and nothing is
  // called on a guessed port.
  it('counts no port, and calls nothing, under socket activation without a valid advertised port', async () => {
    for (const app of [{ config: { settings: {} } }, { config: { settings: {}, getExternalPort: () => 'none' } }]) {
      await withSignalkEnv({ LISTEN_FDS: '1' }, async () => {
        assert.equal(ownServerPorts(app).size, 0);
        assert.equal(isOwnServer('http://localhost:3000', ownServer(app)), false);

        const history = await readHistory(
          app,
          historyConfig(),
          { fetchImpl: () => assert.fail('no request expected') },
          session
        );
        assert.match(history.message, /History API was not called: this Signal K server's port is not known/);
        assert.match(history.message, /socket activation/);

        const listing = await listHistoryPaths(app, historyConfig(), {
          fetchImpl: () => assert.fail('no request expected')
        });
        assert.deepEqual(listing.paths, []);
        assert.match(listing.message, /port is not known/);
      });
    }
  });

  // An operator who names the server explicitly when its port is unknown is
  // not told to "leave the URL blank" - blank would call nothing.
  it('words the 401 hint from why no port is known', async () => {
    await withSignalkEnv({ LISTEN_FDS: '1' }, async () => {
      const history = await readHistory(
        { config: { settings: {} } },
        historyConfig({ historyServerUrl: 'http://localhost:3000' }),
        { fetchImpl: async () => new Response('Unauthorized', { status: 401 }) },
        session
      );
      assert.match(history.message, /its port is not known: it was started by systemd socket activation/);
      assert.match(history.message, /History API key/);
      assert.doesNotMatch(history.message, /leave "Signal K server URL" blank/);
    });

    // Not socket activation: an invalid port is named as what it is.
    const invalid = await readHistory(
      { config: { settings: { port: 70000 } } },
      historyConfig({ historyServerUrl: 'http://localhost:3000' }),
      { fetchImpl: async () => new Response('Unauthorized', { status: 401 }) },
      session
    );
    assert.match(invalid.message, /its configured port \(70000\) is not a valid TCP port/);
    assert.doesNotMatch(invalid.message, /socket activation/);
  });

  it('does not call the default port when the configured one is invalid', async () => {
    const history = await readHistory(
      { config: { settings: { port: 70000 } } },
      historyConfig(),
      { fetchImpl: () => assert.fail('no request expected') },
      session
    );
    assert.match(history.message, /not called: this Signal K server's port is not known \(its configured port \(70000\)/);
  });

  it('does not replay against an unknown port', async () => {
    const { createWatchService } = require('../lib/watch-service.cjs');
    await withSignalkEnv({ LISTEN_FDS: '1' }, async () => {
      const host = {
        selfId: 'vessels.self',
        config: { settings: {} },
        setPluginStatus() {},
        handleMessage() {},
        getSelfPath() {}
      };
      const service = createWatchService(host, {
        now: () => Date.parse('2026-06-02T08:00:00Z'),
        fetchImpl: () => assert.fail('no request expected')
      });
      const result = await service.replay(
        { duration: 'PT1H', paths: ['propulsion.main.temperature'] },
        { historyTimeoutMs: 5000 }
      );
      assert.equal(result.ok, false);
      assert.match(result.message, /not called: this Signal K server's port is not known/);
    });
  });

  // With TLS on, the https port is the main listener; the http port carries
  // only the server's redirect, and is not where the plugin calls.
  it('calls the https port under TLS', async () => {
    const app = { config: { settings: { ssl: true, port: 3000 } } };
    assert.equal(resolveHistoryBaseUrl(app, historyConfig()), 'https://localhost:3443');
  });

  // Unchanged behaviour, kept as a guard: nobody else can hold either
  // loopback address on a port the dual-stack wildcard holds.
  it('trusts every loopback name for this server\'s port', async () => {
    const app = { config: { settings: {} } };
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      assert.equal((await cookieSentTo(app, url)).cookie, 'JAUTHENTICATION=token', url);
    }
  });

  // Signal K listens on Number(SSLPORT) || settings.sslport || 3443: with
  // SSLPORT set, the settings value is not a port it holds.
  it('counts SSLPORT instead of settings.sslport when both are set', async () => {
    await withSignalkEnv({ SSLPORT: '4443' }, async () => {
      const app = { config: { settings: { port: 3000, ssl: true, sslport: 3443 } } };
      assert.deepEqual([...ownServerPorts(app)], ['4443']);
      assert.equal(isOwnServer('https://localhost:3443', ownServerPorts(app)), false);
      assert.equal(resolveHistoryBaseUrl(app, historyConfig()), 'https://localhost:4443');
      assert.equal((await cookieSentTo(app, 'https://localhost:3443')).cookie, undefined);
    });
  });

  // Number(PORT) || settings.port || 3000: PORT wins, and the derived URL
  // uses the same port the own-port set does.
  it('counts PORT instead of settings.port, and calls the server there', async () => {
    await withSignalkEnv({ PORT: '8080' }, async () => {
      const app = { config: { settings: { port: 3000 } } };
      assert.deepEqual([...ownServerPorts(app)], ['8080']);
      assert.equal(resolveHistoryBaseUrl(app, historyConfig()), 'http://localhost:8080');
      const own = await cookieSentTo(app);
      assert.match(own.url, /^http:\/\/localhost:8080\//);
      assert.equal(own.cookie, 'JAUTHENTICATION=token');
      assert.equal((await cookieSentTo(app, 'http://localhost:3000')).cookie, undefined);
    });
  });

  // Without socket activation EXTERNALPORT is a reverse proxy's port: the
  // server is on its own port, and the proxy's is not sent the session.
  it('does not count EXTERNALPORT, or call it, outside socket activation', async () => {
    await withSignalkEnv({ EXTERNALPORT: '80' }, async () => {
      const app = { config: { settings: {}, getExternalPort: () => 80 } };
      assert.deepEqual([...ownServerPorts(app)], ['3000']);
      assert.equal(resolveHistoryBaseUrl(app, historyConfig()), 'http://localhost:3000');
      assert.equal((await cookieSentTo(app, 'http://localhost:80')).cookie, undefined);
    });
  });
});

// fetch reports every network failure as "fetch failed" and keeps the reason
// in error.cause; without its code an operator cannot tell a refused
// connection from a certificate Node will not accept.
describe('a History API that cannot be reached', () => {
  function failingFetch(code, message = code) {
    return async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
    };
  }

  it('names the cause, and what makes a rejected certificate verify', async () => {
    const history = await readHistory(
      { config: { settings: { ssl: true } } },
      historyConfig(),
      { fetchImpl: failingFetch('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate') }
    );
    assert.match(history.message, /unreachable \(fetch failed: DEPTH_ZERO_SELF_SIGNED_CERT, the server's TLS certificate is not trusted/);
    assert.match(history.message, /NODE_EXTRA_CA_CERTS/);
    assert.match(history.message, /https:\/\/localhost/);
  });

  it('names a connection failure without the certificate advice', async () => {
    const history = await readHistory(
      {},
      historyConfig(),
      { fetchImpl: failingFetch('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:3000') }
    );
    assert.match(history.message, /unreachable \(fetch failed: ECONNREFUSED\)/);
    assert.doesNotMatch(history.message, /NODE_EXTRA_CA_CERTS/);

    // Both address families refused: the cause is an AggregateError whose
    // own code may be missing; the first inner code is the reason.
    const aggregate = await readHistory(
      {},
      historyConfig(),
      {
        fetchImpl: async () => {
          throw new TypeError('fetch failed', {
            cause: new AggregateError([Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })])
          });
        }
      }
    );
    assert.match(aggregate.message, /fetch failed: ECONNREFUSED/);
  });

  it('names the cause of a real refused connection', async () => {
    const net = require('node:net');
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));

    const history = await readHistory(
      {},
      historyConfig({ historyServerUrl: `http://127.0.0.1:${port}` }),
      {}
    );
    assert.match(history.message, /unreachable \(fetch failed: ECONNREFUSED\)/);
  });

  it('names the cause in the path listing', async () => {
    const result = await listHistoryPaths(
      {},
      historyConfig({ historyServerUrl: 'https://127.0.0.1:3443' }),
      { fetchImpl: failingFetch('ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames") }
    );
    assert.match(result.message, /unreachable \(fetch failed: ERR_TLS_CERT_ALTNAME_INVALID, the server's TLS certificate is not trusted/);
  });

  it('names the cause in a watch replay', async () => {
    const { createWatchService } = require('../lib/watch-service.cjs');
    const host = { selfId: 'vessels.self', setPluginStatus() {}, handleMessage() {}, getSelfPath() {} };
    const service = createWatchService(host, {
      now: () => Date.parse('2026-06-02T08:00:00Z'),
      fetchImpl: failingFetch('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain')
    });
    const result = await service.replay(
      { duration: 'PT1H', paths: ['propulsion.main.temperature'] },
      { historyTimeoutMs: 5000 }
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /could not be read \(fetch failed: SELF_SIGNED_CERT_IN_CHAIN, the server's TLS certificate is not trusted/);
  });
});

describe('a configured History API key that is rejected', () => {
  const rejecting = (status, body) => async () => new Response(body, { status });

  // The key was sent, so "the session was not sent, configure a key" would
  // be wrong advice: the server's own reason is what the operator needs.
  it("keeps the remote server's error and says the key was rejected", async () => {
    const history = await readHistory(
      {},
      historyConfig({
        
        historyServerUrl: 'https://other-boat.example',
        historyApiKey: 'expired-token'
      }),
      { fetchImpl: rejecting(401, 'token expired') }
    );
    assert.match(history.message, /HTTP 401: token expired/);
    assert.match(history.message, /configured "History API key" was sent and rejected/);
    assert.doesNotMatch(history.message, /needs its own credential/);
  });

  it('does the same for a local service at another port', async () => {
    const history = await readHistory(
      { config: { settings: { port: 3000 } } },
      historyConfig({
        
        historyServerUrl: 'http://localhost:8086',
        historyApiKey: 'wrong-token'
      }),
      { fetchImpl: rejecting(403, 'insufficient scope') }
    );
    assert.match(history.message, /HTTP 403: insufficient scope/);
    assert.match(history.message, /was sent and rejected/);
    assert.doesNotMatch(history.message, /not recognised as this Signal K server/);
  });

  it('says so in the path listing', async () => {
    const result = await listHistoryPaths(
      {},
      historyConfig({ historyServerUrl: 'https://other-boat.example', historyApiKey: 'expired-token' }),
      { fetchImpl: rejecting(401, 'token expired') }
    );
    assert.match(result.message, /HTTP 401: token expired/);
    assert.match(result.message, /was sent and rejected/);

    // With no key configured nothing was sent, and the hint still says so.
    const unkeyed = await listHistoryPaths(
      {},
      historyConfig({ historyServerUrl: 'https://other-boat.example' }),
      { fetchImpl: rejecting(401, 'Unauthorized') }
    );
    assert.match(unkeyed.message, /needs its own credential in "History API key"/);
  });

  it('says so in a watch replay', async () => {
    const { createWatchService } = require('../lib/watch-service.cjs');
    const host = { selfId: 'vessels.self', setPluginStatus() {}, handleMessage() {}, getSelfPath() {} };
    const service = createWatchService(host, { now: () => Date.parse('2026-06-02T08:00:00Z'), fetchImpl: rejecting(401, '') });
    const result = await service.replay(
      { duration: 'PT1H', paths: ['propulsion.main.temperature'] },
      { historyServerUrl: 'https://other-boat.example', historyApiKey: 'expired-token', historyTimeoutMs: 5000 }
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /HTTP 401 for 1 paths; the configured "History API key" was sent and rejected/);
  });
});

describe('listHistoryPaths', () => {
  it('lists, trims, dedupes and sorts the recorded paths', async () => {
    const calls = [];
    const result = await listHistoryPaths(
      { config: { settings: { port: 3000 } } },
      historyConfig({ historyDuration: 'PT15M' }),
      {
        fetchImpl: async (url, init = {}) => {
          calls.push({ url: String(url), init });
          return jsonResponse(['b.path', ' a.path ', 'a.path', 42, '']);
        }
      },
      { authHeaders: { cookie: 'JAUTHENTICATION=token' } }
    );

    // The listing window is at least a day.
    assert.equal(calls[0].url, 'http://localhost:3000/signalk/v2/api/history/paths?duration=86400');
    assert.equal(calls[0].init.headers.cookie, 'JAUTHENTICATION=token');
    assert.deepEqual(result.paths, ['a.path', 'b.path']);
    assert.equal(result.windowSeconds, 86400);
    assert.equal(result.message, undefined);
  });

  it('asks the configured provider, the one the values read will use', async () => {
    const calls = [];
    await listHistoryPaths(
      {},
      historyConfig({ historyProvider: 'signalk-parquet' }),
      { fetchImpl: async (url, init = {}) => (calls.push(String(url)), jsonResponse([])) }
    );

    assert.match(calls[0], /[?&]provider=signalk-parquet\b/);
  });

  it('keeps the operator session off a remote server here too', async () => {
    const calls = [];
    await listHistoryPaths(
      {},
      historyConfig({ historyServerUrl: 'https://other-boat.example', historyApiKey: 'remote-token' }),
      { fetchImpl: async (url, init = {}) => (calls.push({ url: String(url), init }), jsonResponse([])) },
      { authHeaders: { cookie: 'JAUTHENTICATION=token' } }
    );

    assert.equal(calls[0].init.headers.cookie, undefined);
    assert.equal(calls[0].init.headers.authorization, 'Bearer remote-token');
  });

  it('explains a missing provider instead of throwing', async () => {
    const result = await listHistoryPaths({}, historyConfig(), {
      fetchImpl: async () => new Response('Not found', { status: 404 })
    });

    assert.deepEqual(result.paths, []);
    assert.match(result.message, /no history provider/i);

    const down = await listHistoryPaths({}, historyConfig(), {
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
      }
    });
    assert.match(down.message, /unreachable/i);
  });
});

describe('request credentials', () => {
  it('forwards a cookie or bearer token, and nothing else', () => {
    assert.deepEqual(
      authHeadersFromRequest({
        headers: {
          authorization: 'Bearer abc',
          cookie: 'JAUTHENTICATION=token',
          'user-agent': 'panel',
          host: 'boat.local'
        }
      }),
      { authorization: 'Bearer abc', cookie: 'JAUTHENTICATION=token' }
    );

    assert.deepEqual(authHeadersFromRequest(undefined), {});
    assert.deepEqual(authHeadersFromRequest({}), {});
  });
});

describe('reading a History API response', () => {
  const { readJsonBounded } = require('../lib/history-service.cjs');

  it('parses a body within the limit', async () => {
    assert.deepEqual(await readJsonBounded(new Response('{"a":1}'), 100), { a: 1 });
  });

  it('refuses a body past the limit, and a declared length past it without reading', async () => {
    await assert.rejects(readJsonBounded(new Response('x'.repeat(200)), 100), (error) => error.code === 'too-large');
    const declared = new Response('{}', { headers: { 'content-length': '500' } });
    await assert.rejects(readJsonBounded(declared, 100), (error) => error.code === 'too-large');
  });

  it('reads JSON as response.json() does: a leading byte-order mark is ignored', async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]);
    assert.deepEqual(await readJsonBounded(new Response(bom), 100), { a: 1 });
  });

  it('counts string chunks, and reads a double that offers only json()', async () => {
    const handMade = {
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
          for (let index = 0; index < 20; index += 1) controller.enqueue('"' + 'y'.repeat(100) + '",');
          controller.close();
        }
      })
    };
    await assert.rejects(readJsonBounded(handMade, 1000), (error) => error.code === 'too-large');
    assert.deepEqual(await readJsonBounded({ headers: new Headers(), json: async () => ({ b: 2 }) }, 100), { b: 2 });
    const arrayBuffers = {
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"c":').buffer);
          controller.enqueue(new TextEncoder().encode('3}').buffer);
          controller.close();
        }
      })
    };
    assert.deepEqual(await readJsonBounded(arrayBuffers, 100), { c: 3 });
    const shared = new SharedArrayBuffer(5);
    new Uint8Array(shared).set(new TextEncoder().encode('{"d":'));
    const views = {
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(shared);
          controller.enqueue(new DataView(new TextEncoder().encode('4}').buffer));
          controller.close();
        }
      })
    };
    assert.deepEqual(await readJsonBounded(views, 100), { d: 4 });
    await assert.rejects(readJsonBounded(new Response('x'.repeat(200)), 100), /larger than 100 bytes/);
  });

  it('refuses a server URL with a query or fragment after an API path', () => {
    for (const url of ['http://boat.example:3000/signalk/v2/api/history?provider=archive', 'http://boat.example:3000/signalk/v1/api#x']) {
      const config = normalizeHistoryConfig({ historyServerUrl: url }, {});
      assert.equal(config.historyServerUrl, '', url);
      assert.match(config.historyServerUrlProblem, /query or a fragment/, url);
    }
    assert.equal(normalizeHistoryConfig({ historyServerUrl: 'http://boat.example:3000/signalk/v2/api/history' }, {}).historyServerUrl, 'http://boat.example:3000');
  });

  it('reads an error reply at most a few kilobytes far', async () => {
    let pulled = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode('e'.repeat(1024 * 1024)));
      }
    });
    const history = await readHistory(
      { config: { settings: {} } },
      historyConfig({ historyServerUrl: 'http://boat.example:3000' }),
      { fetchImpl: async () => new Response(body, { status: 500 }) }
    );
    assert.match(history.message, /HTTP 500/);
    assert.ok(pulled <= 3, `${pulled} MB read of an error reply`);
  });

  it('does not wait on an error body whose cancel never settles', async () => {
    const { readTextBounded } = require('../lib/history-service.cjs');
    const stuck = {
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(8192).fill(101) }),
          cancel: () => new Promise(() => {})
        })
      }
    };
    const text = await Promise.race([readTextBounded(stuck, 4096), new Promise((resolve) => setTimeout(() => resolve('hung'), 500))]);
    assert.equal(text.length, 4096);
  });

  it('does not wait on the cancel of a body whose declared length is too large', async () => {
    const { readJsonBounded } = require('../lib/history-service.cjs');
    const declared = {
      headers: new Map([['content-length', String(64 * 1024 * 1024)]]),
      body: { cancel: () => new Promise(() => {}) }
    };
    const outcome = await Promise.race([
      readJsonBounded(declared).then(() => 'read', (error) => error.code || error.message),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 1000))
    ]);
    assert.equal(outcome, 'too-large');
  });

  it('does not wait on a too-large history body whose cancel never settles', async () => {
    const { readJsonBounded } = require('../lib/history-service.cjs');
    const stuck = {
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(1024 * 1024).fill(32) }),
          cancel: () => new Promise(() => {})
        })
      }
    };
    const outcome = await Promise.race([
      readJsonBounded(stuck, 4 * 1024 * 1024).then(() => 'read', (error) => error.code || error.message),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 1000))
    ]);
    assert.equal(outcome, 'too-large');
  });

  it('keeps only the bytes within the error-body limit, however large the first chunk', async () => {
    const { readTextBounded } = require('../lib/history-service.cjs');
    const kept = [];
    const realConcat = Buffer.concat;
    Buffer.concat = (list, ...rest) => {
      kept.push(list.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      return realConcat(list, ...rest);
    };
    try {
      const big = new Response(new Uint8Array(8 * 1024 * 1024).fill(101), { status: 500 });
      const text = await readTextBounded(big, 4096);
      assert.equal(text.length, 4096);
    } finally {
      Buffer.concat = realConcat;
    }
    assert.ok(kept.every((size) => size <= 4096), `concatenated ${Math.max(...kept)} bytes`);
  });

  it('turns a too-large history response into a message, not a crash', async () => {
    const history = await readHistory(
      { config: { settings: {} } },
      historyConfig({ historyServerUrl: 'http://boat.example:3000' }),
      { fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } }) }
    );
    assert.match(history.message, /could not be read \(the response is larger than 16 MB\)/);
  });
});

describe('a server URL that must not be called or quoted', () => {
  const app = { config: { settings: {} } };
  const SECRETS = /hunter2|p@ss|pa\/ss|retpw|admin/;

  it('never calls, or repeats, a server URL with credentials in it', async () => {
    for (const url of [
      'http://admin:hunter2@boat.example:3000',
      'http://admin:p@ss@boat.example:3000',
      'http://admin:pa/ss@boat.example:3000',
      'http://user:sec retpw@boat.example:3000',
      'http:admin:hunter2@boat.example'
    ]) {
      const calls = [];
      const listing = await listHistoryPaths(app, historyConfig({ historyServerUrl: url }), {
        fetchImpl: async (requested) => {
          calls.push(String(requested));
          return new Response('[]', { status: 200 });
        }
      });
      assert.equal(calls.length, 0, `${url} was called: ${calls.join(', ')}`);
      assert.doesNotMatch(listing.message, SECRETS, url);
      assert.match(resolveHistoryBaseUrl(app, historyConfig({ historyServerUrl: url })), /^not called: the configured Signal K server URL /, url);
    }
  });

  it('never calls one in a replay either', async () => {
    const { createWatchService } = require('../lib/watch-service.cjs');
    const host = { selfId: 'vessels.self', config: { settings: {} }, setPluginStatus() {}, handleMessage() {}, getSelfPath() {} };
    const calls = [];
    const service = createWatchService(host, {
      now: () => Date.parse('2026-06-02T08:00:00Z'),
      fetchImpl: async (requested) => {
        calls.push(String(requested));
        return new Response('[]', { status: 200 });
      }
    });
    service.start({ watchEnabled: true });
    try {
      const url = 'http://admin:hunter2@boat.example:3000';
      // As the plugin hands it over, and raw: neither is called.
      for (const config of [normalizeHistoryConfig({ historyServerUrl: url }, {}), { historyServerUrl: url }]) {
        const result = await service.replay({ duration: 'PT1H' }, config);
        assert.equal(calls.length, 0, `called: ${calls.join(', ')}`);
        assert.equal(result.ok, false);
        assert.match(result.message, /not called/);
        assert.doesNotMatch(JSON.stringify(result), SECRETS);
      }
    } finally {
      service.stop();
    }
  });

  it('refuses a URL ending in an empty query or fragment, and reads a blank setting as blank', async () => {
    for (const url of ['http://boat.local:3000?', 'http://boat.local:3000/#']) {
      assert.match(resolveHistoryBaseUrl(app, historyConfig({ historyServerUrl: url })), /has a query or a fragment/, url);
      let called = 0;
      const listing = await listHistoryPaths(app, historyConfig({ historyServerUrl: url }), {
        fetchImpl: async () => {
          called += 1;
          return new Response('[]', { status: 200 });
        }
      });
      assert.equal(called, 0, url);
      assert.match(listing.message, /has a query or a fragment/, url);
    }
    const spaces = normalizeHistoryConfig({ historyServerUrl: '   ' }, { SIGNALK_WATCHKEEPER_HISTORY_URL: 'ftp://x' });
    assert.match(resolveHistoryBaseUrl(app, spaces), /SIGNALK_WATCHKEEPER_HISTORY_URL is not an http or https URL/);
  });

  it('words fetch\'s parse failure without a dangling word', async () => {
    const listing = await listHistoryPaths(app, historyConfig({ historyServerUrl: 'http://boat.example:3000' }), {
      fetchImpl: async () => {
        const error = new TypeError('Failed to parse URL from http://admin:pa/ss@boat.example/x');
        error.cause = { code: 'ERR_INVALID_URL' };
        throw error;
      }
    });
    assert.doesNotMatch(listing.message, /from:|admin|pa\/ss/);
    assert.match(listing.message, /Failed to parse URL: ERR_INVALID_URL/);
  });

  it('keeps only the reason from fetch\'s own refusal of a URL', async () => {
    const listing = await listHistoryPaths(app, historyConfig({ historyServerUrl: 'http://boat.example:3000' }), {
      fetchImpl: async () => {
        throw new TypeError('Request cannot be constructed from a URL that includes credentials: http://user:sec retpw@boat.example/x');
      }
    });
    assert.doesNotMatch(listing.message, /retpw|user:/);
    assert.match(listing.message, /Request cannot be constructed from a URL that includes credentials/);
  });

  it('does not repeat credentials that reach a fetch error some other way', async () => {
    const listing = await listHistoryPaths(app, historyConfig({ historyServerUrl: 'http://boat.example:3000' }), {
      fetchImpl: async () => {
        throw new TypeError('Request failed for http://admin:p@ss@boat.example:3000/x?email=a@b.c');
      }
    });
    assert.doesNotMatch(listing.message, /admin|p@ss|ss@/);
    assert.match(listing.message, /http:\/\/boat\.example:3000\/x\?email=a@b\.c/, 'text after the host is left alone');
  });
});
