/**
 * Edit must insert new_string LITERALLY — the classic String.replace($) footgun.
 *
 * performSurgicalEdit (used by both Edit and MultiEdit) replaced via
 *   currentContent.replace(targetString, replacementString)
 * which interprets $&, $`, $' and $$ inside the REPLACEMENT string. So an edit
 * whose new_string legitimately contains those — a regex replacement like
 * str.replace(/x/g, '$&!'), a shell PID $$, a sed/perl backref — was silently
 * corrupted: $& became the matched old text, $$ became a single $, etc. The
 * file ends up wrong with no error, the worst kind of edit failure.
 *
 * (replace_all already used split/join, which is literal — so this only bit the
 * common single-occurrence path.)
 *
 * Drives the REAL exported performSurgicalEdit against REAL files on disk.
 */

import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performSurgicalEdit } from '../../src/tools/editTools.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-edit-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

async function edit(file: string, before: string, oldStr: string, newStr: string, replaceAll = false): Promise<string> {
  const p = path.join(dir, file);
  fs.writeFileSync(p, before, 'utf8');
  const res = await performSurgicalEdit(dir, { file_path: p, old_string: oldStr, new_string: newStr, replace_all: replaceAll });
  return fs.readFileSync(p, 'utf8');
}

describe('Edit inserts new_string literally (no $-pattern interpretation)', () => {
  test('$& in new_string stays literal (was replaced with the matched text)', async () => {
    const after = await edit('a.js', 'const x = 1;', '1', 'g$&h');
    expect(after).toBe('const x = g$&h;');
  });

  test('$$ stays a literal double-dollar (was collapsed to one $)', async () => {
    const after = await edit('b.sh', 'echo PID', 'PID', '$$');
    expect(after).toBe('echo $$');
  });

  test("$` and $' stay literal (were the pre/post-match slices)", async () => {
    const after = await edit('c.txt', 'X-MID-Y', 'MID', "p$`q$'r");
    expect(after).toBe("X-p$`q$'r-Y");
  });

  test('a realistic regex-replacement edit survives intact', async () => {
    const before = 'out = src.replace(/\\d+/g, "N");';
    const after = await edit('d.ts', before, '"N"', '"$&!"');
    expect(after).toBe('out = src.replace(/\\d+/g, "$&!");');
  });

  test('replace_all path is also literal (regression — was already safe)', async () => {
    const after = await edit('e.txt', 'a a a', 'a', '$&', true);
    expect(after).toBe('$& $& $&');
  });

  test('source guard: single-edit replacement is literal, not $-interpreting', async () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'editTools.ts'), 'utf8');
    // the literal-function form (or an explicit $-escape) must be present
    expect(src).toMatch(/replace\(targetString,\s*\(\)\s*=>|replaceAll\(targetString|\$\$\$\$|\\\$&/);
    expect(src).not.toMatch(/:\s*currentContent\.replace\(targetString,\s*replacementString\)/);
  });
});
