/**
 * Grep had no -A/-B/-C context lines — a Claude Code (ripgrep) parity gap. The
 * agent greps a symbol, gets bare matching lines, then must Read the file just to
 * see the surrounding code. Adding -A/-B/-C lets a single Grep show a match in
 * context (match lines use ':', context lines use '-', '--' between groups), the
 * way Claude Code's Grep does. Context activates only when requested, so the
 * default output is unchanged.
 *
 * Drives the REAL Grep tool (createGrepTools) against REAL files.
 */

import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createGrepTools } from '../../src/tools/grepTools.js';

let dir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let grep: any;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-grep-ctx-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'line one\nline two\nTARGET here\nline four\nline five\n');
  // two matches: one pair adjacent (merge), one far away (separate group)
  fs.writeFileSync(path.join(dir, 'b.txt'),
    'x0\nHIT alpha\nHIT beta\ny0\nz0\nz1\nz2\nz3\nHIT gamma\nz4\n');
  grep = createGrepTools(dir).find((t) => t.name === 'Grep');
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('Grep context lines (-A/-B/-C) — Claude Code parity #4', () => {
  test('-C 1 shows the line before AND after the match (was: bare match line only)', async () => {
    const out: string = await grep.handler({ pattern: 'TARGET', path: 'a.txt', '-C': 1 });
    expect(out).toContain('line two');   // before
    expect(out).toContain('TARGET here'); // match
    expect(out).toContain('line four');  // after
    expect(out).not.toContain('line one');  // outside the window
    expect(out).not.toContain('line five');
  });

  test('-A 1 shows only the line after; -B 1 only the line before', async () => {
    const after: string = await grep.handler({ pattern: 'TARGET', path: 'a.txt', '-A': 1 });
    expect(after).toContain('line four');
    expect(after).not.toContain('line two');

    const before: string = await grep.handler({ pattern: 'TARGET', path: 'a.txt', '-B': 1 });
    expect(before).toContain('line two');
    expect(before).not.toContain('line four');
  });

  test('match lines use ":" and context lines use "-" with line numbers', async () => {
    const out: string = await grep.handler({ pattern: 'TARGET', path: 'a.txt', '-C': 1, n: true });
    expect(out).toMatch(/a\.txt:3:TARGET here/); // match line: ':'
    expect(out).toMatch(/a\.txt-2-line two/);    // context line: '-'
    expect(out).toMatch(/a\.txt-4-line four/);
  });

  test('overlapping windows merge (no "--"); a distant match starts a new group ("--")', async () => {
    const out: string = await grep.handler({ pattern: 'HIT', path: 'b.txt', '-C': 1 });
    // adjacent HIT alpha / HIT beta merge into one contiguous block
    expect(out).toContain('HIT alpha');
    expect(out).toContain('HIT beta');
    // gamma is far away → a separator must appear between groups
    expect(out).toContain('HIT gamma');
    expect(out).toContain('--');
  });

  test('regression: no context flag → original one-line-per-match output, no "-" context, no "--"', async () => {
    const out: string = await grep.handler({ pattern: 'TARGET', path: 'a.txt', n: true });
    expect(out).toBe('a.txt:3:TARGET here');
  });

  test('regression: count and files_with_matches ignore context', async () => {
    expect(await grep.handler({ pattern: 'HIT', path: 'b.txt', output_mode: 'count', '-C': 5 })).toBe('Matches: 3');
    expect(await grep.handler({ pattern: 'TARGET', output_mode: 'files_with_matches', '-C': 5 })).toBe('a.txt');
  });

  test('source guard: -A/-B/-C are declared and context formatting is implemented', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'grepTools.ts'), 'utf8');
    expect(src).toMatch(/'-C':/);
    expect(src).toMatch(/'-A':/);
    expect(src).toMatch(/'-B':/);
    expect(src).toMatch(/matchSet\.has\(i\) \? ':' : '-'/); // ripgrep match/context separators
  });
});
