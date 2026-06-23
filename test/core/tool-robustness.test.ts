/**
 * Regression net for core-tool robustness on edge inputs — behaviours verified
 * by hand against the shipped tools (2026-06-13) and pinned here so a future
 * change can't silently regress them. These are the catastrophic-if-broken
 * cases NOT already covered by the per-fix tests (dollar-replacement, glob-
 * overmatch, search-grep-limit, read-file-line-count): regex metacharacters in
 * Edit matched literally, MultiEdit atomicity, Grep surviving an invalid regex,
 * and create not clobbering an existing file.
 *
 * Drives the REAL tools against REAL files. Edit/MultiEdit require a prior Read
 * (the read-before-edit guard), satisfied via the real read_file tool.
 */

import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performSurgicalEdit, createEditTools } from '../../src/tools/editTools.js';
import { createFileTools } from '../../src/tools/fileTools.js';
import { createGrepTools } from '../../src/tools/grepTools.js';

let dir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let read: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-robust-'));
  read = createFileTools(dir).find((t) => t.name === 'read_file');
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

async function editFile(before: string, oldStr: string, newStr: string): Promise<string> {
  const f = path.join(dir, 'f.txt');
  fs.writeFileSync(f, before);
  await read.handler({ path: f });
  await performSurgicalEdit(dir, { file_path: f, old_string: oldStr, new_string: newStr });
  return fs.readFileSync(f, 'utf8');
}

describe('Edit matches old_string LITERALLY (regex metacharacters are not special)', () => {
  test.each([
    ['arr[0]', 'x = arr[0];', 'arr[0]', 'arr[1]', 'x = arr[1];'],
    ['foo(bar)', 'call foo(bar)', 'foo(bar)', 'baz(qux)', 'call baz(qux)'],
    ['a.b.c', 'use a.b.c', 'a.b.c', 'x.y.z', 'use x.y.z'],
    ['x*y', 'n = x*y', 'x*y', 'a*b', 'n = a*b'],
    ['anchors $5^2', 'cost $5^2 ok', '$5^2', '$10', 'cost $10 ok'],
  ])('%s is treated literally', async (_label, before, oldS, newS, want) => {
    expect(await editFile(before, oldS, newS)).toBe(want);
  });

  test('deletion (empty new_string) and unicode both work', async () => {
    expect(await editFile('keep CUT end', 'CUT ', '')).toBe('keep end');
    expect(await editFile('a ☕ b', '☕', '🍵')).toBe('a 🍵 b');
  });
});

describe('MultiEdit is atomic and sequential', () => {
  const multi = (d: string) => createEditTools(d).find((t) => t.name === 'MultiEdit')!;
  async function run(before: string, edits: unknown): Promise<string> {
    const f = path.join(dir, 'm.txt');
    fs.writeFileSync(f, before);
    await read.handler({ path: f });
    await multi(dir).handler({ file_path: f, edits });
    return fs.readFileSync(f, 'utf8');
  }
  test('edits apply in order, each seeing the previous result', async () => {
    expect(await run('aaa', [{ old_string: 'aaa', new_string: 'bbb' }, { old_string: 'bbb', new_string: 'ccc' }])).toBe('ccc');
  });
  test('a failing edit rolls the WHOLE batch back (file untouched)', async () => {
    expect(await run('one two', [{ old_string: 'one', new_string: '1' }, { old_string: 'NOPE', new_string: 'x' }])).toBe('one two');
  });
});

describe('Grep survives an invalid regex without crashing', () => {
  test.each(['arr[0', '(foo', '*bad'])('invalid pattern %s returns a clean error', async (pattern) => {
    const grep = createGrepTools(dir).find((t) => t.name === 'Grep')!;
    fs.writeFileSync(path.join(dir, 'c.js'), 'hello\n');
    const out = await grep.handler({ path: dir, pattern });
    expect(out).toMatch(/invalid regex/i);
  });
});

describe('create does not clobber an existing file', () => {
  test('Edit with empty old_string on an existing path errors and preserves content', async () => {
    const f = path.join(dir, 'exists.txt');
    fs.writeFileSync(f, 'ORIGINAL');
    const res = await performSurgicalEdit(dir, { file_path: f, old_string: '', new_string: 'NEW' });
    expect(res).toMatch(/already exists/i);
    expect(fs.readFileSync(f, 'utf8')).toBe('ORIGINAL');
  });
  test('create preserves content byte-for-byte (trailing newline, $, backticks)', async () => {
    const f = path.join(dir, 'new.txt');
    const content = 'a\nb\ncost=$5 `code`\n';
    await performSurgicalEdit(dir, { file_path: f, old_string: '', new_string: content });
    expect(fs.readFileSync(f, 'utf8')).toBe(content);
  });
});
