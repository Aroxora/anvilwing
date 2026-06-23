/**
 * Search's content-mode `glob` filter tested the ABSOLUTE file path against an
 * anchored glob regex, so glob:"*.ts" (→ ^[^/]*\.ts$) never matched a real path
 * like /tmp/x/src/app.ts — Search silently returned "No matches" for any
 * basename glob. Fixed by matching the path RELATIVE to the working dir, plus the
 * basename, via the shared matchesFileGlob (the same helper Grep uses).
 *
 * Drives the REAL Search tool (createSearchTools) against REAL files.
 */

import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSearchTools } from '../../src/tools/searchTools.js';

let dir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let search: any;

async function matchedFiles(args: Record<string, unknown>): Promise<Set<string>> {
  const out: string = await search.handler({ mode: 'content', pattern: 'needle', ...args });
  if (/^No matches/.test(out)) return new Set();
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim() || line.startsWith('...')) continue;
    const rel = line.split(':')[0];
    if (rel) files.add(rel);
  }
  return files;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-search-glob-'));
  for (const f of ['a.ts', 'a.js', 'util.tsx', 'data.py', 'src/deep.ts']) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'const x = "needle";\n');
  }
  search = createSearchTools(dir).find((t) => t.name === 'Search');
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('Search content-mode glob filter (was: matched nothing)', () => {
  test('glob:"*.ts" now matches .ts at any depth (was: empty result)', async () => {
    expect(await matchedFiles({ glob: '*.ts' })).toEqual(new Set(['a.ts', 'src/deep.ts']));
  });

  test('glob:"src/**/*.ts" matches by relative path', async () => {
    expect(await matchedFiles({ glob: 'src/**/*.ts' })).toEqual(new Set(['src/deep.ts']));
  });

  test('glob:"*.{ts,tsx}" brace-expands', async () => {
    expect(await matchedFiles({ glob: '*.{ts,tsx}' })).toEqual(new Set(['a.ts', 'util.tsx', 'src/deep.ts']));
  });

  test('type:"py" still filters by language', async () => {
    expect(await matchedFiles({ type: 'py' })).toEqual(new Set(['data.py']));
  });

  test('no filter still searches everything (baseline)', async () => {
    expect(await matchedFiles({})).toEqual(new Set(['a.ts', 'a.js', 'util.tsx', 'data.py', 'src/deep.ts']));
  });

  test('source guard: matchesFileGlob replaces the absolute-path matchesGlob', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'searchTools.ts'), 'utf8');
    expect(src).toMatch(/export function matchesFileGlob/);
    expect(src).toMatch(/matchesFileGlob\(relative\(workingDir, filePath\), options\.globPattern\)/);
    expect(src).not.toMatch(/function matchesGlob\b/); // the buggy absolute-path matcher is gone
  });
});
