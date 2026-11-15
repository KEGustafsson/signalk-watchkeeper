'use strict';

function isAbortError(error) {
  return (typeof DOMException === 'function' && error instanceof DOMException)
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

// How long an error reply's body is waited for.
const ERROR_BODY_TIMEOUT_MS = 2000;

function createTimeoutError(timeoutMs) {
  const timeoutError = new Error(`The request timed out after ${timeoutMs} ms.`);
  timeoutError.code = 'timeout';
  return timeoutError;
}

/**
 * Re-expose a response body while keeping the request's abort timer armed until
 * the body is actually drained.
 *
 * Without this the timer is cleared as soon as the headers arrive, so a peer
 * that stalls mid-body never trips the timeout. That is the common failure on a
 * flaky link — headers come back fast, then the connection goes quiet.
 */
function monitorBody(body, cleanup, translateError, signal) {
  const reader = body.getReader();
  // The abort ends a read here too, not only when the underlying fetch
  // honours it: a body that never comes must not hold the reader.
  const aborted =
    signal && typeof signal.addEventListener === 'function'
      ? new Promise((resolve, reject) => {
          // Rejected before the reader is cancelled: cancelling settles a
          // pending read as done, which would otherwise win the race and end
          // the body as if it were complete.
          const fail = () => {
            reject(signal.reason ?? Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
            Promise.resolve(reader.cancel(signal.reason)).catch(() => {});
          };
          if (signal.aborted) fail();
          else signal.addEventListener('abort', fail, { once: true });
        })
      : undefined;
  if (aborted) aborted.catch(() => {});

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        cleanup();
        // The header phase converts our own timer's abort into a `timeout`
        // error; the body phase has to do the same or a stream that stalls
        // mid-answer surfaces as a bare AbortError with no `code`, which the
        // route ladder then reports as 502 "This operation was aborted".
        controller.error(translateError ? translateError(error) : error);
      }
    },
    cancel(reason) {
      cleanup();
      return reader.cancel(reason);
    }
  });
}

/**
 * Wrap a fetch implementation so every request is bounded by `timeoutMs` while
 * still honouring a caller-supplied AbortSignal. `timeoutMs <= 0` disables the
 * timeout but keeps the external-abort plumbing.
 *
 * The bound covers the whole exchange, headers and body, not just the headers.
 */
