'use strict';

const { createTimedFetch, resolveFetch } = require('./http-utils.cjs');

/**
 * Signal K History API client, for replaying recorded history through the
 * watch.
 *
 * https://demo.signalk.org/documentation/Developing/REST_APIs/History_API.html
 *
 * Two reads: the paths a provider has recorded (`/history/paths`) and their
 * values over a window (`/history/values`, built by buildValuesUrl and read by
 * the replay). The operator's own session is forwarded to this server only;
 * any other server gets the configured History API key, or nothing.
 */

const HISTORY_API_PATH = '/signalk/v2/api/history';
const DEFAULT_HISTORY_TIMEOUT_MS = 30000;
const DEFAULT_SIGNALK_PORT = 3000;

// Hostnames that are this machine. Forwarding the operator's session to
// anything else would hand a third party a credential that is replayable
// against their own Signal K server.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function toBoundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

/**
 * Seconds from a duration or window size.
 *
 * Accepts what the History API documents (an integer number of seconds, or an
 * ISO 8601 duration such as `PT15M`) plus the `1s`/`1m`/`1h`/`1d` shorthand the
 * same document uses for `resolution`, because an operator who read that table
 * will reasonably type either one into either field.
 *
 * Returns undefined for anything it cannot read, so the caller can fall back to
 * its own default rather than sending a nonsense window to the provider.
 */
function parseDurationSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  const text = value.trim();
  if (text.length === 0) {
    return undefined;
  }

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Math.trunc(Number(text));
    return seconds > 0 ? seconds : undefined;
  }

  const shorthand = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i.exec(text);
  if (shorthand) {
    const amount = Number(shorthand[1]);
    const unit = shorthand[2].toLowerCase();
    const factor = unit.startsWith('w')
      ? 604800
      : unit.startsWith('d')
        ? 86400
        : unit.startsWith('h')
          ? 3600
          : unit.startsWith('m')
            ? 60
            : 1;
    const seconds = Math.trunc(amount * factor);
    return seconds > 0 ? seconds : undefined;
  }

  // Years and months are deliberately unsupported: neither has a fixed length
  // in seconds, and a window that silently means something different in
  // February is worse than one the operator has to spell out in days.
  const iso = /^P(?!$)(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?!$)(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
    text
  );
  if (!iso) {
    return undefined;
  }

  const [, weeks, days, hours, minutes, seconds] = iso;
  const total =
    (Number(weeks) || 0) * 604800 +
    (Number(days) || 0) * 86400 +
    (Number(hours) || 0) * 3600 +
    (Number(minutes) || 0) * 60 +
    (Number(seconds) || 0);

  const truncated = Math.trunc(total);
  return truncated > 0 ? truncated : undefined;
}

/**
 * Strip anything past the server root so both `http://localhost:3000` and a
 * pasted `http://localhost:3000/signalk/v2/api/history/values` work.
 */
function normalizeServerUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (text.length === 0) {
    return '';
  }

  return text
    .replace(/\/signalk\/v2\/api\/history(?:\/.*)?$/i, '')
    .replace(/\/signalk\/v[12]\/api(?:\/.*)?$/i, '')
    .replace(/\/+$/, '');
}

/**
 * Why a configured server URL cannot be used, or undefined. A URL with a user
 * name or password in it is never fetched (fetch refuses it, and quotes it
 * back whole in its error), so it is refused here, before it can reach a
 * message or the panel; the URL itself is not repeated.
 */
