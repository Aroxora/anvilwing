/**
 * Regression: BackgroundShell.kill() escalated to SIGKILL only `if
 * (!this.process.killed)`, but Node sets ChildProcess.killed = true the moment a
 * signal is *sent* (not when the process exits). So after the SIGTERM, the guard
 * was always false and SIGKILL never fired — a SIGTERM-trapping process survived
 * forever. The fix escalates on real liveness (isRunning, cleared by the 'exit'
 * handler). Same `.killed` misuse existed in the foreground exec early-abort.
 *
 * This spawns a REAL process that ignores SIGTERM and asserts it is gone after
 * the escalation window.
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BackgroundShell } from '../../src/tools/bashTools.js';

const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'tools', 'bashTools.ts'), 'utf8');

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists but unsignalable
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BackgroundShell.kill — SIGKILL escalation actually fires', () => {
  test('a SIGTERM-trapping process is killed after the escalation window', async () => {
    // 150ms escalation so the test is fast; trap '' TERM makes SIGTERM a no-op.
    const shell = new BackgroundShell('kill-test', "trap '' TERM; sleep 5", process.cwd(), 150);
    shell.start();
    await wait(300); // let the trap install and the process settle
    const pid = (shell as unknown as { process: { pid: number } }).process.pid;
    expect(processAlive(pid)).toBe(true);

    shell.kill(); // SIGTERM (ignored) → SIGKILL after 150ms
    await wait(700); // past escalation + reap

    expect(processAlive(pid)).toBe(false);
  }, 15000);

  test('source: both SIGKILL escalations guard on liveness, not .killed', () => {
    expect(src).toMatch(/if \(this\.isRunning && this\.process\)/);
    expect(src).toMatch(/if \(!childExited\)/);
    // The buggy `.killed` guards must be gone.
    expect(src).not.toMatch(/!this\.process\.killed/);
    expect(src).not.toMatch(/if \(!child\.killed\)/);
  });
});
