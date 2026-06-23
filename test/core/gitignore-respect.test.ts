/**
 * Grep / Glob / Search only skipped a hardcoded IGNORED_DIRS set, not the repo's
 * .gitignore — so a project that gitignores vendor/, generated files, or secrets
 * got noise (and gitignored secrets like *.env) in results, unlike Claude Code /
 * ripgrep which respect .gitignore by default. Added a shared gitignore filter
 * (the `ignore` lib) applied at every search walk.
 *
 * Drives the REAL Grep + Glob + Search tools against REAL files.
 */

import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createGrepTools } from '../../src/tools/grepTools.js';
import { createSearchTools } from '../../src/tools/searchTools.js';

let dir: string;        // repo with a .gitignore
let plain: string;      // identical tree, NO .gitignore (regression baseline)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let grep: any; let glob: any; let search: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let plainGrep: any;

const FILES = ['src/app.ts', 'vendor/lib.ts', 'api.generated.ts', 'secret.env', 'README.md'];

function build(root: string, withIgnore: boolean): void {
  if (withIgnore) fs.writeFileSync(path.join(root, '.gitignore'), 'vendor/\n*.generated.ts\nsecret.env\n');
  for (const f of FILES) {
    const p = path.join(root, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'const token = "needle";\n');
  }
}

function namesFrom(out: string): Set<string> {
  if (/^No (matches|files)/.test(out)) return new Set();
  const s = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim() || line === '--' || line.startsWith('...') || /file\(s\) matching/.test(line)) continue;
    s.add(path.basename(line.split(':')[0].trim()));
  }
  return s;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-gi-'));
  plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-gi-plain-'));
  build(dir, true);
  build(plain, false);
  grep = createGrepTools(dir).find((t) => t.name === 'Grep');
  glob = createSearchTools(dir).find((t) => t.name === 'Glob');
  search = createSearchTools(dir).find((t) => t.name === 'Search');
  plainGrep = createGrepTools(plain).find((t) => t.name === 'Grep');
});
afterAll(() => {
  for (const d of [dir, plain]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('Search tools respect .gitignore (Claude Code / ripgrep parity)', () => {
  test('Grep skips gitignored vendor/, *.generated.ts, and secret.env', async () => {
    const m = namesFrom(await grep.handler({ pattern: 'needle' }));
    expect(m.has('app.ts')).toBe(true);
    expect(m.has('README.md')).toBe(true);
    expect(m.has('lib.ts')).toBe(false);          // vendor/
    expect(m.has('api.generated.ts')).toBe(false); // *.generated.ts
    expect(m.has('secret.env')).toBe(false);       // gitignored secret — not surfaced
  });

  test('Glob **/*.ts excludes gitignored .ts files', async () => {
    const m = namesFrom(await glob.handler({ pattern: '**/*.ts' }));
    expect(m.has('app.ts')).toBe(true);
    expect(m.has('lib.ts')).toBe(false);           // vendor/lib.ts gitignored
    expect(m.has('api.generated.ts')).toBe(false);
  });

  test('Search content mode also respects .gitignore', async () => {
    const m = namesFrom(await search.handler({ mode: 'content', pattern: 'needle' }));
    expect(m.has('app.ts')).toBe(true);
    expect(m.has('lib.ts')).toBe(false);
    expect(m.has('secret.env')).toBe(false);
  });

  test('security: a gitignored secret value is NOT surfaced by Grep', async () => {
    fs.writeFileSync(path.join(dir, 'secret.env'), 'API_KEY=sk-supersecretvalue123456789\n');
    const out: string = await grep.handler({ pattern: 'supersecretvalue' });
    expect(out).toMatch(/No matches/);
  });

  test('regression: with NO .gitignore, everything is searched', async () => {
    const m = namesFrom(await plainGrep.handler({ pattern: 'needle' }));
    expect(m).toEqual(new Set(['app.ts', 'lib.ts', 'api.generated.ts', 'secret.env', 'README.md']));
  });

  test('source guard: a shared gitignore filter is wired into the search walks', () => {
    const gi = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'gitignore.ts'), 'utf8');
    expect(gi).toMatch(/import ignore from 'ignore'/);
    expect(gi).toMatch(/\.git\/info\/exclude/);
    for (const f of ['grepTools.ts', 'searchTools.ts']) {
      const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', f), 'utf8');
      expect(src).toMatch(/isPathIgnored\(ig, workingDir, fullPath, entry\.isDirectory\(\)\)/);
    }
  });
});
