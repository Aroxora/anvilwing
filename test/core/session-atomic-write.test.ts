/**
 * Durability: the session snapshot is the ONLY copy of a conversation and is
 * rewritten in place every turn. A plain writeFileSync truncates the file
 * before writing — a crash mid-write leaves a partial/empty JSON and /resume
 * loses the whole session. Writes now go tmp+rename (atomic within a
 * directory on POSIX), the same pattern writeIndex already used.
 *
 * Tests the REAL sessionStore against a sandboxed ANVILWING_DATA_DIR.
 */

import { describe, expect, test, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('sessionStore — snapshot writes are atomic (tmp+rename)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tw-atomic-'));
    process.env['ANVILWING_DATA_DIR'] = dir;
    jest.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['ANVILWING_DATA_DIR'];
    jest.resetModules();
  });

  test('save → load roundtrip works and leaves NO .tmp residue', async () => {
    const store = await import('../../src/core/sessionStore.js');
    const summary = store.saveSessionSnapshot({
      profile: 'anvilwing-code',
      provider: 'anvilwing',
      model: 'anvilwing',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello atomic world' },
        { role: 'assistant', content: 'saved' },
      ],
    });
    const loaded = store.loadSessionById(summary.id);
    expect(loaded?.messages).toHaveLength(3);
    expect(JSON.stringify(loaded)).toContain('hello atomic world');

    // Re-save (the every-turn in-place rewrite) and confirm still readable.
    store.saveSessionSnapshot({
      id: summary.id,
      profile: 'anvilwing-code',
      provider: 'anvilwing',
      model: 'anvilwing',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello atomic world' },
        { role: 'assistant', content: 'saved' },
        { role: 'user', content: 'turn two' },
      ],
    });
    expect(store.loadSessionById(summary.id)?.messages).toHaveLength(4);

    // No abandoned tmp files anywhere in the sessions dir.
    const leftovers = readdirSync(join(dir, 'sessions')).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  test('source: session + autosave writes go through atomicWriteFileSync (rename)', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'sessionStore.ts'), 'utf8');
    expect(src).toMatch(/atomicWriteFileSync\(getSessionPath\(summaryId\)/);
    expect(src).toMatch(/atomicWriteFileSync\(getAutosavePath\(profile\)/);
    expect(src).toMatch(/renameSync\(tmpPath, path\)/);
    // The snapshot path must NOT use a bare truncating writeFileSync anymore.
    expect(src).not.toMatch(/writeFileSync\(getSessionPath\(/);
    expect(src).not.toMatch(/writeFileSync\(getAutosavePath\(/);
  });
});

describe('window-drift self-report (source guard)', () => {
  test('the shell warns once when real prompt_tokens exceed the configured window', () => {
    const shell = readFileSync(resolve(__dirname, '..', '..', 'src', 'headless', 'interactiveShell.ts'), 'utf8');
    expect(shell).toMatch(/warnedWindowDrift/);
    expect(shell).toMatch(/contextTokens > windowTokens/);
    expect(shell).toMatch(/context table is likely stale/i);
  });
});
