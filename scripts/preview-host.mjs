/**
 * Local host for the embedded panel.
 *
 * Mounts the real plugin routes (`/plugins/signalk-watchkeeper/...`) on a
 * plain Node HTTP server, backed by a stub Signal K app, so `npm run dev` can
 * render the panel against the actual backend code instead of a dead endpoint.
 *
 *   node scripts/preview-host.mjs            # an empty watch
 *   node scripts/preview-host.mjs --demo     # play a scenario that goes wrong
 *
 * The panel reaches it through the Vite dev proxy; point that elsewhere with
 * SIGNALK_WATCHKEEPER_DEV_TARGET if you are running a real Signal K server.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const createPlugin = require('../index.cjs');

const watchDemo = process.argv.includes('--demo') || process.argv.includes('--watch-demo');
const previewPort = Number(process.env.PREVIEW_PORT || 3100);
const ROUTE_PREFIX = '/plugins/signalk-watchkeeper';

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function createSignalKAppShim() {
  const selfTree = {
    navigation: {
      position: { latitude: 60.1, longitude: 24.9 },
      speedOverGround: 5.4,
      courseOverGroundTrue: Math.PI
    },
    notifications: {
      'navigation.anchor': { state: 'alarm', message: 'Anchor drag detected' }
    }
  };

  return {
    selfId: 'urn:mrn:signalk:uuid:preview-vessel',
    setPluginStatus: (message) => console.log(`[plugin status] ${message}`),
    setPluginError: (message) => console.error(`[plugin error] ${message}`),
    // Stored for the life of the preview, so the panel's saves work.
    savePluginOptions: (options, callback) => {
      console.log('[plugin options saved]');
      callback();
    },
    debug: () => {},
    error: (message) => console.error(message),
    getSelfPath: (path) =>
      String(path)
        .split('.')
        .reduce((value, segment) => (value && typeof value === 'object' ? value[segment] : undefined), selfTree)
  };
}

function collectRoutes(plugin) {
  const routes = new Map();
  const register = (method) => (path, handler) => {
    routes.set(`${method} ${path}`, handler);
    return router;
  };
  const router = {
    get: register('GET'),
    post: register('POST'),
    put: register('PUT'),
    delete: register('DELETE'),
    patch: register('PATCH'),
    use: () => router
  };

  plugin.registerWithRouter(router);
  return routes;
}

function createResponseAdapter(res) {
  let statusCode = 200;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      sendJson(res, statusCode, payload);
      return this;
    },
    end(chunk) {
      res.end(chunk);
    }
  };
}

/**
 * A Watchkeeper scenario for the preview: 45 minutes of a normal passage are
 * pre-rolled on a shifted clock so the watch has a learned baseline, then the
 * live part goes wrong - the alternator stops charging, the engine runs hot,
 * the engine-room sensor drops off the bus, and the GNSS fix starts walking
 * east of dead reckoning. Findings appear in the panel within half a minute.
 */
function createWatchDemo() {
  let offset = 0;
  let emit;
  let seed = 42;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };
  const now = () => Date.now() + offset;
  const subscriptionmanager = {
    subscribe(command, unsubscribes, onError, onDelta) {
      emit = onDelta;
      unsubscribes.push(() => {
        emit = undefined;
      });
    }
  };
  const knots = 0.514444;
  let latitude = 60.1;
  let longitude = 24.9;
  let liveStart;

  const sample = (t) => {
    const live = liveStart !== undefined && t >= liveStart + 5000;
    const sinceLive = live ? (t - liveStart) / 1000 : 0;
    latitude += (6 * knots) / 111195;
    const drift = live ? (sinceLive * 15 * knots) / (111195 * Math.cos((latitude * Math.PI) / 180)) : 0;
    const values = [
      { path: 'propulsion.main.revolutions', value: 30 + 0.3 * rand() },
      { path: 'propulsion.main.temperature', value: (live ? 366 : 353.2) + 0.2 * rand() },
      { path: 'electrical.batteries.house.voltage', value: (live ? 12.5 : 13.9) + 0.02 * rand() },
      { path: 'electrical.batteries.house.current', value: (live ? -8 : 25) + rand() },
      { path: 'tanks.freshWater.main.currentLevel', value: 0.62 },
      { path: 'environment.outside.pressure', value: 101300 + 5 * rand() },
      { path: 'navigation.position', value: { latitude, longitude: longitude + drift } },
      { path: 'navigation.headingTrue', value: 0.002 * rand() },
      { path: 'navigation.speedThroughWater', value: 6 * knots + 0.05 * rand() },
      { path: 'navigation.gnss.satellites', value: 11 },
      { path: 'navigation.gnss.horizontalDilution', value: 0.8 }
    ];
    if (!live) {
      values.push({ path: 'environment.inside.engineRoom.temperature', value: 318 + 0.3 * rand() });
    }
    if (emit) {
      emit({ context: 'vessels.self', updates: [{ $source: 'demo.n2k', values }] });
    }
  };

  const run = () => {
    const prerollSeconds = 45 * 60;
    for (let i = prerollSeconds; i > 0; i -= 1) {
      offset = -i * 1000;
      sample(now());
    }
    offset = 0;
    liveStart = now();
    setInterval(() => sample(now()), 1000).unref();
    console.log('Watch demo: baseline learned; trouble starts in 5 s.');
  };

  return { now, subscriptionmanager, run };
}

async function main() {
  const demo = watchDemo ? createWatchDemo() : undefined;
  const shim = createSignalKAppShim();
  if (demo) {
    shim.subscriptionmanager = demo.subscriptionmanager;
  } else {
    shim.subscriptionmanager = { subscribe() {} };
  }
  const plugin = createPlugin(shim, demo ? { now: demo.now } : {});
  // Options as the admin page stores them: the switch, then a section.
  plugin.start({ watchEnabled: true, ...(demo ? { watching: { watchLearningMinutes: 20 } } : {}) });
  if (demo) {
    demo.run();
  }

  const routes = collectRoutes(plugin);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${previewPort}`);
    if (!url.pathname.startsWith(ROUTE_PREFIX)) {
      sendJson(res, 404, { error: { code: 'unknown', message: 'Not a plugin route.' } });
      return;
    }

    const handler = routes.get(`${req.method} ${url.pathname.slice(ROUTE_PREFIX.length)}`);
    if (!handler) {
      sendJson(res, 404, { error: { code: 'unknown', message: `No route for ${req.url}` } });
      return;
    }

    Promise.resolve(handler(req, createResponseAdapter(res))).catch((error) => {
      sendJson(res, 500, { error: { code: 'unknown', message: String(error) } });
    });
  });

  server.listen(previewPort, '127.0.0.1', () => {
    console.log(`Plugin preview host listening on http://127.0.0.1:${previewPort}${ROUTE_PREFIX}`);
    console.log('Run "npm run dev" in another shell, with');
    console.log(`  SIGNALK_WATCHKEEPER_DEV_TARGET=http://127.0.0.1:${previewPort}`);
  });

  const shutdown = () => {
    plugin.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