function serverUrlProblem(text) {
  if (!text) return undefined;
  let url;
  try {
    url = new URL(text);
  } catch {
    return 'is not a valid URL (start it with http:// or https://)';
  }
  if (url.username || url.password) {
    return 'has a user name or password in it; credentials in the URL are not supported, put a token in "History API key" instead';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'is not an http or https URL (start it with http:// or https://)';
  }
  if (url.search || url.hash || /[?#]/.test(text)) {
    // The API path is appended to it: after a ? or # it would not be a path.
    return 'has a query or a fragment in it; give only the server, for example http://boat.local:3000';
  }
  return undefined;
}

function normalizeHistoryConfig(options = {}, env = process.env) {
  return {
    ...(() => {
      // A setting of only spaces is blank, and does not hide the variable.
      const setting = String(options.historyServerUrl || '').trim();
      const fromEnv = !setting && Boolean(env.SIGNALK_WATCHKEEPER_HISTORY_URL);
      const raw = String(setting || env.SIGNALK_WATCHKEEPER_HISTORY_URL || '').trim();
      const url = normalizeServerUrl(raw);
      // Checked as written, too: normalising drops an API path and anything
      // after it, query and fragment included, which must still be refused.
      const problem = serverUrlProblem(url) || (raw ? serverUrlProblem(raw.replace(/\/+$/, '')) : undefined);
      if (!problem) return { historyServerUrl: url };
      // Named where the operator will find it: the setting, or the
      // environment variable when the setting is blank.
      const source = fromEnv ? 'SIGNALK_WATCHKEEPER_HISTORY_URL' : '"Signal K server URL"';
      return { historyServerUrl: '', historyServerUrlProblem: problem, historyServerUrlSource: source };
    })(),
    historyProvider: String(options.historyProvider || '').trim(),
    historyApiKey: String(options.historyApiKey || env.SIGNALK_WATCHKEEPER_HISTORY_API_KEY || '').trim(),
    historyTimeoutMs: toBoundedInteger(
      options.historyTimeoutMs ?? env.SIGNALK_WATCHKEEPER_HISTORY_TIMEOUT_MS,
      DEFAULT_HISTORY_TIMEOUT_MS,
      0,
      120000
    )
  };
}

/**
 * Where to call the History API, and who counts as this server there.
 *
 * With `historyServerUrl` set, that URL. Otherwise this is a loopback call
 * back into the process's own host: a loopback name is preferred over
 * whatever external hostname the server advertises, since mDNS names do not
 * always resolve from inside a container and loopback needs no DNS at all.
 * The port is the server's main listener (signalkListeners) and the host
 * `localhost`, so the derived URL is always one isOwnServer counts. `historyServerUrl` remains for
 * history served by a different Signal K instance on the boat.
 *
 * When the main listener's port is not known, there is no derived URL:
 * `baseUrl` is undefined and `unknown` says why, so that the paths and time
 * window are not sent to whatever else holds a guessed port.
 */
function resolveHistoryTarget(app, config) {
  const listeners = signalkListeners(app);
  const own = { ports: new Set(listeners.ports.map(String)), hosts: listeners.hosts, reason: listeners.reason };

  if (config.historyServerUrlProblem) {
    return {
      own,
      short: `the configured ${(config.historyServerUrlSource || 'Signal K server URL').replace(/"/g, '')} ${config.historyServerUrlProblem}`,
      unknown: `the configured ${config.historyServerUrlSource || '"Signal K server URL"'} ${config.historyServerUrlProblem}`
    };
  }
  if (config.historyServerUrl) {
    return { baseUrl: config.historyServerUrl, own };
  }
  if (!listeners.primary) {
    return {
      own,
      short: `the port is not known (${listeners.reason})`,
      unknown:
        `this Signal K server's port is not known (${listeners.reason}), so there is no address to call it on; ` +
        'set "Signal K server URL" to the address it serves on, with a "History API key", since the operator\'s ' +
        'session is not sent to a port that cannot be confirmed as this server'
    };
  }

  const scheme = listeners.ssl ? 'https' : 'http';
  const host = listeners.hosts.has('localhost')
    ? 'localhost'
    : listeners.hosts.has('127.0.0.1')
      ? '127.0.0.1'
      : '[::1]';

  return { baseUrl: `${scheme}://${host}:${listeners.primary}`, own };
}

/**
 * The History API base URL, for display: the URL resolveHistoryTarget would
 * call, or - when this server's port is not known and nothing is called - a
 * sentence saying so. Requests use resolveHistoryTarget.
 */
function resolveHistoryBaseUrl(app, config) {
  const target = resolveHistoryTarget(app, config);
  return target.baseUrl || `not called: ${target.short}`;
}

function buildValuesUrl(baseUrl, paths, window, config) {
  const params = new URLSearchParams();
  params.set('paths', paths.join(','));
  params.set('from', window.from);
  params.set('to', window.to);
  params.set('resolution', String(window.resolutionSeconds));
  if (config.historyProvider) {
    params.set('provider', config.historyProvider);
  }

  return `${baseUrl}${HISTORY_API_PATH}/values?${params.toString()}`;
}

/**
 * True when the History API being called is this machine's own server.
 *
 * Only a loopback target may be sent the operator's session, so a hostname
 * that does not parse, or that resolves anywhere else, is treated as remote.
 */
function isLoopbackTarget(baseUrl) {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function effectivePort(url) {
  return url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
}

const DEFAULT_SIGNALK_SSL_PORT = 3443;

function validPort(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number < 65536 ? number : undefined;
}

/**
 * The Signal K server in this process: which port its main listener is on,
 * and which loopback hostnames and ports reach it. Worked out from what the
 * plugin API offers (the server's settings, its environment, and
 * app.config.getExternalPort()); the listener object itself is a server
 * internal plugins may not use.
 *
 * The port is picked the way signalk-server's ports.js picks it:
 *
 * - http port: `Number(PORT) || settings.port || 3000`;
 * - with TLS on, the https port, `Number(SSLPORT) || settings.sslport || 3443`,
 *   is the main listener, and the http port carries the server's redirect to
 *   it. Only the value the server uses counts: with PORT set, settings.port is
 *   not a listener, and with SSLPORT set, settings.sslport is not one.
 * - under systemd socket activation (`LISTEN_FDS` > 0), which
 *   signalk-server-setup uses for every systemd install, the server listens
 *   on the socket systemd hands it and on none of those ports. Its port is
 *   then the server's advertised port (getExternalPort(): EXTERNALPORT, else
 *   proxy_port, else the configured port): signalk-server-setup writes
 *   EXTERNALPORT as the API socket's own port in every variant (3000, 80,
 *   3443 or 443); proxy_port and the configured port apply only to a
 *   hand-written unit without it. A unit whose EXTERNALPORT names a reverse
 *   proxy in front of this server sends the session to that proxy, which
 *   passes it to this server; docs/history.md describes the one case where
 *   that would be wrong.
 *
 * Outside socket activation, EXTERNALPORT and settings.proxy_port never
 * count: they are ports a reverse proxy publishes, not ones this process is
 * known to listen on.
 *
 * Node's listen() with no host binds the dual-stack wildcard (or 0.0.0.0 on
 * a host without IPv6, where nobody can bind [::1] either), and a systemd
 * ListenStream=<port> socket binds dual-stack by default, so every loopback
 * name reaches the listener; docs/history.md covers the v6only exception.
 *
 * `primary` is the main listener's port (undefined when unknown), `ports`
 * every listener's that counts, `hosts` the loopback hostnames that reach
 * them, `ssl` whether the main listener speaks TLS, and `reason` - set when
 * `ports` is empty - why no port counts.
 */
function signalkListeners(app) {
  const settings = (app && app.config && app.config.settings) || {};
  const ssl = Boolean(settings.ssl);
  const none = (reason) => ({ ssl, primary: undefined, ports: [], hosts: new Set(), reason });
  const hosts = new Set(LOOPBACK_HOSTNAMES);

  if (Number(process.env.LISTEN_FDS) > 0) {
    let advertised;
    try {
      advertised =
        typeof app?.config?.getExternalPort === 'function' ? app.config.getExternalPort() : process.env.EXTERNALPORT;
    } catch {
      advertised = undefined;
    }
    const port = validPort(advertised);
    return port
      ? { ssl, primary: port, ports: [port], hosts }
      : none('it was started by systemd socket activation and its advertised port (EXTERNALPORT) is not a valid TCP port');
  }
  const httpSetting = Number(process.env.PORT) || settings.port || DEFAULT_SIGNALK_PORT;
  const http = validPort(httpSetting);
  if (!ssl) {
    return http
      ? { ssl, primary: http, ports: [http], hosts }
      : none(`its configured port (${httpSetting}) is not a valid TCP port`);
  }
  const httpsSetting = Number(process.env.SSLPORT) || settings.sslport || DEFAULT_SIGNALK_SSL_PORT;
  const https = validPort(httpsSetting);
  if (!https) {
    return none(`its configured TLS port (${httpsSetting}) is not a valid TCP port`);
  }
  // The http port carries only the redirect to the advertised port: it is
  // not where history is read, and is not sent the session.
  return { ssl, primary: https, ports: [https], hosts };
}

/**
 * This Signal K server as isOwnServer takes it: the ports that count (as
 * strings), the loopback hostnames that reach them, and - when no port
 * counts - the reason (signalkListeners).
 */
function ownServer(app) {
  const { ports, hosts, reason } = signalkListeners(app);
  return { ports: new Set(ports.map(String)), hosts, ...(reason ? { reason } : {}) };
}

/** The ports this Signal K server listens on, as strings (ownServer). */
function ownServerPorts(app) {
  return ownServer(app).ports;
}

/**
 * True when `baseUrl` is this Signal K server: a loopback host that reaches
 * it, on one of the ports it listens on. `own` is ownServer(app); a Set or
 * array of ports (any loopback host), or a URL (its loopback host family and
 * port) are accepted too.
 *
 * Loopback alone is not enough. Any service on this machine is on loopback,
 * and a historyServerUrl of localhost at another port would hand that service
 * the operator's cookie or bearer token. The scheme is not compared: http and
 * https on the same local port are the same listener.
 */
function isOwnServer(baseUrl, own) {
  if (!own || !isLoopbackTarget(baseUrl)) {
    return false;
  }
  try {
    let ports;
    let hosts = LOOPBACK_HOSTNAMES;
    if (typeof own === 'string') {
      if (!isLoopbackTarget(own)) return false;
      ports = new Set([effectivePort(new URL(own))]);
    } else if (own instanceof Set || Array.isArray(own)) {
      ports = new Set(own);
    } else {
      ports = own.ports instanceof Set ? own.ports : new Set(own.ports || []);
      hosts = own.hosts instanceof Set ? own.hosts : new Set(own.hosts || []);
    }
    const url = new URL(baseUrl);
    return hosts.has(url.hostname.toLowerCase()) && ports.has(effectivePort(url));
  } catch {
    return false;
  }
}

/**
 * The 401/403 explanation for a target that was not sent the session and
 * had no key to send instead: a loopback URL that is not this server is
 * named as such, with what this server is - its ports and the names that
 * reach it, or why none is known - so an operator who typed their own
 * server's address can see why.
 */
function credentialHint(baseUrl, own, status) {
  if (isLoopbackTarget(baseUrl)) {
    let port = '';
    let host = 'localhost';
    try {
      const url = new URL(baseUrl);
      port = effectivePort(url);
      host = url.hostname;
    } catch {
      // Unparseable: the generic wording below still applies.
    }
    const ports = own instanceof Set || Array.isArray(own) ? new Set(own) : new Set((own && own.ports) || []);
    const hosts = own && !(own instanceof Set) && !Array.isArray(own) && own.hosts ? own.hosts : LOOPBACK_HOSTNAMES;
    const subject =
      `HTTP ${status}: ${host}${port ? ` port ${port}` : ''} is not recognised as this Signal K server`;
    if (ports.size === 0) {
      const reason = (own && own.reason) || 'no port of its is known';
      return (
        `${subject} (its port is not known: ${reason}), so the operator's session was not sent; ` +
        'give the server a credential in "History API key"'
      );
    }
    const reachedAt = [...hosts].filter((name) => name !== '::1');
    const where = reachedAt.length < LOOPBACK_HOSTNAMES.size - 1 ? `, reached at ${reachedAt.join(' or ')} only` : '';
    return (
      `${subject} (its ports: ${[...ports].join(', ')}${where}), so the operator's session was not sent; ` +
      'leave "Signal K server URL" blank to use this server, or give that service its own credential in "History API key"'
    );
  }
  return `HTTP ${status}: a history server other than this one needs its own credential in "History API key"`;
}

// Codes Node's TLS layer gives a certificate it does not accept.
const TLS_CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED'
]);

