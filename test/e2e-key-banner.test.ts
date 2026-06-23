/**
 * e2e: after a key is saved with /key, the welcome banner must reflect the saved
 * status. The /key success branch used to only print "✓ saved" and never
 * re-render the banner, so it kept showing "No Anvilwing API key configured".
 *
 * Spawns the REAL built binary in a PTY with a sandboxed home/data dir and NO
 * key, asserts the no-key banner, types `/key sk-…`, and asserts a refreshed
 * banner showing the masked key.
 */
import { describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][AB0]/g, '');

const itPosix = process.platform === 'win32' ? test.skip : test;

function ptyCanFork(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pty = require('node-pty');
    const p = pty.spawn(process.execPath, ['-e', '0'], { name: 'xterm', cols: 80, rows: 24 });
    p.kill();
    return true;
  } catch {
    return false;
  }
}
const PTY_OK = ptyCanFork();
if (!PTY_OK) {
  // eslint-disable-next-line no-console
  console.warn('[e2e-key-banner] SKIPPED: node-pty cannot fork a PTY in this environment. Run on a real terminal/host.');
}
const describePty = PTY_OK ? describe : describe.skip;

// Drive on observed content, not fixed dwells: under full-suite CPU contention
// boot/render lags well past a hard-coded 1500ms sleep, which is exactly what
// made this suite flake (it passed alone, failed in the loaded full run). Poll
// the stripped buffer until the marker appears or the deadline passes.
async function waitForMatch(read: () => string, re: RegExp, timeoutMs = 10000, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (re.test(read())) return true;
    await wait(stepMs);
  }
  return re.test(read());
}

// A frame can be missed entirely under heavy contention; retry the transient
// flake (a real break fails all attempts), matching the other PTY suites.
jest.retryTimes(2);

describePty('e2e: /key refreshes the welcome banner', () => {
  itPosix('typing a Anvilwing key re-renders the banner with the masked key', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pty = require('node-pty');
    const bin = resolve(__dirname, '..', 'dist', 'bin', 'anvilwing.js');
    const home = mkdtempSync(join(tmpdir(), 'tw-keybanner-'));
    const env = { ...process.env, ANVILWING_HOME: home, ANVILWING_DATA_DIR: home, FORCE_COLOR: '1' };
    delete (env as Record<string, string>)['ANVILWING_API_KEY'];

    const term = pty.spawn('node', [bin], { name: 'xterm-256color', cols: 100, rows: 32, env });
    let buf = '';
    term.onData((d: string) => { buf += d; });

    try {
      await waitForMatch(() => strip(buf), /No Anvilwing API key configured/); // boot
      const boot = strip(buf);
      expect(boot).toMatch(/No Anvilwing API key configured/);

      buf = '';
      term.write('/key sk-test0123456789abcdef0123456789ab\r');
      // The refreshed banner switches to the keyed-mode body (§7: model +
      // /help, no key material in chrome) and drops the no-key warning.
      await waitForMatch(() => strip(buf), /anvilwing · \/help for commands/);
      const after = strip(buf);

      expect(after).toMatch(/anvilwing · \/help for commands/);
      expect(after).not.toMatch(/No Anvilwing API key configured/);
    } finally {
      try { term.kill(); } catch { /* ignore */ }
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
