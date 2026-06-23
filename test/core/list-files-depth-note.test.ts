/**
 * list_files recursion caps at depth 5. When a tree is deeper it silently
 * returned [] for the deep part — the agent then assumes it saw the whole tree
 * and misses files. The repo's own "no silent caps" rule says: if the cap hid
 * something the reader never saw, SAY SO. Now a truncated non-empty directory
 * gets a "deeper entries not shown" note — but only when genuinely truncating
 * (not for a shallow tree, an intentional non-recursive listing, or an empty
 * deepest dir).
 *
 * Drives the REAL list_files tool against REAL directory trees.
 */

import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileTools } from '../../src/tools/fileTools.js';

let base: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let list: any;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-lf-'));
  list = createFileTools(base).find((t) => t.name === 'list_files');
});
afterEach(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } });

function nestedTree(root: string, depth: number): void {
  let p = root;
  for (let i = 1; i <= depth; i++) { p = path.join(p, `d${i}`); fs.mkdirSync(p); fs.writeFileSync(path.join(p, `f${i}.txt`), ''); }
}

describe('list_files flags depth-cap truncation (no silent caps)', () => {
  test('a tree deeper than the cap gets a "deeper entries not shown" note', async () => {
    const dir = path.join(base, 'deep'); fs.mkdirSync(dir);
    nestedTree(dir, 7);
    const out: string = await list.handler({ path: dir, recursive: true });
    expect(out).toMatch(/deeper entries not shown/i);
    expect(out).toMatch(/d1\//); // shallow part still listed
  });

  test('a shallow tree (within the cap) gets NO note', async () => {
    const dir = path.join(base, 'shallow'); fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, 'a')); fs.writeFileSync(path.join(dir, 'a', 'x.txt'), '');
    const out: string = await list.handler({ path: dir, recursive: true });
    expect(out).not.toMatch(/deeper entries not shown/i);
  });

  test('an intentional non-recursive listing gets NO note', async () => {
    const dir = path.join(base, 'nr'); fs.mkdirSync(dir);
    nestedTree(dir, 7);
    const out: string = await list.handler({ path: dir, recursive: false });
    expect(out).not.toMatch(/deeper entries not shown/i);
  });

  test('a tree exactly within the depth cap gets no note (all visible)', async () => {
    const dir = path.join(base, 'within'); fs.mkdirSync(dir);
    nestedTree(dir, 4); // deepest content well inside the cap — nothing omitted
    const out: string = await list.handler({ path: dir, recursive: true });
    expect(out).not.toMatch(/deeper entries not shown/i);
    expect(out).toMatch(/f4\.txt/); // the deepest file IS shown
  });

  test('source guard: the depth cap emits a note instead of a silent []', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'fileTools.ts'), 'utf8');
    expect(src).toMatch(/deeper entries not shown/);
    expect(src).toMatch(/currentDepth \+ 1 >= maxDepth/);
  });
});
