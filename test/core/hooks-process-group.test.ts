/**
 * Regression: a hook command runs via exec WITHOUT detached, so on timeout
 * child.kill('SIGKILL') reached only the /bin/sh wrapper — grandchildren (e.g.
 * `node server.js`, a backgrounded `sleep`) were orphaned and kept running,
 * contradicting the code's own "kill the process group" comment. The fix runs
 * the hook as a process-group leader (detached) and kills the whole group
 * (negative pid) on timeout.
 *
 * Drives the REAL hook runner: a hook backgrounds a `sleep` grandchild, records
 * its pid to a file, then waits. After the hook times out, the grandchild must
 * be gone.
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync, existsSync, mkdtempSync, rmSync, readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPreToolUseHooks, type HooksConfig } from '../../src/core/hooks.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const itPosix = process.platform === 'win32' ? test.skip : test;

describe('hook timeout kills the whole process group (no orphaned grandchildren)', () => {
  itPosix('a backgrounded grandchild is killed when the hook times out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-hook-'));
    const pidFile = join(dir, 'gpid');
    try {
      // The hook backgrounds `sleep 10` (the grandchild), records its pid, and
      // `wait`s so the shell stays alive until our timeout fires.
      const command = `sleep 10 & echo $! > "${pidFile}"; wait`;
      const config: HooksConfig = {
        hooks: { PreToolUse: [{ matcher: '*', hooks: [{ command, timeoutMs: 500 }] }] },
      };

      const run = runPreToolUseHooks(config, 'AnyTool', {});

      // Wait until the grandchild pid is recorded (proves it started).
      for (let i = 0; i < 40 && !existsSync(pidFile); i++) await wait(50);
      expect(existsSync(pidFile)).toBe(true);
      const gpid = parseInt(rf(pidFile, 'utf8').trim(), 10);
      expect(Number.isFinite(gpid)).toBe(true);
      expect(alive(gpid)).toBe(true); // still running while the hook runs

      await run; // resolves when the hook times out (~500ms) and the group is killed
      await wait(600); // grace for SIGKILL to propagate

      expect(alive(gpid)).toBe(false); // grandchild reaped, not orphaned
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test('source: detached group leader + negative-pid group kill', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'hooks.ts'), 'utf8');
    expect(src).toMatch(/detached: process\.platform !== 'win32'/);
    expect(src).toMatch(/process\.kill\(-child\.pid, 'SIGKILL'\)/);
  });
});
