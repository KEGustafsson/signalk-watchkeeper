'use strict';

function isAbortError(error) {
  return (typeof DOMException === 'function' && error instanceof DOMException)
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

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
function monitorBody(body, cleanup, translateError) {
  const reader = body.getReader();

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        cleanup();
        // The header phase converts our own timer's abort into a `timeout`
        // error; the body phase has to do the same, or a stream that stalls
        // mid-body surfaces as a bare AbortError with no `code`.
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

    const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    // An abort timer must never be a reason for the process to stay alive. A
    // caller that discards a response without reading it would otherwise hold
    // the event loop open for the whole timeout.
    if (timeout !== null && typeof timeout.unref === 'function') {
      timeout.unref();
    }
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
        ? createTimeoutError(timeoutMs)
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

    // Nothing left to wait for: no timer to hold, or a status that carries no
    // body (204/304), which Response also refuses to reconstruct with one.
    if (timeout === null || !response.body) {
      cleanup();
      return response;
    }

    // A caller that returns early on a non-2xx typically never touches the
    // body, so the drain-driven cleanup would never run and the timer, the
    // abort listener and the pooled connection would all be held for the full
    // timeout. Release them now and hand back the untouched body.
    if (!response.ok) {
      cleanup();
      return response;
    }

    return new Response(monitorBody(response.body, cleanup, asTimeout), {
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
 * Text with any user-info part of a URL in it dropped. Two shapes are
 * caught, with or without a scheme before the `//`:
 * - `//user:pass@host`, a password that may itself hold `@`: everything up
 *   to the last `@` before the path;
 * - a URL quoted raw, as typed, whose password holds `/`, `?`, `#` or a
 *   space (`//admin:pa/ss@host`): a `:` after `//` that is not a port
 *   (digits, then the end of the host) starts user-info, which runs to the
 *   next `@` on the line.
 * A host and port (`//boat:3000/x?email=a@b.c`) and the path after it are
 * left alone.
 */
function redactUserInfo(text) {
  return String(text)
    .replace(/((?:\b[a-z][a-z0-9+.-]*:)?\/\/)[^\s/?#]*@/gi, '$1')
    .replace(/((?:\b[a-z][a-z0-9+.-]*:)?\/\/)[^\s/?#@:]*:(?!\d*(?:[/?#\s]|$))[^@\n]*@/gi, '$1');
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
  createTimedFetch,
  createTimeoutError,
  describeFetchFailure,
  isAbortError,
  redactUserInfo,
  resolveFetch
};
