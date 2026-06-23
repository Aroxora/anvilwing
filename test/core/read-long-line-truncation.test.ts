/**
 * read_file capped the number of LINES (2000) but never the LENGTH of a line, so
 * a minified bundle or a one-line JSON/base64 blob dumped a single multi-hundred-KB
 * line straight into the context window. Claude Code truncates lines over ~2000
 * chars on Read. Added display-only truncation; the full content is still recorded
 * for edit-validation.
 *
 * Drives the REAL read_file tool against REAL files.
 */

import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileTools } from '../../src/tools/fileTools.js';

let dir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let read: any;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-longline-'));
  read = createFileTools(dir).find((t) => t.name === 'read_file');
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('read_file truncates very long lines (Claude Code parity)', () => {
  test('a 50,000-char line is truncated to ~2000 chars + a marker, not dumped whole', async () => {
    fs.writeFileSync(path.join(dir, 'min.js'), `const a=1;\n${'X'.repeat(50000)}\nconst b=2;\n`);
    const out: string = await read.handler({ path: 'min.js' });
    expect(out).toMatch(/line truncated: 50000 chars total/);
    expect(out).not.toContain('X'.repeat(2500)); // the giant run is gone
    expect(out).toContain('X'.repeat(2000));     // but the first 2000 chars are shown
    // surrounding short lines survive intact, and it's still counted as 3 lines
    expect(out).toContain('const a=1;');
    expect(out).toContain('const b=2;');
    expect(out).toMatch(/\(3 lines\)/);
    // the whole read is bounded — not 50KB of junk
    expect(out.length).toBeLessThan(6000);
  });

  test('a line at the 2000-char boundary is NOT truncated', async () => {
    fs.writeFileSync(path.join(dir, 'edge.txt'), `${'a'.repeat(2000)}\n`);
    const out: string = await read.handler({ path: 'edge.txt' });
    expect(out).not.toMatch(/line truncated/);
    expect(out).toContain('a'.repeat(2000));
  });

  test('normal files are unaffected', async () => {
    fs.writeFileSync(path.join(dir, 'normal.ts'), 'export const x = 1;\nexport const y = 2;\n');
    const out: string = await read.handler({ path: 'normal.ts' });
    expect(out).not.toMatch(/line truncated/);
    expect(out).toContain('     1\texport const x = 1;');
    expect(out).toContain('     2\texport const y = 2;');
  });

  test('source guard: per-line truncation is implemented', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'fileTools.ts'), 'utf8');
    expect(src).toMatch(/MAX_LINE_CHARS = 2000/);
    expect(src).toMatch(/line truncated: \$\{line\.length\} chars total/);
  });
});