/**
 * Why a fetch threw, for an operator. fetch reports every network failure as
 * a bare "fetch failed" and keeps the reason in `error.cause`, so its code is
 * appended (ECONNREFUSED, ENOTFOUND, DEPTH_ZERO_SELF_SIGNED_CERT, ...), and a
 * certificate the TLS layer rejected comes with what makes it verify.
 */
function describeFetchError(error) {
  const raw = error instanceof Error ? error.message : error ? String(error) : 'Unknown history failure.';
  // A URL with credentials in it (http://user:password@host) is quoted back in
  // fetch's own error; this message reaches the panel,
  // so the user-info part is dropped.
  // fetch's own errors for a URL it refuses quote that URL whole, so only
  // what comes before it is kept.
  const refused = /^(Request cannot be constructed from a URL that includes credentials|Failed to parse URL|Invalid URL)\b/i.exec(raw);
  const message = refused ? refused[1] : raw.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1');
  const cause = error && error.cause;
  let code = cause && typeof cause.code === 'string' ? cause.code : undefined;
  if (!code && cause && Array.isArray(cause.errors)) {
    const inner = cause.errors.find((item) => item && typeof item.code === 'string');
    code = inner && inner.code;
  }
  if (!code || message.includes(code)) {
    return message;
  }
  if (!TLS_CERTIFICATE_CODES.has(code)) {
    return `${message}: ${code}`;
  }
  return (
    `${message}: ${code}, the server's TLS certificate is not trusted; for Signal K's own generated ` +
    'certificate (issued to localhost), start Signal K with NODE_EXTRA_CA_CERTS set to ssl-cert.pem in its ' +
    'configuration directory and call it as https://localhost, or trust the issuer of another server\'s ' +
    'certificate the same way'
  );
}

