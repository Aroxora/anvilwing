/**
 * Grep searched ALL files (minus IGNORED_DIRS) with no way to scope by file type
 * or glob — so "find needle in .ts files" returned matches from .js/.py too, and
 * the agent had to filter mentally or re-search. Claude Code's Grep has --type and
 * --glob. Added both to Grep, reusing Search's matchesFileType + the brace-aware
 * globToRegexes. Glob matching is ripgrep-style: a slash-less glob (*.ts) matches
 * the basename at any depth, a glob with a slash (src/**\/*.ts) matches the
 * relative path.
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

/** Run a content-mode grep and return the set of matched relative paths. */
async function matchedFiles(args: Record<string, unknown>): Promise<Set<string>> {
  const out: string = await grep.handler({ pattern: 'needle', ...args });
  if (/^No matches found/.test(out)) return new Set();
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    if (line === '--' || line.startsWith('...')) continue;
    const rel = line.split(':')[0];
    if (rel) files.add(rel);
  }
  return files;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-grep-filter-'));
  for (const f of ['app.ts', 'app.js', 'util.tsx', 'data.py', 'src/deep.ts', 'src/deep.js']) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'const x = "needle";\n');
  }
  grep = createGrepTools(dir).find((t) => t.name === 'Grep');
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('Grep --type / --glob file scoping (Claude Code parity #4)', () => {
  test('no filter searches every file (baseline)', async () => {
    expect(await matchedFiles({})).toEqual(new Set(['app.ts', 'app.js', 'util.tsx', 'data.py', 'src/deep.ts', 'src/deep.js']));
  });

  test('type:"ts" restricts to .ts/.tsx, excluding .js and .py', async () => {
    expect(await matchedFiles({ type: 'ts' })).toEqual(new Set(['app.ts', 'util.tsx', 'src/deep.ts']));
  });

  test('type:"py" restricts to .py only', async () => {
    expect(await matchedFiles({ type: 'py' })).toEqual(new Set(['data.py']));
  });

  test('glob:"*.ts" matches .ts at any depth by basename (not .tsx, not .js)', async () => {
    expect(await matchedFiles({ glob: '*.ts' })).toEqual(new Set(['app.ts', 'src/deep.ts']));
  });

  test('glob:"src/**/*.ts" matches by relative path (only under src/)', async () => {
    expect(await matchedFiles({ glob: 'src/**/*.ts' })).toEqual(new Set(['src/deep.ts']));
  });

  test('glob:"*.{ts,tsx}" brace-expands in the filter', async () => {
    expect(await matchedFiles({ glob: '*.{ts,tsx}' })).toEqual(new Set(['app.ts', 'util.tsx', 'src/deep.ts']));
  });

  test('type filter applies to count and files_with_matches too', async () => {
    expect(await grep.handler({ pattern: 'needle', output_mode: 'count', type: 'py' })).toBe('Matches: 1');
    expect(await grep.handler({ pattern: 'needle', output_mode: 'files_with_matches', glob: '*.py' })).toBe('data.py');
  });

  test('source guard: glob/type params declared and wired through matchesFileType + globToRegexes', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'grepTools.ts'), 'utf8');
    expect(src).toMatch(/glob:\s*\{ type: 'string'/);
    expect(src).toMatch(/type:\s*\{ type: 'string'/);
    expect(src).toMatch(/import \{ matchesFileGlob, matchesFileType \} from '\.\/searchTools\.js'/);
    expect(src).toMatch(/function fileAllowed/);
  });
});
