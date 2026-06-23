/**
 * Large-paste placeholder (Claude Code parity): a multi-line paste collapses
 * to a compact `[Pasted text #N +M lines]` token in the input box and the full
 * text is re-expanded at submit. These tests run against the REAL pasteBuffer
 * module (no mocks) plus a source-string guard that Prompt.tsx keeps the wiring.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PASTE_LINE_THRESHOLD,
  pasteLineCount,
  pastePlaceholder,
  PasteRegistry,
} from '../src/ui/ink/pasteBuffer.js';

describe('pasteLineCount — when a chunk collapses', () => {
  test('a single line never collapses (typed text)', () => {
    expect(pasteLineCount('hello world')).toBeNull();
  });

  test('a small multi-line paste below threshold stays inline', () => {
    // The existing e2e `multiline-paste` (alpha/beta/gamma) must keep landing
    // whole in the buffer, not collapse.
    expect(pasteLineCount('alpha\nbeta\ngamma')).toBeNull();
  });

  test('a paste at the threshold collapses and reports its line count', () => {
    const chunk = Array.from({ length: PASTE_LINE_THRESHOLD }, (_, i) => `L${i}`).join('\n');
    expect(pasteLineCount(chunk)).toBe(PASTE_LINE_THRESHOLD);
  });

  test('a trailing newline does not inflate the count', () => {
    const lines = PASTE_LINE_THRESHOLD;
    const chunk = Array.from({ length: lines }, (_, i) => `L${i}`).join('\n') + '\n';
    expect(pasteLineCount(chunk)).toBe(lines);
  });

  test('CRLF and lone CR are counted as line breaks', () => {
    const chunk = Array.from({ length: PASTE_LINE_THRESHOLD }, (_, i) => `L${i}`).join('\r\n');
    expect(pasteLineCount(chunk)).toBe(PASTE_LINE_THRESHOLD);
  });

  test('empty / whitespace-only input never collapses', () => {
    expect(pasteLineCount('')).toBeNull();
    expect(pasteLineCount('\n\n')).toBeNull();
  });
});

describe('pastePlaceholder — token format matches Claude Code', () => {
  test.each([
    [1, 23, '[Pasted text #1 +23 lines]'],
    [2, 6, '[Pasted text #2 +6 lines]'],
  ])('id=%i lines=%i → %s', (id, lines, expected) => {
    expect(pastePlaceholder(id, lines)).toBe(expected);
  });
});

describe('PasteRegistry — collapse then re-expand', () => {
  test('register returns a numbered token and expand restores the full text', () => {
    const reg = new PasteRegistry();
    const pasted = Array.from({ length: 8 }, (_, i) => `line-${i}`).join('\n');
    const token = reg.register(pasted, 8);
    expect(token).toBe('[Pasted text #1 +8 lines]');

    const buffer = `please review ${token} and fix it`;
    expect(reg.expand(buffer)).toBe(`please review ${pasted} and fix it`);
  });

  test('multiple pastes get distinct ids and all expand', () => {
    const reg = new PasteRegistry();
    const a = reg.register('AAA\nAAA\nAAA\nAAA\nAAA\nAAA', 6);
    const b = reg.register('BBB\nBBB\nBBB\nBBB\nBBB\nBBB', 6);
    expect(a).toBe('[Pasted text #1 +6 lines]');
    expect(b).toBe('[Pasted text #2 +6 lines]');
    const out = reg.expand(`${a} vs ${b}`);
    expect(out).toContain('AAA\nAAA');
    expect(out).toContain('BBB\nBBB');
    expect(out).not.toContain('[Pasted text');
  });

  test('an edited (no-longer-matching) token is left literal, never silently dropped', () => {
    const reg = new PasteRegistry();
    reg.register('x\nx\nx\nx\nx\nx', 6);
    const edited = '[Pasted text #1 +5 lines]'; // user changed 6 → 5
    expect(reg.expand(edited)).toBe(edited);
  });

  test('clear resets ids and forgets stored pastes', () => {
    const reg = new PasteRegistry();
    const first = reg.register('p\np\np\np\np\np', 6);
    expect(reg.size).toBe(1);
    reg.clear();
    expect(reg.size).toBe(0);
    // expand is now a no-op for the old token …
    expect(reg.expand(first)).toBe(first);
    // … and numbering restarts at #1.
    expect(reg.register('q\nq\nq\nq\nq\nq', 6)).toBe('[Pasted text #1 +6 lines]');
  });
});

describe('Prompt.tsx keeps the paste wiring (source guard)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'ui', 'ink', 'Prompt.tsx'),
    'utf8',
  );

  test('imports the real pasteBuffer module', () => {
    expect(src).toMatch(/from '\.\/pasteBuffer\.js'/);
  });

  test('collapses large pastes via pasteLineCount + registry.register', () => {
    expect(src).toMatch(/pasteLineCount\(/);
    expect(src).toMatch(/pasteRef\.current\.register\(/);
  });

  test('re-expands on submit', () => {
    expect(src).toMatch(/pasteRef\.current\.expand\(/);
  });
});