/**
 * The detail for a failed history response, given what the server said
 * (`serverDetail`). A 401/403 from a target that is not this server is
 * explained by what was sent to it: with `historyApiKey` configured that key
 * went, so the server's own error stands and the key is named as rejected;
 * with none, nothing went, and credentialHint says why the session did not.
 * Anything else - this server, or another status - keeps the server's error.
 */
function historyFailureDetail(baseUrl, own, status, config, serverDetail) {
  if ((status !== 401 && status !== 403) || isOwnServer(baseUrl, own)) {
    return serverDetail;
  }
  if (config && config.historyApiKey) {
    return `${serverDetail}; the configured "History API key" was sent and rejected`;
  }
  return credentialHint(baseUrl, own, status);
}

/**
 * Credentials for a server with security enabled.
 *
 * The History API is behind the same authentication as the rest of the REST
 * API, and a plugin has no session of its own. The operator asking for a
 * replay does: their cookie or bearer token arrives on the request that
 * reached /watch/replay, so the history read runs with exactly the access they
 * already have - no ambient credential, and no way for the plugin to read
 * history a user could not read themselves.
 *
 * That reasoning only holds for this server. `historyServerUrl` can point at
 * another Signal K instance, and a cookie minted by this server is replayable
 * against it - a misconfigured or hostile host would be handed the operator's
 * live session. So the session travels to this server only (a loopback name
 * that reaches it, on a port it listens on: `options.ownPorts` from
 * ownServer, or the host and port of `options.ownBaseUrl`); anything else -
 * another host, or
 * another service on this machine - gets `historyApiKey`, a credential issued
 * for that destination, or nothing.
 */
