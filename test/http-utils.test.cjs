'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTimedFetch } = require('../lib/http-utils.cjs');

/**
 * Hold the event loop open for the duration of `run`.
 *
 * The abort timer is deliberately unref'd so a discarded response can never
 * keep a process alive. A real fetch has an open socket doing that job; these
 * fakes do not, so without this the runner sees an idle loop and cancels the
 * test before the timeout it is exercising can fire.
 */
async function withEventLoopAlive(run) {
  const keepAlive = setInterval(() => {}, 10);
  try {
    return await run();
  } finally {
    clearInterval(keepAlive);
  }
}

/** A response whose headers arrive immediately but whose body never does. */
function stalledBodyResponse(signal) {
  const body = new ReadableStream({
    start(controller) {
      // Never enqueues. Only the abort signal ends it.
      signal.addEventListener('abort', () => controller.error(signal.reason ?? new Error('aborted')), {
        once: true
      });
    }
  });

  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

describe('createTimedFetch', () => {
  it('bounds the body read, not just the headers', async () => {
    // The failure this guards against: headers come back fast, then the peer
    // goes quiet. Clearing the timer once headers resolve leaves that hang
    // unbounded, which for a streamed chat is the whole response.
    const timedFetch = createTimedFetch(async (_input, init) => stalledBodyResponse(init.signal), 60);

    await withEventLoopAlive(async () => {
      const response = await timedFetch('http://localhost:11434/api/chat', { method: 'POST' });
      await assert.rejects(response.text(), (error) => error instanceof Error);
    });
  });

  it('releases the timer once the body is consumed', async () => {
    const timedFetch = createTimedFetch(
      async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
      60
    );

    const response = await timedFetch('http://localhost:11434/api/tags');
    assert.deepEqual(await response.json(), { ok: true });

    // The abort would fire well inside this window if the timer had survived.
    await new Promise((resolve) => setTimeout(resolve, 120));
  });

  it('passes through a response that carries no body', async () => {
    const timedFetch = createTimedFetch(async () => new Response(null, { status: 204 }), 1000);

    const response = await timedFetch('http://localhost:11434/api/ps');

    assert.equal(response.status, 204);
    assert.equal(response.body, null);
  });

  it('preserves status and headers through the wrapper', async () => {
    const timedFetch = createTimedFetch(
      async () =>
        new Response('nope', { status: 404, statusText: 'Not Found', headers: { 'x-trace': 'abc' } }),
      1000
    );

    const response = await timedFetch('http://localhost:11434/api/show');

    assert.equal(response.status, 404);
    assert.equal(response.ok, false);
    assert.equal(response.headers.get('x-trace'), 'abc');
    assert.equal(await response.text(), 'nope');
  });

  it('reports a timeout rather than a bare abort', async () => {
    const timedFetch = createTimedFetch(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      40
    );

    await withEventLoopAlive(() =>
      assert.rejects(timedFetch('http://localhost:11434/api/tags'), (error) => error.code === 'timeout')
    );
  });

  it('leaves a caller-supplied abort as the caller own', async () => {
    const controller = new AbortController();
    const timedFetch = createTimedFetch(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted by caller');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      10_000
    );

    const pending = timedFetch('http://localhost:11434/api/tags', { signal: controller.signal });
    controller.abort();

    await assert.rejects(pending, (error) => error.name === 'AbortError' && error.code !== 'timeout');
  });
});

describe('describeFetchFailure', () => {
  const { describeFetchFailure } = require('../lib/http-utils.cjs');
  const failed = (message, cause) => Object.assign(new Error(message), cause ? { cause } : {});

  it('drops the user-info of a URL, an @ in the password included', () => {
    for (const quoted of [
      'http://admin:secret@boat.example:3000',
      'http://admin:p@ssecret@boat.example:3000',
      'http://admin:p%40s%2Fsecret@boat.example',
      'http://me%40x.com:secret@boat.example',
      '//u:secretpw@boat.example',
      'HTTPS://admin:secret@boat.example',
      'http://admin@boat.example'
    ]) {
      const { message } = describeFetchFailure(failed(`could not reach ${quoted}/api`));
      assert.doesNotMatch(message, /secret|admin|me%40/, `${quoted} -> ${message}`);
      assert.match(message, /\/\/boat\.example(:3000)?\/api/, `${quoted} -> ${message}`);
    }
  });

  it('keeps the host that failed, and an @ that is not user-info', () => {
    for (const [text, kept] of [
      ['http://u:pw@one.example/x then user b@two.example', 'http://one.example/x then user b@two.example'],
      ['http://admin:pw@boat.example/plugins/@signalk/x', 'http://boat.example/plugins/@signalk/x'],
      ['GET http://boat.local:3000, then mail ops@boat.example', 'GET http://boat.local:3000, then mail ops@boat.example'],
      ['reach http://[::1]:3000/signalk/v2/api/history/values; skipper@boat.example', 'reach http://[::1]:3000/signalk/v2/api/history/values; skipper@boat.example'],
      ['http://[::1]:3000/x?paths=a@b', 'http://[::1]:3000/x?paths=a@b'],
      ['http://boat.example:3000/x?email=a@b.c', 'http://boat.example:3000/x?email=a@b.c'],
      ['{"url":"http://boat.local:3000","contact":"ops@boat.example"}', '{"url":"http://boat.local:3000","contact":"ops@boat.example"}'],
      ["url='http://boat.local:3000',user='ops@x'", "url='http://boat.local:3000',user='ops@x'"],
      ['<http://boat.local:3000>ops@x', '<http://boat.local:3000>ops@x'],
      ['http://boat.example\\@evil.example/x', 'http://boat.example\\@evil.example/x'],
      ['http://[::1]:3000//@(@?', 'http://[::1]:3000//@(@?']
    ]) {
      assert.equal(describeFetchFailure(failed(text)).message, text === kept ? text : kept, text);
    }
  });

  it('redacts in linear time, however long the text', () => {
    const started = Date.now();
    for (const text of ['a.'.repeat(50000), `${'a-'.repeat(50000)}:`, `${'a1+.-'.repeat(20000)}//a:b`, `//${'@'.repeat(100000)}x`]) {
      describeFetchFailure(failed(text));
    }
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
  });

  it('redacts each of two quoted URLs on its own', () => {
    const { message } = describeFetchFailure(
      failed('tried http://a:secret1@one.example/x then http://b:secret2@two.example/y')
    );
    assert.doesNotMatch(message, /secret/);
    assert.match(message, /one\.example/);
    assert.match(message, /two\.example/);
  });

  it('keeps a cause code only when it looks like one', () => {
    assert.equal(describeFetchFailure(failed('fetch failed', { code: 'ECONNREFUSED' })).detail, 'ECONNREFUSED');
    const odd = describeFetchFailure(failed('fetch failed', { code: 'http://u:p@h', message: 'x' }));
    assert.equal(odd.code, undefined);
    assert.doesNotMatch(String(odd.detail), /u:p@/);
  });

  it("gives the cause's own message when it has no code (fetch's bad port)", () => {
    const { code, detail } = describeFetchFailure(failed('fetch failed', new Error('bad port')));
    assert.equal(code, undefined);
    assert.equal(detail, 'bad port');
  });
});
