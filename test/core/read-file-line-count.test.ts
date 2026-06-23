/**
 * read_file must not invent a phantom trailing line. content.split('\n') yields
 * a trailing '' for any file ending in a newline (i.e. almost every text file) —
 * that '' is the line TERMINATOR, not a line. So `line1\nline2\n` reported
 * "3 lines" and printed an empty line 3, and an empty file reported "1 lines".
 * The agent reasons about line counts and copies text for edits, so a phantom
 * last line and off-by-one count are real correctness/parity gaps vs Claude Code.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-rfc-'));
  read = createFileTools(dir).find((t) => t.name === 'read_file');
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

async function readContent(content: string): Promise<{ count: number; rows: number; out: string }> {
  fs.writeFileSync(path.join(dir, 'f.txt'), content);
  const out: string = await read.handler({ path: 'f.txt' });
  const m = out.match(/\((\d+) lines?\)/);
  const rows = (out.match(/^\s*\d+\t/gm) || []).length;
  return { count: m ? Number(m[1]) : -1, rows, out };
}

describe('read_file line count excludes the trailing-newline terminator', () => {
  test('a file ending in a newline does NOT report a phantom extra line', async () => {
    const r = await readContent('line1\nline2\n');
    expect(r.count).toBe(2);
    expect(r.rows).toBe(2); // no empty numbered line 3
    expect(r.out).not.toMatch(/\n\s*3\t\s*$/);
  });

  test('a file with NO trailing newline counts the same', async () => {
    expect((await readContent('line1\nline2')).count).toBe(2);
  });

  test('a GENUINE blank last line (ends in \\n\\n) is preserved', async () => {
    const r = await readContent('line1\nline2\n\n');
    expect(r.count).toBe(3);
    expect(r.rows).toBe(3);
  });

  test('an empty file is 0 lines, not a spurious 1', async () => {
    const r = await readContent('');
    expect(r.count).toBe(0);
    expect(r.rows).toBe(0);
  });

  test('a file of a single newline is 1 (empty) line', async () => {
    expect((await readContent('\n')).count).toBe(1);
  });

  test('the numbering matches the count (no off-by-one tail) for a typical file', async () => {
    const r = await readContent('a\nb\nc\nd\n');
    expect(r.count).toBe(4);
    expect(r.rows).toBe(4);
    expect(r.out).toContain('     4\td');
    expect(r.out).not.toMatch(/\n\s*5\t/);
  });

  test('offset past the end gives a clear message, not a nonsensical "15-10" range', async () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n');
    const out: string = await read.handler({ path: 'f.txt', offset: 15 });
    expect(out).toMatch(/past the end of the file/i);
    expect(out).toMatch(/10 lines/);
    expect(out).not.toMatch(/15-10/); // the old nonsensical inverted range
  });

  test('a valid windowed read is unaffected by the offset-bounds guard', async () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n');
    const out: string = await read.handler({ path: 'f.txt', offset: 3, limit: 2 });
    expect(out).toMatch(/lines 3-4 of 10/);
    expect(out).toContain('3\tline3');
    expect(out).toContain('4\tline4');
    expect(out).not.toMatch(/past the end/i);
  });

  test('source guard: the terminator newline is dropped before splitting', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'fileTools.ts'), 'utf8');
    expect(src).toMatch(/content\.endsWith\('\\n'\) \? content\.slice\(0, -1\)/);
  });
});
