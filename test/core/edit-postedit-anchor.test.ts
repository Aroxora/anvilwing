/**
 * F2: an Edit result used to show only a 5-line diff with no post-edit anchor —
 * no new total-line count and no "which lines changed" — so the cheapest next
 * move for the model was to re-read the whole file to re-establish line numbers,
 * feeding the over-edit loop F1 also targets. The success result now ends with
 * "File now N lines; changed line(s) X-Y".
 *
 * Drives the REAL exported performSurgicalEdit against REAL files on disk.
 */

import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performSurgicalEdit } from '../../src/tools/editTools.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-anchor-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

async function edit(before: string, oldStr: string, newStr: string, replaceAll = false): Promise<string> {
  const p = path.join(dir, 'f.ts');
  fs.writeFileSync(p, before, 'utf8');
  return performSurgicalEdit(dir, { file_path: p, old_string: oldStr, new_string: newStr, replace_all: replaceAll });
}

const file = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('Edit result carries a post-edit anchor (total lines + changed region)', () => {
  test('a mid-file single-line edit reports the new total and the changed line', async () => {
    const res = await edit(file(20), 'line 10', 'line TEN', false);
    expect(res).toMatch(/File now 20 lines/);
    expect(res).toMatch(/changed line 10\b/);
  });

  test('the total reflects lines ADDED by the edit (so the model knows the file grew)', async () => {
    const res = await edit(file(20), 'line 10', 'line 10\nline 10b\nline 10c', false);
    expect(res).toMatch(/File now 22 lines/); // 20 + 2 inserted
  });

  test('replace_all omits the misleading single span but still reports the total', async () => {
    // "line 1" matches multiple scattered lines (line 1, line 10..19) — a single
    // lo-hi span would be misleading, so only the total is emitted.
    const res = await edit(file(20), 'line 1', 'L1', true);
    expect(res).toMatch(/File now 20 lines/);
    expect(res).not.toMatch(/changed lines?/);
  });

  test('source: the anchor is appended to the success return, line count from newContent', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tools', 'editTools.ts'), 'utf8');
    expect(src).toMatch(/File now \$\{totalLines\}/);
    expect(src).toMatch(/newContent\.split\('\\n'\)\.length/);
  });
});
