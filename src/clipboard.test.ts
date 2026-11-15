import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from './clipboard.js';
import type { DocumentLike, TextAreaLike } from './clipboard.js';

function fakeDocument(copies: boolean | 'throw') {
  const attached: TextAreaLike[] = [];
  const copied: string[] = [];
  let current: TextAreaLike | undefined;
  const doc: DocumentLike = {
    createElement: () => {
      const area: TextAreaLike = {
        value: '',
        style: { position: '', top: '', left: '', opacity: '' },
        setAttribute() {},
        select() {
          current = area;
        }
      };
      return area;
    },
    body: {
      appendChild: (node) => attached.push(node),
      removeChild: (node) => attached.splice(attached.indexOf(node), 1)
    },
    execCommand: () => {
      if (copies === 'throw') throw new Error('not allowed');
      if (copies && current) copied.push(current.value);
      return copies;
    }
  };
  return { doc, attached, copied };
}

describe('copyText', () => {
  it('uses the clipboard API where the browser offers it', async () => {
    const written: string[] = [];
    const { doc } = fakeDocument(true);
    const outcome = await copyText('hello', { clipboard: { writeText: async (text) => void written.push(text) }, document: doc });
    assert.equal(outcome, 'clipboard');
    assert.deepEqual(written, ['hello']);
  });

  it('falls back to a textarea over plain HTTP, where there is no clipboard API', async () => {
    const { doc, attached, copied } = fakeDocument(true);
    assert.equal(await copyText('over http', { clipboard: null, document: doc }), 'fallback');
    assert.deepEqual(copied, ['over http']);
    assert.equal(attached.length, 0, 'the textarea is removed again');
  });

  it('falls back when the clipboard API refuses', async () => {
    const { doc, copied } = fakeDocument(true);
    const refusing = { writeText: async () => Promise.reject(new Error('denied')) };
    assert.equal(await copyText('denied text', { clipboard: refusing, document: doc }), 'fallback');
    assert.deepEqual(copied, ['denied text']);
  });

  it('says so when neither way is allowed, so the text can be shown instead', async () => {
    for (const copies of [false, 'throw'] as const) {
      const { doc, attached } = fakeDocument(copies);
      assert.equal(await copyText('x', { clipboard: null, document: doc }), 'refused');
      assert.equal(attached.length, 0);
    }
    assert.equal(await copyText('x', { clipboard: null, document: null }), 'refused');
  });

  it('selects the whole text for iOS, and gives the focus back', async () => {
    const ranges: Array<[number, number]> = [];
    let focused = 0;
    const doc: DocumentLike = {
      createElement: () => ({
        value: '',
        style: { position: '', top: '', left: '', opacity: '' },
        setAttribute() {},
        select() {},
        setSelectionRange: (start: number, end: number) => void ranges.push([start, end])
      }),
      body: { appendChild: () => undefined, removeChild: () => undefined },
      execCommand: () => true,
      activeElement: { focus: () => void (focused += 1) }
    };
    assert.equal(await copyText('twelve chars', { clipboard: null, document: doc }), 'fallback');
    assert.deepEqual(ranges, [[0, 12]]);
    assert.equal(focused, 1);
  });
});
