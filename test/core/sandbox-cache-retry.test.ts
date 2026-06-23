/**
 * Regression: ensureSandboxPaths() stored the in-flight createSandboxPaths
 * promise in the module-level sandboxCache and never removed it on rejection.
 * One transient mkdir failure (EACCES, disk full, read-only mount) cached a
 * REJECTED promise forever, so execute_bash was permanently broken for that
 * working dir until the process restarted. The fix evicts a failed attempt so
 * the next call retries.
 *
 * Simulates a transient failure through the REAL exported buildSandboxEnv by
 * blocking the sandbox path with a FILE (so mkdir fails), then removing it.
 */
import { describe, expect, test, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxEnv } from '../../src/tools/bashTools.js';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-sandbox-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('sandbox path cache — a transient failure does not poison the cwd', () => {
  test('retries after a transient mkdir failure (was: cached rejection forever)', async () => {
    const cwd = freshDir();
    // Block creation: make `.anvilwing` a FILE so mkdir of its subdirs fails.
    const blocker = join(cwd, '.anvilwing');
    writeFileSync(blocker, 'not a directory');

    // First attempt must fail while blocked.
    await expect(buildSandboxEnv(cwd)).rejects.toBeDefined();

    // Clear the transient condition.
    rmSync(blocker, { force: true });

    // Second attempt must now SUCCEED (the fix evicted the failed promise).
    // With the bug, the cached rejected promise replays and this rejects.
    const env = await buildSandboxEnv(cwd);
    expect(env['ANVILWING_SANDBOX_ROOT']).toContain(join('.anvilwing', 'shell-sandbox'));
    expect(existsSync(env['ANVILWING_SANDBOX_HOME'] as string)).toBe(true);
  });

  test('a successful result is still cached (no behavior change on the happy path)', async () => {
    const cwd = freshDir();
    const a = await buildSandboxEnv(cwd);
    const b = await buildSandboxEnv(cwd);
    expect(a['ANVILWING_SANDBOX_ROOT']).toBe(b['ANVILWING_SANDBOX_ROOT']);
  });
});
