/**
 * End-to-end tests of the REAL anvilwing binary for three Claude Code-parity
 * input modes, per CLAUDE.md "Renderer / UI changes: end-to-end test the actual
 * user flow":
 *   1. `!cmd` bash mode — a leading bang runs the line as a shell command
 *      directly (no model round-trip), output rendered.
 *   2. Multi-line input — a line ending in `\` continues onto the next line;
 *      the box renders multiple rows (continuation rows drop the `>` mark).
 *   3. `/` palette Enter — Enter on a typed partial RUNS the highlighted
 *      command (`/cont` → /context), not the raw partial.
 *
 * Spawns dist/bin/anvilwing.js under a PTY via the shared runner. Like the other
 * render suites this is fragile on a contended shared CI runner, so it self-
 * skips there (mirrors jest.config.cjs IS_CI; override ANVILWING_RUN_UI_TESTS=1)
 * and runs in the pre-push hook on a real host. CI-runnable logic coverage for
 * the `/` palette lives in test/slash-commands.test.ts.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.resolve(REPO_ROOT, 'scripts', 'e2e-ink-cli-runner.mjs');
const BIN = path.resolve(REPO_ROOT, 'dist', 'bin', 'anvilwing.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function runE2E(scenario: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [RUNNER, scenario], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('E2E_RESULT '));
      if (!line) { reject(new Error(`runner produced no E2E_RESULT (exit ${code}). stderr:\n${err.slice(0, 600)}`)); return; }
      try { resolve(JSON.parse(line.slice('E2E_RESULT '.length))); }
      catch (e) { reject(new Error(`bad runner JSON: ${(e as Error).message}\n${line.slice(0, 300)}`)); }
    });
  });
}

jest.setTimeout(60_000);
// These drive the real binary under a PTY on fixed keystroke timings; under
// full-suite CPU contention boot/render can lag a dwell and a frame is missed.
// Retry the transient flake (a real break fails all attempts). CI skips this
// suite entirely; this is for the local/pre-push full-suite run.
jest.retryTimes(2);

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
const IS_CI = (process.env['CI'] === 'true' || process.env['CI'] === '1' || process.env['GITHUB_ACTIONS'] === 'true')
  && process.env['ANVILWING_RUN_UI_TESTS'] !== '1';
const PTY_OK = !IS_CI && ptyCanFork();
if (!PTY_OK) {
  // eslint-disable-next-line no-console
  console.warn('[e2e-input-modes] SKIPPED: opt-in PTY render test (no PTY here or CI). Runs on the pre-push hook.');
}
const describePty = PTY_OK ? describe : describe.skip;

describePty('e2e: real anvilwing binary — input modes (Claude Code parity)', () => {
  beforeAll(() => {
    if (!fs.existsSync(BIN)) {
      throw new Error(`dist artifact missing: ${BIN}\nRun: npx tsc`);
    }
  });

  test('`!cmd` runs the line in bash directly and renders its output', async () => {
    const d = await runE2E('bash-bang');
    expect(d.sawBashOutput).toBe(true);
    expect(d.sawBashCmdLine).toBe(true);
  });

  test('a line ending in `\\` continues onto the next line (multi-line input)', async () => {
    const d = await runE2E('multiline-input');
    expect(d.sawFirstLine).toBe(true);
    expect(d.sawContinuationLine).toBe(true);
  });

  test('`/` palette: Enter runs the highlighted command (/cont → /context)', async () => {
    const d = await runE2E('slash-enter-run');
    expect(d.sawContextRan).toBe(true);
  });

  test('Esc interrupts a running turn (the "esc to interrupt" promise is real)', async () => {
    const d = await runE2E('esc-interrupt');
    expect(d.sawWasBusy).toBe(true);       // a turn was actually running
    expect(d.sawInterrupted).toBe(true);   // Esc interrupted it
  });

  test('`?` on an empty buffer shows the shortcuts panel (the "? for shortcuts" promise is real)', async () => {
    const d = await runE2E('question-shortcuts');
    expect(d.sawShortcutsBody).toBe(true);   // the panel body rendered
    expect(d.questionNotTyped).toBe(true);   // `?` was not inserted as text
  });

  test('multi-line paste lands whole in the buffer (not truncated at the first newline)', async () => {
    const d = await runE2E('multiline-paste');
    expect(d.pasteAllLines).toBe(true);       // alpha + beta + gamma all present
    expect(d.pasteNotSubmitted).toBe(true);   // editable in the buffer, not auto-submitted
  });

  test('a large paste collapses to a compact [Pasted text #1 +N lines] placeholder', async () => {
    const d = await runE2E('large-paste');
    expect(d.sawPlaceholder).toBe(true);      // the compact token rendered in the box
    expect(d.rawLinesNotInBox).toBe(true);    // the raw lines did not flood the box
    expect(d.pasteNotSubmitted).toBe(true);   // still editable in the buffer
  });

  test('forward-Delete removes the char at the cursor (not the one to its left)', async () => {
    const d = await runE2E('forward-delete');
    expect(d.fwdDelCorrect).toBe(true);       // "abc" + ←← + Del → "ac"
    expect(d.fwdDelNotBackspace).toBe(true);  // not "bc"
  });

  test('an inline panel dismisses on any keypress (the "press any key to dismiss" promise is real)', async () => {
    const d = await runE2E('panel-dismiss');
    expect(d.panelShown).toBe(true);          // /help opened the panel
    expect(d.panelDismissed).toBe(true);      // a keystroke closed it
    expect(d.dismissKeyConsumed).toBe(true);  // that key didn't type into the box
  });

  test('Esc with a panel open during a running turn dismisses AND interrupts (panel must not swallow "esc to interrupt")', async () => {
    const d = await runE2E('panel-esc-interrupt');
    expect(d.sawWasBusy).toBe(true);      // a turn was actually running
    expect(d.panelShown).toBe(true);      // /help opened the panel mid-run
    expect(d.panelDismissed).toBe(true);  // Esc closed the panel
    expect(d.sawInterrupted).toBe(true);  // …and Esc still reached the interrupt handler
  });
});
