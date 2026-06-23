/**
 * The leanAgent/sub-agent file tools (glob, list_files, grep filePattern) all
 * route through UnifiedCodingCapability.listDirectory → its private globToRegex.
 * That copy diverged from the hardened one in searchTools.ts and OVER-MATCHED:
 *
 *   - `*` → `.*` (crosses `/`, no globstar distinction), and
 *   - the regex was UNANCHORED (substring match) and applied to the absolute path.
 *
 * So `*.ts` also matched `app.tsx`, `*.js` also matched `package.json`
 * (`.js` ⊂ `.json`), and `src/*.ts` matched `src/a/b/deep.ts`. A sub-agent then
 * globs/greps the WRONG files — wasted work, and a real risk of acting on a file
 * the pattern never meant to include.
 *
 * Drives the REAL `glob` tool from the REAL capability against REAL files.
 */

import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UnifiedCodingCapabilityModule } from '../../src/capabilities/unifiedCodingCapability.js';

let dir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let globTool: any;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-glob-'));
  fs.writeFileSync(path.join(dir, 'app.ts'), '');
  fs.writeFileSync(path.join(dir, 'app.tsx'), '');         // must NOT match *.ts
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');   // must NOT match *.js
  fs.writeFileSync(path.join(dir, 'index.js'), '');
  fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'deep.ts'), '');
  fs.writeFileSync(path.join(dir, 'src', 'nested', 'very.ts'), '');

  const mod = new UnifiedCodingCapabilityModule({ workingDir: dir });
  const contribution = await mod.create({ profile: 'default', workspaceContext: null, workingDir: dir, env: process.env } as any);
  const tools = (contribution.toolSuite?.tools ?? []) as any[];
  globTool = tools.find((t) => t.name === 'glob');
});

afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

async function globBasenames(pattern: string): Promise<string[]> {
  const out: string = await globTool.handler({ pattern });
  if (/No files found/.test(out)) return [];
  return out.split('\n').filter(Boolean).map((p) => path.basename(p)).sort();
}

describe('glob does not over-match (anchored, separator-aware)', () => {
  test('the glob tool exists in the capability', () => {
    expect(globTool).toBeTruthy();
  });

  test('*.ts matches .ts files at any depth but NOT .tsx', async () => {
    const names = await globBasenames('*.ts');
    expect(names).toEqual(expect.arrayContaining(['app.ts', 'deep.ts', 'very.ts']));
    expect(names).not.toContain('app.tsx'); // the substring over-match bug
  });

  test('*.js matches .js files but NOT package.json (.js ⊄ .json)', async () => {
    const names = await globBasenames('*.js');
    expect(names).toContain('index.js');
    expect(names).not.toContain('package.json');
  });

  test('src/*.ts matches a direct child, NOT a nested grandchild', async () => {
    const names = await globBasenames('src/*.ts');
    expect(names).toContain('deep.ts');
    expect(names).not.toContain('very.ts'); // * must not cross '/'
  });

  test('**/*.ts spans depth (globstar still works)', async () => {
    const names = await globBasenames('**/*.ts');
    expect(names).toEqual(expect.arrayContaining(['app.ts', 'deep.ts', 'very.ts']));
    expect(names).not.toContain('app.tsx');
  });

  test('source guard: the capability globToRegex anchors and uses [^/]* (not .*) for *', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'capabilities', 'unifiedCodingCapability.ts'), 'utf8');
    const fn = src.slice(src.indexOf('private globToRegex'), src.indexOf('private globToRegex') + 400);
    expect(fn).toMatch(/\[\^\/\]\*/);     // * → [^/]*
    expect(fn).toMatch(/\^\$\{escaped\}\$|\^\$\{|`\^/); // anchored
    expect(fn).not.toMatch(/\.replace\(\/\\\*\/g, '\.\*'\)/); // the old * → .* line is gone
  });
});
