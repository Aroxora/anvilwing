/**
 * Streaming render bug-fixes — the two defects seen on a real long turn:
 *   BUG A: the same assistant body rendered ~30× (one ⏺ block per tool call).
 *   BUG B: spaces/punctuation dropped — "across 3"→"across3", "DONE:"→"DONE",
 *          "files\n\n- litho"→"fileslitho".
 *
 * Both were probe-verified (workflow wf_02a5c4ec):
 *   B is agentController.emitDelta dropping whitespace-/punctuation-only
 *     chunks (a leaked-reasoning guard mis-applied to legitimate streamed
 *     tokens), so the live + committed stream diverged from the canonical text.
 *   A is _finalizeStreamingIfAny committing the partial on every tool/system
 *     event while _pushAssistant deduped only against history[length-1]; the
 *     interleaved tool entry broke adjacency so the body stacked.
 *
 * Unit/behavioural here; the real-binary render proof is the subprocess
 * scenario in test/ink-controller.test.ts ('stream-dup-interleaved').
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { isNearDuplicateNarration, richerNarration, normalizeNarration } from '../src/ui/ink/narrationDedup';

const REPO = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf8');
const CONTROLLER = read('src', 'ui', 'ink', 'InkPromptController.ts');
const AGENT_CTRL = read('src', 'runtime', 'agentController.ts');

describe('BUG B source: emitDelta no longer drops whitespace/punctuation deltas', () => {
  test('the guard only skips truly-empty content (not whitespace-only)', () => {
    // Fail-before: `if (!content?.trim()) return;` dropped a " " / "\n\n" delta.
    expect(AGENT_CTRL).toMatch(/private emitDelta[\s\S]{0,900}if \(content == null \|\| content === ''\) \{\s*\n\s*return;/);
    // The isGarbageContent call (which dropped pure punctuation/whitespace) is
    // gone from the content-delta path: emitDelta's body no longer calls it.
    const emitBody = AGENT_CTRL.slice(
      AGENT_CTRL.indexOf('private emitDelta'),
      AGENT_CTRL.indexOf('private emitError'),
    );
    // The content-delta path no longer CALLS the garbage filter (the comment
    // may still reference it by name — match the call form).
    expect(emitBody).not.toMatch(/this\.isGarbageContent\(/);
  });

  test('behavioural: the fixed guard preserves inter-token spaces, the colon in DONE:, and \\n\\n', () => {
    // Faithful re-impl of OLD vs NEW guard on a token split that glued in the wild.
    const chunks = ['across', ' ', '3', ' ', 'files', '\n\n- ', 'litho.ts', ' ', 'DONE', ':', ' ', 'done'];
    const oldGuard = (c: string) => (!c || !c.trim() ? null : c);
    const newGuard = (c: string) => (c == null || c === '' ? null : c);
    const oldStream = chunks.map(oldGuard).filter((x): x is string => x !== null).join('');
    const newStream = chunks.map(newGuard).filter((x): x is string => x !== null).join('');
    expect(oldStream).toBe('across3files\n\n- litho.tsDONE:done'); // the bug
    expect(newStream).toContain('across 3 files');
    expect(newStream).toContain('\n\n- litho.ts');
    expect(newStream).toMatch(/DONE: done/);
  });
});

describe('BUG A comparator: dedup is space/punctuation-insensitive', () => {
  test('streamed (despaced) and canonical (spaced) collapse to one', () => {
    const despaced = 'Here is what was upgraded across3 files and11 vectors';
    const spaced = 'Here is what was upgraded across 3 files and 11 vectors';
    expect(isNearDuplicateNarration(despaced, spaced)).toBe(true);
    // richer keeps the canonical (longer, spaced) copy.
    expect(richerNarration(despaced, spaced)).toBe(spaced);
  });

  test('genuinely different narration is NOT collapsed', () => {
    expect(isNearDuplicateNarration('I edited the parser off-by-one', 'Now running the full test suite to confirm')).toBe(false);
    expect(isNearDuplicateNarration('the body of the response', 'Next steps: commit and push')).toBe(false);
  });

  test('normalizeNarration still collapses whitespace+punctuation runs', () => {
    expect(normalizeNarration('A,  B.  C')).toBe('a b c');
  });
});

describe('BUG A scope: _pushAssistant scans back past interleaved tool entries', () => {
  test('it no longer dedups against only history[length-1]', () => {
    expect(CONTROLLER).not.toMatch(/const last = this\.history\[this\.history\.length - 1\];\s*\n\s*if \(last && last\.kind === 'assistant'/);
  });

  test('it walks back to the nearest assistant entry, skipping non-assistant', () => {
    expect(CONTROLLER).toMatch(/for \(let i = start; i >= floor; i--\)/);
    expect(CONTROLLER).toMatch(/if \(!entry \|\| entry\.kind !== 'assistant'\) continue;/);
    expect(CONTROLLER).toMatch(/break; \/\/ the nearest assistant entry isn't a dup/);
  });
});
