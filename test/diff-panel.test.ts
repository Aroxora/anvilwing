/**
 * /diff review panel.
 *
 * renderChangePanel is pure → tested directly (real diffUtils, useColors:false
 * for plain assertions). The full data path is then exercised end-to-end with
 * the REAL fileChangeTracker against REAL files on disk (the tracker + diffUtils
 * are import.meta-free, so they run in-process under Jest): record a file's
 * original content, modify it, and assert the rendered panel shows the diff.
 *
 * Source assertions lock the shell wiring (/diff handler, getChangedFiles,
 * renderChangePanel) so a refactor that drops them fails at CI.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { renderChangePanel, type ChangeItem } from '../src/core/diffPanel.js';
import {
  startNewRun,
  recordFileChange,
  getChangedFiles,
  clearChangeTracking,
} from '../src/tools/fileChangeTracker.js';

const SHELL = readFileSync(resolve(__dirname, '..', 'src', 'headless', 'interactiveShell.ts'), 'utf8');

const plain = { useColors: false } as const;

describe('renderChangePanel — pure rendering', () => {
  it('shows a modified file with +/- counts and the diff body', () => {
    const item: ChangeItem = {
      relPath: 'src/util.ts',
      previous: 'export const a = 1;\n',
      current: 'export const a = 2;\n',
      existedBefore: true,
      deleted: false,
    };
    const out = renderChangePanel([item], plain);
    const text = out.lines.join('\n');
    expect(text).toContain('src/util.ts');
    expect(text).toContain('export const a = 2;'); // added line
    expect(out.totalAdditions).toBeGreaterThan(0);
    expect(out.totalRemovals).toBeGreaterThan(0);
    expect(text).toMatch(/1 file changed/);
  });

  it('tags a newly created file and counts only additions', () => {
    const item: ChangeItem = {
      relPath: 'new.ts', previous: '', current: 'line1\nline2\n', existedBefore: false, deleted: false,
    };
    const out = renderChangePanel([item], plain);
    expect(out.lines.join('\n')).toContain('new.ts');
    expect(out.lines.join('\n')).toContain('(new)');
    expect(out.totalRemovals).toBe(0);
    expect(out.totalAdditions).toBeGreaterThan(0);
  });

  it('tags a deleted file', () => {
    const item: ChangeItem = {
      relPath: 'gone.ts', previous: 'a\nb\n', current: '', existedBefore: true, deleted: true,
    };
    const out = renderChangePanel([item], plain);
    expect(out.lines.join('\n')).toContain('(deleted)');
    expect(out.totalRemovals).toBeGreaterThan(0);
  });

  it('caps files and per-file lines, noting the overflow', () => {
    const items: ChangeItem[] = Array.from({ length: 9 }, (_, i) => ({
      relPath: `f${i}.ts`,
      previous: '',
      current: Array.from({ length: 40 }, (_, n) => `line ${n}`).join('\n'),
      existedBefore: false,
      deleted: false,
    }));
    const out = renderChangePanel(items, { maxFiles: 6, maxLinesPerFile: 10, useColors: false });
    const text = out.lines.join('\n');
    expect(text).toMatch(/… \+3 more files/);
    expect(text).toMatch(/more lines/);
    expect(text).toMatch(/9 files changed/);
  });

  it('empty input → just a zeroed summary, never throws', () => {
    const out = renderChangePanel([], plain);
    expect(out.totalAdditions).toBe(0);
    expect(out.lines.join('\n')).toMatch(/0 files changed/);
  });
});

describe('/diff data path — REAL fileChangeTracker against real files on disk', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anvilwing-diff-')); clearChangeTracking(); });
  afterEach(() => { clearChangeTracking(); rmSync(dir, { recursive: true, force: true }); });

  it('records an edit and renders its diff (same flow /diff uses)', () => {
    const file = join(dir, 'app.ts');
    writeFileSync(file, 'const port = 3000;\nstart();\n', 'utf-8');

    startNewRun();
    recordFileChange(file); // captures original content (what /revert/diff restore against)
    writeFileSync(file, 'const port = 8080;\nstart();\n', 'utf-8'); // the "agent" edits it

    const changed = getChangedFiles();
    expect(changed.size).toBe(1);

    const items: ChangeItem[] = [...changed].map(([abs, rec]) => ({
      relPath: relative(dir, abs) || abs,
      previous: rec.originalContent ?? '',
      current: readFileSync(abs, 'utf-8'),
      existedBefore: rec.existedBefore,
      deleted: false,
    }));
    const out = renderChangePanel(items, plain);
    const text = out.lines.join('\n');
    expect(text).toContain('app.ts');
    expect(text).toContain('const port = 8080;'); // new value added
    expect(text).toContain('const port = 3000;'); // old value removed
    expect(out.totalAdditions).toBeGreaterThan(0);
    expect(out.totalRemovals).toBeGreaterThan(0);
  });
});

describe('/diff — source wiring locked', () => {
  it('shell registers /diff and renders changes via the tracker + panel', () => {
    expect(SHELL).toMatch(/lower === '\/diff'/);
    expect(SHELL).toMatch(/private showDiff\(\)/);
    expect(SHELL).toMatch(/getChangedFiles\(\)/);
    expect(SHELL).toMatch(/renderChangePanel\(items\)/);
  });
});
