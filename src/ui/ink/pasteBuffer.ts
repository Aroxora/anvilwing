/**
 * pasteBuffer — Claude Code parity: a large multi-line paste collapses to a
 * compact `[Pasted text #N +M lines]` placeholder in the input box instead of
 * flooding it with the full content. The full text is held in a registry keyed
 * by the placeholder token and re-expanded at submit, so the model still
 * receives exactly what was pasted.
 *
 * Pure module (no Ink, no I/O) so the classify/expand logic is unit-testable
 * against the real artifact; Prompt.tsx owns the wiring.
 */

/**
 * A single paste chunk is collapsed when it carries at least this many lines.
 * Kept above the 3-line `multiline-paste` e2e case so small pastes still land
 * whole in the buffer — only pastes large enough to dominate the box collapse.
 */
export const PASTE_LINE_THRESHOLD = 6;

/**
 * Line count of `chunk` when it qualifies as a large paste (>= threshold
 * lines), else null. A terminating newline does not inflate the count.
 */
export function pasteLineCount(chunk: string): number | null {
  if (!chunk) return null;
  // Drop a single trailing line terminator so "a\nb\n" counts as 2, not 3.
  const body = chunk.replace(/[\r\n]+$/, '');
  if (!body) return null;
  const lines = body.split(/\r\n|\r|\n/).length;
  return lines >= PASTE_LINE_THRESHOLD ? lines : null;
}

/** The placeholder token rendered in the input box for paste `id`. */
export function pastePlaceholder(id: number, lines: number): string {
  return `[Pasted text #${id} +${lines} lines]`;
}

/**
 * Holds the full text of collapsed pastes for the lifetime of one input
 * composition. `register` stores a paste and returns its placeholder token;
 * `expand` swaps every stored token back to its content at submit time.
 */
export class PasteRegistry {
  private counter = 0;
  private readonly map = new Map<string, string>();

  /** Store `content` (a large paste of `lines` lines) and return its token. */
  register(content: string, lines: number): string {
    this.counter += 1;
    const token = pastePlaceholder(this.counter, lines);
    this.map.set(token, content);
    return token;
  }

  /**
   * Replace every stored placeholder token in `text` with its full content.
   * A token the user has edited (so it no longer matches) is left as-is —
   * the literal text is sent, never a silently-dropped paste.
   */
  expand(text: string): string {
    if (this.map.size === 0) return text;
    let out = text;
    for (const [token, content] of this.map) {
      out = out.split(token).join(content);
    }
    return out;
  }

  /** Forget all registered pastes (call when the buffer is cleared). */
  clear(): void {
    this.counter = 0;
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
