import { describe, expect, test, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Regression: a corrupt/truncated index.json used to read as "no sessions
 * exist" ({ entries: {} }), and pruneOrphans() — which runs at module load —
 * then rmSync'd every <id>.json not in that empty set, wiping the user's entire
 * saved-session history. The fix distinguishes "index missing" (fresh install)
 * from "index unreadable" (corrupt) and prunes nothing in the corrupt case.
 *
 * Tests the REAL sessionStore module against a sandboxed ANVILWING_DATA_DIR
 * (set before a fresh import so the module-load pruneOrphans runs against it).
 */
describe('sessionStore — corrupt index never deletes sessions (data-loss guard)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tw-sess-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['ANVILWING_DATA_DIR'];
    jest.resetModules();
  });

  async function loadStore(setup: (sessionsDir: string) => void): Promise<string> {
    process.env['ANVILWING_DATA_DIR'] = dir;
    const sessionsDir = join(dir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    setup(sessionsDir);
    jest.resetModules();
    // Fresh import re-runs the module-load pruneOrphans() against the sandbox.
    await import('../../src/core/sessionStore.js');
    return sessionsDir;
  }

  test('corrupt index.json: real session files SURVIVE module load', async () => {
    const id = 'keep-me-1234';
    const sessionsDir = await loadStore((sd) => {
      writeFileSync(join(sd, `${id}.json`), JSON.stringify({ id, messages: [] }), 'utf8');
      // Truncated mid-write — valid prefix, invalid JSON.
      writeFileSync(join(sd, 'index.json'), '{ "entries": { "keep-me-1234": {', 'utf8');
    });
    expect(existsSync(join(sessionsDir, `${id}.json`))).toBe(true);
  });

  test('valid index still prunes a genuine orphan (no over-correction)', async () => {
    const known = 'known-1';
    const orphan = 'orphan-1';
    const sessionsDir = await loadStore((sd) => {
      writeFileSync(join(sd, `${known}.json`), JSON.stringify({ id: known }), 'utf8');
      writeFileSync(join(sd, `${orphan}.json`), JSON.stringify({ id: orphan }), 'utf8');
      writeFileSync(
        join(sd, 'index.json'),
        JSON.stringify({ entries: { [known]: { id: known } } }),
        'utf8',
      );
    });
    expect(existsSync(join(sessionsDir, `${known}.json`))).toBe(true);
    expect(existsSync(join(sessionsDir, `${orphan}.json`))).toBe(false);
  });

  test('fresh install (no index.json) is harmless', async () => {
    const sessionsDir = await loadStore(() => {
      /* no index, no sessions */
    });
    expect(existsSync(sessionsDir)).toBe(true);
  });

  test('source: pruneOrphans guards on parse state and writeIndex is atomic', () => {
    const src = readFileSync(resolve(__dirname, '../../src/core/sessionStore.ts'), 'utf8');
    expect(src).toMatch(/readIndexState/);
    expect(src).toMatch(/if \(fileExisted && !parsedOk\)/);
    expect(src).toMatch(/renameSync\(tmpPath, indexPath\)/);
  });
});
