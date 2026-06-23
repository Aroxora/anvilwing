/**
 * fileTools.ts embedded literal NUL bytes (\x00) in the `**` glob sentinel
 * (`'\0DOUBLESTAR\0'`). The glob worked, but NUL bytes in a TypeScript source
 * file make `file(1)` classify it as binary "data" and POSIX `grep` silently
 * skip it — a real inspectability papercut in a repo whose thesis is
 * transparency, and a hazard if an editor strips NUL on save. Swapped to the
 * printable `<!GLOBSTAR!>` sentinel already used by the two sibling globToRegex
 * copies (searchTools.ts, unifiedCodingCapability.ts).
 *
 * Behaviour-preserving: this pins both that the source is now NUL-free AND that
 * the real `search_files` glob still matches correctly (globstar spans depth,
 * `*` does not cross `/`, `*.ts` does not catch `.tsx`).
 */

import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileTools } from '../../src/tools/fileTools.js';

describe('fileTools glob sentinel is plain text (no NUL bytes)', () => {
  test('the source file contains no NUL byte', () => {
    const buf = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'fileTools.ts'));
    expect(buf.includes(0x00)).toBe(false);
  });

  test('the sentinel matches the printable convention used by the sibling copies', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'fileTools.ts'), 'utf8');
    expect(src).toMatch(/GLOBSTAR/); // a named printable sentinel
    expect(src).not.toMatch(/DOUBLESTAR/); // the old NUL-wrapped name is gone
  });
});

describe('search_files glob still correct after the sentinel swap', () => {
  let dir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tool: any;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-ft-glob-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), '');
    fs.writeFileSync(path.join(dir, 'a.tsx'), '');
    fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), '');
    fs.writeFileSync(path.join(dir, 'src', 'deep', 'c.ts'), '');
    tool = createFileTools(dir).find((t) => t.name === 'search_files');
  });
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  async function bases(pattern: string): Promise<string[]> {
    const out: string = await tool.handler({ pattern, path: dir, head_limit: 100 });
    return out.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => path.basename(l.replace(/^[-*•\s]+/, ''))).filter((b) => /\.tsx?$/.test(b)).sort();
  }

  test('*.ts finds .ts files (recursive walk, by basename), NOT .tsx — was "No files found"', async () => {
    const b = await bases('*.ts');
    expect(b).toEqual(expect.arrayContaining(['a.ts', 'b.ts', 'c.ts']));
    expect(b).not.toContain('a.tsx');
  });

  test('an exact filename matches itself — was "No files found"', async () => {
    const b = await bases('a.ts');
    expect(b).toContain('a.ts');
  });

  test('**/*.ts spans depth', async () => {
    const b = await bases('**/*.ts');
    expect(b).toEqual(expect.arrayContaining(['a.ts', 'b.ts', 'c.ts']));
    expect(b).not.toContain('a.tsx');
  });

  test('src/*.ts is a direct child only (* does not cross /)', async () => {
    const b = await bases('src/*.ts');
    expect(b).toContain('b.ts');
    expect(b).not.toContain('c.ts');
  });
});
