/**
 * Search/Grep content output was hard-capped at 5 matches.
 *
 *  - Search (searchContent) accepts a `limit` param (default 20, max 100) but
 *    then did `slice(0, Math.min(options.limit, 5))` — so the parameter was
 *    SILENTLY non-functional: every content search returned at most 5 matches,
 *    even when the caller asked for 50.
 *  - Grep content/files output was a fixed `slice(0, 5)`.
 *
 * For "find all usages of X" — a core coding move — the agent saw 5 of N and
 * had to keep re-searching. The 1M-token window holds hundreds of match lines
 * trivially, so the 5-cap was pure (vestigial) friction. Search now honours its
 * `limit`; Grep returns a useful number of matches.
 *
 * Drives the REAL Search + Grep tools against a REAL file with 30 matches.
 */

import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSearchTools } from '../../src/tools/searchTools.js';

let dir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let search: any; let grep: any;
const N = 30;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-srch-'));
  fs.writeFileSync(path.join(dir, 'many.txt'),
    Array.from({ length: N }, (_, i) => `line ${i} has NEEDLE here`).join('\n'));
  const tools = createSearchTools(dir);
  search = tools.find((t) => t.name === 'Search');
  grep = tools.find((t) => t.name === 'Grep');
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function countMatchLines(out: string): number {
  return out.split('\n').filter((l) => /many\.txt:/.test(l)).length;
}

describe('Search/Grep return more than 5 matches when asked', () => {
  test('Search content mode honours limit (was always capped at 5)', async () => {
    const out: string = await search.handler({ pattern: 'NEEDLE', mode: 'content', path: dir, limit: 25 });
    expect(countMatchLines(out)).toBe(25);
  });

  test('Search content mode default shows well over 5', async () => {
    const out: string = await search.handler({ pattern: 'NEEDLE', mode: 'content', path: dir });
    expect(countMatchLines(out)).toBeGreaterThan(5);
  });

  test('Grep content mode returns the matches, not just 5', async () => {
    const out: string = await grep.handler({ pattern: 'NEEDLE', path: dir, output_mode: 'content' });
    expect(countMatchLines(out)).toBe(N);
  });

  test('source guard: the 5-cap no longer overrides the requested limit', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'searchTools.ts'), 'utf8');
    expect(src).not.toMatch(/Math\.min\(options\.limit,\s*MAX_DISPLAY_LINES\)/);
  });
});
