/**
 * `#<note>` quick-capture (Claude Code parity). Appends a one-line note to the
 * project's persistent memory (.anvilwing/memory/notes.md) — no model round-trip.
 * Locks the append behaviour + that the shell routes `#`. Deterministic, runs on CI.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendMemoryNote } from '../src/tools/memoryTools';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ero-note-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const notes = () => readFileSync(join(dir, '.anvilwing', 'memory', 'notes.md'), 'utf8');

describe('appendMemoryNote', () => {
  test('creates notes.md and appends the note as a bullet', () => {
    expect(appendMemoryNote(dir, 'build uses tsc not webpack')).toBe(true);
    expect(notes()).toMatch(/- build uses tsc not webpack/);
  });

  test('appends successive notes without clobbering', () => {
    appendMemoryNote(dir, 'first');
    appendMemoryNote(dir, 'second');
    const body = notes();
    expect(body).toMatch(/- first/);
    expect(body).toMatch(/- second/);
    expect(body.match(/^- /gm)?.length).toBe(2);
  });

  test('updates the MEMORY.md index so the agent can find it', () => {
    appendMemoryNote(dir, 'a fact');
    expect(existsSync(join(dir, '.anvilwing', 'memory', 'MEMORY.md'))).toBe(true);
  });

  test.each(['', '   '])('blank note %j → false, no file written', (note) => {
    expect(appendMemoryNote(dir, note)).toBe(false);
    expect(existsSync(join(dir, '.anvilwing', 'memory', 'notes.md'))).toBe(false);
  });
});

describe('the shell routes #<note> to memory capture', () => {
  test('handleSubmit calls appendMemoryNote for a leading #', () => {
    const src = readFileSync(resolve(__dirname, '..', 'src/headless/interactiveShell.ts'), 'utf8');
    expect(src).toMatch(/startsWith\('#'\)/);
    expect(src).toMatch(/appendMemoryNote\(this\.workingDir/);
  });
});
