/**
 * Regression: BackgroundShell accumulated every stdout/stderr chunk forever in
 * an array and re-join('')ed the FULL history on every poll — unbounded memory
 * and O(n) per poll — and nothing reaped background children at CLI shutdown.
 * The fix uses rolling buffers capped at MAX_BUFFER with absolute-offset
 * accounting, a "bytes dropped" notice (no silent caps), and an onShutdown reap.
 *
 * Drives the REAL BackgroundShell against real processes.
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BackgroundShell } from '../../src/tools/bashTools.js';

const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'tools', 'bashTools.ts'), 'utf8');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const internals = (s: BackgroundShell) => s as unknown as { stdoutBuf: string; stdoutDropped: number };

describe('BackgroundShell — bounded buffers + shutdown reaping', () => {
  test('a >1MB stream is bounded and reports dropped bytes (no silent cap)', async () => {
    // Emit ~2MB of 'a' to stdout.
    const shell = new BackgroundShell('buf-test', "head -c 2000000 /dev/zero | tr '\\0' a", process.cwd(), 150);
    shell.start();
    // 2MB of 'a' is produced in well under a second; wait generously.
    await wait(1500);

    expect(internals(shell).stdoutBuf.length).toBeLessThanOrEqual(1_000_000);
    expect(internals(shell).stdoutDropped).toBeGreaterThan(0);

    const out = shell.getNewOutput();
    expect(out.stdout).toMatch(/bytes dropped to bound the buffer/);
    shell.kill();
  }, 15000);

  test('polls are incremental (new output only, not the whole history re-dumped)', async () => {
    const shell = new BackgroundShell('incr-test', "printf 'AAA\\n'; sleep 0.3; printf 'BBB\\n'", process.cwd(), 150);
    shell.start();
    await wait(150);
    const first = shell.getNewOutput();
    await wait(400);
    const second = shell.getNewOutput();

    expect(first.stdout).toContain('AAA');
    expect(first.stdout).not.toContain('BBB');
    expect(second.stdout).toContain('BBB');
    expect(second.stdout).not.toContain('AAA'); // not re-dumped
    shell.kill();
  }, 15000);

  test('source: rolling cap, dropped-bytes notice, and shutdown reaping are wired', () => {
    expect(src).toMatch(/MAX_BUFFER\s*=\s*1_000_000/);
    expect(src).toMatch(/bytes dropped to bound the buffer/);
    expect(src).toMatch(/onShutdown\(\(\) => shellManager\.killAll\(\)\)/);
    expect(src).toMatch(/killAll\(\): void/);
    // The unbounded array buffers are gone.
    expect(src).not.toMatch(/this\.outputBuffer\.push/);
  });
});
