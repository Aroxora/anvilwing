/**
 * /rewind — restore files changed this run.
 *
 * Pure preview/result text is tested directly. The actual revert is exercised
 * with the REAL fileChangeTracker against REAL files on disk (import.meta-free,
 * runs in-process): an edited file is restored to its original bytes, and a
 * file created this run is deleted — the exact behavior `/rewind confirm`
 * triggers. Source assertions lock the shell wiring.
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rewindPreviewLines, rewindResultLine, type RewindItem } from '../src/core/rewind.js';
import {
  startNewRun,
  recordFileChange,
  revertAllChanges,
  hasChangesToRevert,
  getChangedFiles,
  clearChangeTracking,
} from '../src/tools/fileChangeTracker.js';

const SHELL = readFileSync(resolve(__dirname, '..', 'src', 'headless', 'interactiveShell.ts'), 'utf8');

describe('rewind preview/result text (pure, emoji-free)', () => {
  it('previews restores and deletions, then the confirm hint', () => {
    const items: RewindItem[] = [
      { relPath: 'src/a.ts', existedBefore: true },
      { relPath: 'src/new.ts', existedBefore: false },
    ];
    const lines = rewindPreviewLines(items);
    const text = lines.join('\n');
    expect(text).toContain('Rewind restores 2 files');
    expect(text).toContain('src/a.ts (restore)');
    expect(text).toContain('src/new.ts (delete — created this run)');
    expect(lines[lines.length - 1]).toBe('Run /rewind confirm to restore them.');
    // §9: no chrome emoji in the copy
    expect(text).not.toMatch(/[📋⏪🔄]/);
  });

  it('result line pluralizes restored/deleted counts', () => {
    expect(rewindResultLine(2, 0)).toBe('Rewound: 2 files restored.');
    expect(rewindResultLine(1, 1)).toBe('Rewound: 1 file restored, 1 file deleted.');
    expect(rewindResultLine(0, 0)).toBe('Nothing to rewind.');
  });
});

describe('/rewind confirm — REAL fileChangeTracker reverts real files on disk', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anvilwing-rewind-')); clearChangeTracking(); });
  afterEach(() => { clearChangeTracking(); rmSync(dir, { recursive: true, force: true }); });

  it('restores an edited file to its original content and deletes a created file', () => {
    const edited = join(dir, 'app.ts');
    const created = join(dir, 'fresh.ts');
    writeFileSync(edited, 'const port = 3000;\n', 'utf-8');

    startNewRun();
    recordFileChange(edited);   // existed → original captured
    recordFileChange(created);  // does not exist yet → existedBefore:false
    writeFileSync(edited, 'const port = 8080;\n', 'utf-8'); // "agent" edits
    writeFileSync(created, 'export const x = 1;\n', 'utf-8'); // "agent" creates

    expect(hasChangesToRevert()).toBe(true);
    expect(getChangedFiles().size).toBe(2);

    revertAllChanges(dir);

    expect(readFileSync(edited, 'utf-8')).toBe('const port = 3000;\n'); // restored
    expect(existsSync(created)).toBe(false);                            // created file removed
    expect(hasChangesToRevert()).toBe(false);                          // tracking cleared
  });
});

describe('/rewind — source wiring locked', () => {
  it('shell registers /rewind, gates on confirm, and reverts via the tracker', () => {
    expect(SHELL).toMatch(/lower === '\/rewind'/);
    expect(SHELL).toMatch(/private handleRewind\(/);
    expect(SHELL).toMatch(/!== 'confirm'/);
    expect(SHELL).toMatch(/revertAllChanges\(this\.workingDir\)/);
    expect(SHELL).toMatch(/rewindPreviewLines\(/);
  });
});
