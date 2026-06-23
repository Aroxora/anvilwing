/**
 * The `DONE:` completion sentinel is a MACHINE marker (taskCompletionDetector
 * contract) and must never appear raw in the transcript — it should render as a
 * clean ✓ summary. splitDoneSentinel (src/ui/ink/ChatStatic.tsx) used to strip
 * it only when DONE: was the EXACT last line. But models routinely add a
 * sign-off AFTER the marker, so the raw "DONE:" leaked into the UI.
 *
 * The renderer (.tsx/React/Ink) can't be imported into jest, so per repo
 * convention this mirrors the fixed helper inline AND source-asserts the real
 * function scans all lines. The end-to-end leak is separately verified by
 * re-running the real binary (pasted in the commit).
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Mirror of the FIXED splitDoneSentinel.
function splitDoneSentinel(body: string): { main: string; done: string | null } {
  const lines = body.replace(/\s+$/, '').split('\n');
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^DONE:\s*.+$/.test(lines[i]!.trim())) { idx = i; break; }
  }
  if (idx === -1) return { main: body, done: null };
  const done = lines[idx]!.trim().replace(/^DONE:\s*/, '').trim();
  const main = lines.filter((_, i) => i !== idx).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
  return { main, done };
}

describe('splitDoneSentinel strips DONE: wherever it sits', () => {
  test('DONE: followed by a sign-off sentence is still stripped (the leak)', () => {
    const r = splitDoneSentinel('Reverted it.\n\nDONE: `add` returns `a - b`; verified.\n\nLet me know if you need anything else.');
    expect(r.done).toBe('`add` returns `a - b`; verified.');
    expect(r.main).not.toMatch(/DONE:/);
    expect(r.main).toContain('Reverted it.');
    expect(r.main).toContain('Let me know');
  });

  test('DONE: as the exact last line still works (regression)', () => {
    const r = splitDoneSentinel('Fixed the bug.\n\nDONE: tests pass.');
    expect(r.done).toBe('tests pass.');
    expect(r.main).toBe('Fixed the bug.');
  });

  test('DONE: only (no main body)', () => {
    const r = splitDoneSentinel('DONE: all set.');
    expect(r.done).toBe('all set.');
    expect(r.main).toBe('');
  });

  test('no DONE: line passes through untouched', () => {
    const body = 'Just some normal output\nwith two lines.';
    const r = splitDoneSentinel(body);
    expect(r.done).toBeNull();
    expect(r.main).toBe(body);
  });

  test('the LAST DONE: wins when several appear', () => {
    const r = splitDoneSentinel('DONE: first\nmiddle\nDONE: final');
    expect(r.done).toBe('final');
    expect(r.main).not.toMatch(/DONE: final/);
  });

  test('source guard: the real splitDoneSentinel scans all lines, not just the last', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'ui', 'ink', 'ChatStatic.tsx'), 'utf8');
    const fn = src.slice(src.indexOf('function splitDoneSentinel'), src.indexOf('function splitDoneSentinel') + 700);
    expect(fn).toMatch(/for \(let i = lines\.length - 1/); // backward line scan
    expect(fn).not.toMatch(/lastIndexOf\('\\n'\)/);          // old last-line-only logic gone
  });
});