function createTimedFetch(fetchImpl, timeoutMs) {
  return async (input, init = {}) => {
    const controller = new AbortController();
    const externalSignal = init.signal;

    let removeAbortListener = null;
    if (externalSignal && typeof externalSignal.addEventListener === 'function') {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        const onAbort = () => controller.abort(externalSignal.reason);
        externalSignal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => externalSignal.removeEventListener('abort', onAbort);
      }
    }

    // The bound in force, and what a timeout error reports: the request's
    // own, or the shorter one an error reply's body gets.
    let limitMs = timeoutMs;
    const arm = (ms) => {
      const timer = setTimeout(() => controller.abort(), ms);
      // An abort timer must never be a reason for the process to stay
      // alive. A caller that discards a response without reading it would
      // otherwise hold the event loop open for the whole timeout.
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      return timer;
    };
    let timeout = timeoutMs > 0 ? arm(timeoutMs) : null;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      if (typeof removeAbortListener === 'function') {
        removeAbortListener();
      }
    };

    // Our timer fired, rather than the caller cancelling: the difference is
    // what separates "the server went quiet" from "the operator navigated
    // away", and only the first is a timeout.
    const asTimeout = (error) =>
      isAbortError(error) && !(externalSignal && externalSignal.aborted)
        ? createTimeoutError(limitMs)
        : error;

    let response;
    try {
      response = await fetchImpl(input, {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      cleanup();
      throw asTimeout(error);
    }

    // Nothing left to wait for: a status that carries no body (204/304),
    // which Response also refuses to reconstruct with one.
    if (!response.body) {
      cleanup();
      return response;
    }

    if (!response.ok) {
      // An error reply's body gets a short bound of its own, timeout or not:
      // a caller that reads it (an error message, the rule model's reply) must not
      // wait without end for a body that never comes, and one that never
      // touches it must not hold the timer, the abort listener and the
      // pooled connection for the full timeout either.
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      limitMs = timeoutMs > 0 ? Math.min(timeoutMs, ERROR_BODY_TIMEOUT_MS) : ERROR_BODY_TIMEOUT_MS;
      timeout = arm(limitMs);
    } else if (timeout === null) {
      cleanup();
      return response;
    }

    return new Response(monitorBody(response.body, cleanup, asTimeout, controller.signal), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
}

function resolveFetch(dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const error = new Error('Global fetch is not available.');
    error.code = 'unknown';
    throw error;
  }
  return fetchImpl;
}

/**
 * Text with the user-info part of every URL in it dropped: `user:pass@` or
 * `user@` between `//` and the host, up to the last `@` before the host's
 * end (`/`, `?`, `#` or whitespace), so an `@` inside the password counts as
 * the password's (`//admin:p@ss@host`). The host, its port and everything
 * after them are kept: an `@` in a path or query (`/x?email=a@b.c`) is not
 * user-info, nor is an IPv6 host (`//[::1]:3000`) or a port followed by
 * punctuation.
 *
 * This is the URL as fetch and URL serialise it, with any `/`, `?`, `#` or
 * space in a password percent-encoded. A URL typed with credentials is
 * refused before any request is made (historyServerUrl, ollamaUrl), so the
 * plugin never hands fetch one that could come back raw.
 *
 * The scheme is matched only where it starts (not after a letter, digit,
 * `+`, `.` or `-`), which keeps the match linear on long runs of such
 * characters.
 */
function redactUserInfo(text) {
  // User-info never holds `"<>\^`{|};=` unencoded (URL percent-encodes
  // them), so they end it like the host's own end does: a URL followed by a
  // quote, a bracket or a backslash and a later `@` keeps its host. A `,`
  // may be in a password, so `host:3000,ops@x` stays ambiguous. Without a
  // scheme, `//` starts a URL only at the start of a word, not inside a
  // path (`//@` after a host).
  const info = String.raw`[^\s/?#[\]@"<>\\^${'`'}{|};=]`;
  const pattern = new RegExp(
    String.raw`(?:((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:)|(?<![^\s"'(<[=,;]))\/\/${info}*(?:@${info}*)*@(?=[^\s/?#@"<>\\]+)`,
    'gi'
  );
  return String(text).replace(pattern, (match, scheme) => `${scheme || ''}//`);
}

/** A cause code as Node and undici give them (ECONNREFUSED, UND_ERR_SOCKET), nothing else. */
const CAUSE_CODE = /^[A-Z0-9_]+$/;

/**
 * Why a fetch threw, for an operator, without any credentials it quoted.
 * fetch reports every network failure as a bare "fetch failed" and keeps the
 * reason in `error.cause`, so its code is appended (ECONNREFUSED, ENOTFOUND,
 * ...). A URL with credentials in it (http://user:password@host) is quoted
 * back in fetch's own error, and fetch's errors for a URL it refuses quote
 * that URL whole, so only what comes before it is kept, and any user-info
 * part left is dropped. Resolves `{ message, code, detail }`: `code` is the
 * cause's code, and `detail` is what to append to the message - the code, or
 * when the cause has none (fetch's "bad port"), the cause's own message.
 */
function describeFetchFailure(error, fallback = 'Unknown failure.') {
  const raw = error instanceof Error ? error.message : error ? String(error) : fallback;
  const refused = /^(Request cannot be constructed from a URL that includes credentials|Failed to parse URL|Invalid URL)\b/i.exec(raw);
  const message = refused ? refused[1] : redactUserInfo(raw);
  const cause = error && error.cause;
  const codeOf = (item) => (item && typeof item.code === 'string' && CAUSE_CODE.test(item.code) ? item.code : undefined);
  let code = codeOf(cause);
  if (!code && cause && Array.isArray(cause.errors)) {
    code = cause.errors.map(codeOf).find(Boolean);
  }
  code = code && !message.includes(code) ? code : undefined;
  let detail = code;
  if (!detail && cause && typeof cause.message === 'string' && cause.message.trim()) {
    const said = redactUserInfo(cause.message.trim()).slice(0, 200);
    if (!message.includes(said)) detail = said;
  }
  return { message, code, detail };
}

module.exports = {
  ERROR_BODY_TIMEOUT_MS,
  createTimedFetch,
  createTimeoutError,
  describeFetchFailure,
  isAbortError,
  redactUserInfo,
  resolveFetch
};
