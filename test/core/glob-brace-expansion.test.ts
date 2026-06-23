/**
 * The Glob tool's description and examples advertise brace expansion
 * ("src/**\/*.test.{js,ts}"), but globToRegex ESCAPED `{` and `}` — so every
 * brace pattern was compiled to an anchored regex matching a literal `{js,ts}`
 * in the filename and silently returned NOTHING. That is a Claude-Code-parity
 * gap that fails quietly: the agent globs `*.{js,ts}`, gets "No files", and
 * reasons from an empty set. Fixed by expanding braces via the `braces` library
 * (CLAUDE.md bans hand-rolling glob logic) and matching a path if ANY expansion
 * matches.
 *
 * Drives the REAL Glob tool (createSearchTools) against REAL files on disk.
 */

import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSearchTools } from '../../src/tools/searchTools.js';

let dir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let glob: any;

function touch(rel: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '// ' + rel + '\n');
}

/** Run the Glob tool and return the set of matched basenames. */
async function matchedNames(pattern: string): Promise<Set<string>> {
  const out: string = await glob.handler({ pattern });
  if (/^No files matching/.test(out)) return new Set();
  // Output: `N file(s) matching "pat":\n<rel paths>` — collect the basenames.
  const names = out
    .split('\n')
    .slice(1)
    .filter((l) => l && !l.startsWith('...'))
    .map((l) => path.basename(l.trim()));
  return new Set(names);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-glob-brace-'));
  for (const f of [
    'app.js', 'util.ts', 'comp.tsx', 'script.py',
    '1.txt', '2.txt', '3.txt', '4.txt',
    'src/index.js', 'src/index.ts',
    'test/spec.js', 'test/spec.ts',
    'nested/deep/mod.js', 'nested/deep/mod.ts',
  ]) touch(f);
  glob = createSearchTools(dir).find((t) => t.name === 'Glob');
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('Glob brace expansion (Claude Code parity #14)', () => {
  test('the headline case: *.{js,ts} matches js AND ts, not tsx/py (was: nothing)', async () => {
    const m = await matchedNames('*.{js,ts}');
    expect(m.has('app.js')).toBe(true);
    expect(m.has('util.ts')).toBe(true);
    expect(m.has('comp.tsx')).toBe(false); // {js,ts} must NOT also match tsx
    expect(m.has('script.py')).toBe(false);
    expect(m.size).toBe(2);
  });

  test('three-way alternation *.{js,jsx,tsx} selects exactly those extensions', async () => {
    const m = await matchedNames('*.{js,jsx,tsx}');
    expect(m).toEqual(new Set(['app.js', 'comp.tsx']));
  });

  test('globstar + braces: **/*.{js,ts} reaches every depth', async () => {
    const m = await matchedNames('**/*.{js,ts}');
    for (const n of ['app.js', 'util.ts', 'index.js', 'index.ts', 'spec.js', 'spec.ts', 'mod.js', 'mod.ts']) {
      expect(m.has(n)).toBe(true);
    }
    expect(m.has('comp.tsx')).toBe(false);
    expect(m.has('script.py')).toBe(false);
  });

  test('cartesian leading group {src,test}/*.ts hits both dirs, not nested', async () => {
    const m = await matchedNames('{src,test}/*.ts');
    expect(m).toEqual(new Set(['index.ts', 'spec.ts'])); // src/index.ts + test/spec.ts
  });

  test('numeric range {1..3}.txt expands to 1,2,3 — excludes 4', async () => {
    const m = await matchedNames('{1..3}.txt');
    expect(m).toEqual(new Set(['1.txt', '2.txt', '3.txt']));
  });

  // Regression: non-brace patterns must be byte-for-byte unchanged.
  test.each([
    ['*.ts', new Set(['util.ts'])],                 // top-level only (anchored)
    ['*.py', new Set(['script.py'])],
    ['**/*.tsx', new Set(['comp.tsx'])],
    ['src/*.js', new Set(['index.js'])],
    ['*.{md}', new Set<string>()],                  // single alt, no comma → literal {md}, matches nothing
    ['*.rs', new Set<string>()],                    // no matches stays "No files"
  ])('non-brace / degenerate pattern %s is unchanged', async (pattern, expected) => {
    expect(await matchedNames(pattern as string)).toEqual(expected);
  });

  test('source guard: braces is imported and used with expand, feeding globToRegex', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'searchTools.ts'), 'utf8');
    expect(src).toMatch(/import braces from 'braces'/);
    expect(src).toMatch(/braces\(pattern, \{ expand: true \}\)/);
    expect(src).toMatch(/function globToRegexes/);
    // searchFiles + matchesGlob must route through the brace-aware matcher,
    // not the raw single-regex globToRegex.
    expect(src).toMatch(/const regexes = globToRegexes\(pattern\)/);
    expect(src).toMatch(/globToRegexes\(pattern\)\.some/);
  });
});
