/**
 * Copying the panel's text to the clipboard.
 *
 * `navigator.clipboard` exists only on HTTPS or localhost, and most boats open
 * the admin UI over plain HTTP on the LAN. So a copy falls back to the older
 * `document.execCommand('copy')` on an off-screen textarea, and when that is
 * refused too the panel shows the text for the operator to copy by hand.
 */

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export interface TextAreaLike {
  value: string;
  style: { position: string; top: string; left: string; opacity: string };
  setAttribute(name: string, value: string): void;
  select(): void;
}

export interface DocumentLike {
  createElement(tag: 'textarea'): TextAreaLike;
  body: { appendChild(node: TextAreaLike): unknown; removeChild(node: TextAreaLike): unknown } | null;
  execCommand(command: 'copy'): boolean;
}

export interface CopyEnvironment {
  readonly clipboard?: ClipboardLike | null;
  readonly document?: DocumentLike | null;
}

/** How a copy went: through the clipboard API, the fallback, or not at all. */
export type CopyOutcome = 'clipboard' | 'fallback' | 'refused';

function defaultEnvironment(): CopyEnvironment {
  return {
    clipboard: typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null,
    document: typeof document !== 'undefined' ? (document as unknown as DocumentLike) : null
  };
}

/** The textarea fallback: works over plain HTTP where the clipboard API does not. */
function copyWithTextarea(text: string, doc: DocumentLike | null | undefined): boolean {
  if (!doc || !doc.body || typeof doc.execCommand !== 'function') return false;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  area.style.opacity = '0';
  doc.body.appendChild(area);
  try {
    area.select();
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    doc.body.removeChild(area);
  }
}

/** Copy `text`, trying the clipboard API first and the textarea fallback second. */
export async function copyText(text: string, environment: CopyEnvironment = defaultEnvironment()): Promise<CopyOutcome> {
  if (environment.clipboard) {
    try {
      await environment.clipboard.writeText(text);
      return 'clipboard';
    } catch {
      // Refused (no permission, not focused): try the fallback.
    }
  }
  return copyWithTextarea(text, environment.document) ? 'fallback' : 'refused';
}

/** How long a button says "Copied" before it reads as a button again. */
export const COPIED_MS = 2000;