function historyRequestHeaders(baseUrl, config, options = {}) {
  const headers = { accept: 'application/json' };

  if (isOwnServer(baseUrl, options.ownPorts || options.ownBaseUrl)) {
    return { ...headers, ...(options.authHeaders || {}) };
  }

  if (config.historyApiKey) {
    headers.authorization = `Bearer ${config.historyApiKey}`;
  }

  return headers;
}

function authHeadersFromRequest(req) {
  const source = (req && req.headers) || {};
  const headers = {};

  if (typeof source.authorization === 'string' && source.authorization.length > 0) {
    headers.authorization = source.authorization;
  }
  if (typeof source.cookie === 'string' && source.cookie.length > 0) {
    headers.cookie = source.cookie;
  }

  return headers;
}

// How much of an error reply is read: enough for its first line or two. A
// provider answering 500 with megabytes is not read into memory whole.
const ERROR_BODY_BYTES = 4096;

/** At most `maxBytes` of a body as text, the rest cancelled unread. */
async function readTextBounded(response, maxBytes) {
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : undefined;
  if (!reader) {
    const text = typeof response.text === 'function' ? await response.text() : '';
    return String(text || '').slice(0, maxBytes);
  }
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value.buffer ?? value, value.byteOffset ?? 0, value.byteLength);
      // Only what is still within the limit is kept: a 64 MB first chunk is
      // not copied whole to be cut down afterwards.
      const kept = bytes.subarray(0, maxBytes - size);
      chunks.push(kept);
      size += kept.byteLength;
    }
  } finally {
    // Not awaited: a cancel that never settles must not hold the answer.
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {
      // Already closed.
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

async function readErrorMessage(response) {
  try {
    const text = await readTextBounded(response, ERROR_BODY_BYTES);
    const trimmed = String(text || '').trim();
    if (trimmed.length === 0) {
      return `HTTP ${response.status}`;
    }
    return `HTTP ${response.status}: ${trimmed.slice(0, 200)}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/**
 * The paths the History API has recorded data for, for a replay that was
 * not given its own list. The listing window is at least a day. Same
 * endpoint resolution and credential scoping as the values read - the
 * operator's session goes to a loopback server only, a remote one gets
 * historyApiKey - and failures come back as a `message`, never a throw.
 */
async function listHistoryPaths(app, config, dependencies = {}, options = {}) {
  const windowSeconds = Math.max(config.historyDurationSeconds || 0, 24 * 60 * 60);
  const { baseUrl, own: ownPorts, unknown } = resolveHistoryTarget(app, config);
  if (!baseUrl) {
    return { paths: [], windowSeconds, message: `Signal K History API was not called: ${unknown}.` };
  }
  const params = new URLSearchParams({ duration: String(windowSeconds) });
  // The same provider the values read will use: with several providers
  // installed, listing the default one's paths would offer the operator
  // series the configured provider cannot actually serve.
  if (config.historyProvider) {
    params.set('provider', config.historyProvider);
  }
  const url = `${baseUrl}${HISTORY_API_PATH}/paths?${params.toString()}`;

  try {
    const fetchImpl = createTimedFetch(resolveFetch(dependencies), config.historyTimeoutMs);
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: historyRequestHeaders(baseUrl, config, { ...options, ownPorts }),
      signal: options.signal
    });

    if (!response.ok) {
      const detail =
        response.status === 404
          ? 'the server has no history provider installed, or the History API is not available'
          : historyFailureDetail(baseUrl, ownPorts, response.status, config, await readErrorMessage(response));
      return { paths: [], windowSeconds, message: `Signal K History API returned an error (${detail}).` };
    }

    let payload;
    try {
      payload = await readJsonBounded(response);
    } catch (error) {
      return {
        paths: [],
        windowSeconds,
        message: `The Signal K History API path list could not be read (${error instanceof Error ? error.message : 'unparseable body'}).`
      };
    }
    const paths = (Array.isArray(payload) ? payload : [])
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .sort();

    return { paths: [...new Set(paths)], windowSeconds };
  } catch (error) {
    return { paths: [], windowSeconds, message: `Signal K History API is unreachable (${describeFetchError(error)}).` };
  }
}

// The most a History API response is read into memory. The plugin runs in
// the Signal K server's own process, so a provider that ignores the requested
// resolution must not be able to exhaust it: rows are bounded after parsing,
// and the body before.
const MAX_HISTORY_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * The response body parsed as JSON, read at most `maxBytes` far: past that
 * the read is cancelled and an error with code 'too-large' is thrown, before
 * the whole body is held. A declared Content-Length over the limit is refused
 * without reading.
 */
async function readJsonBounded(response, maxBytes = MAX_HISTORY_RESPONSE_BYTES) {
  const tooLarge = () => {
    const size = maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / (1024 * 1024))} MB` : `${maxBytes} bytes`;
    const error = new Error(`the response is larger than ${size}`);
    error.code = 'too-large';
    return error;
  };
  const declared = Number(response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel?.();
    } catch {
      // Nothing more to read either way.
    }
    throw tooLarge();
  }
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : undefined;
  // JSON as response.json() reads it: UTF-8, a leading byte-order mark
  // ignored.
  const parse = (text) => JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!reader) {
    // A body that cannot be streamed (a fetch polyfill, a test double): read
    // it, then check. Only a stream can be stopped part way.
    if (typeof response.text === 'function') {
      const text = await response.text();
      if (Buffer.byteLength(text) > maxBytes) throw tooLarge();
      return parse(text);
    }
    const parsed = await response.json();
    if (Buffer.byteLength(JSON.stringify(parsed) ?? '') > maxBytes) throw tooLarge();
    return parsed;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // Chunks are bytes from a real fetch; a string chunk (a hand-made
    // stream) is counted by its UTF-8 length rather than not at all.
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    if (!bytes || typeof bytes.byteLength !== 'number') {
      // Not awaited: a cancel that never settles must not hang the read.
      Promise.resolve(reader.cancel()).catch(() => {});
      throw new Error('the response body is not bytes');
    }
    size += bytes.byteLength;
    if (size > maxBytes) {
      // Not awaited: a cancel that never settles must not hang the read.
      Promise.resolve(reader.cancel()).catch(() => {});
      throw tooLarge();
    }
    chunks.push(bytes);
  }
  // A view (Uint8Array, DataView) or a buffer of any kind or realm.
  const asBuffer = (chunk) => {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return Buffer.from(new Uint8Array(chunk));
  };
  return parse(Buffer.concat(chunks.map(asBuffer)).toString('utf8'));
}

module.exports = {
  DEFAULT_HISTORY_TIMEOUT_MS,
  MAX_HISTORY_RESPONSE_BYTES,
  authHeadersFromRequest,
  buildValuesUrl,
  credentialHint,
  describeFetchError,
  historyFailureDetail,
  historyRequestHeaders,
  isOwnServer,
  listHistoryPaths,
  normalizeHistoryConfig,
  ownServer,
  ownServerPorts,
  parseDurationSeconds,
  readJsonBounded,
  readTextBounded,
  resolveHistoryBaseUrl,
  resolveHistoryTarget,
  signalkListeners
};
