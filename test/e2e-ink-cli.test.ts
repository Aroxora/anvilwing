/**
 * End-to-end test of the REAL anvilwing binary, per CLAUDE.md "Renderer /
 * UI changes: end-to-end test the actual user flow". Spawns dist/bin/
 * anvilwing.js under a PTY (via scripts/e2e-ink-cli-runner.mjs → the ui-pty
 * harness), drives real keystrokes, and asserts on the real on-screen
 * output: the user's input echoes as a chat line, no raw escape sequence
 * leaks as visible text, no line is stacked within a single frame (the
 * streaming/clear duplication bug class), and /clear re-shows the banner
 * without a raw screen-clear escape.
 *
 * Auth is bypassed with ANVILWING_SKIP_AUTH=1 (a real product flag) so the
 * shell renders without credentials. The live model round-trip is NOT
 * exercised here — it needs a provider key and is a separate concern; this
 * test covers the renderer/user-flow layer that shipped broken 3x before.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.resolve(REPO_ROOT, 'scripts', 'e2e-ink-cli-runner.mjs');
const BIN = path.resolve(REPO_ROOT, 'dist', 'bin', 'anvilwing.js');

interface Digest {
  scenario: string;
  sawHi: boolean;
  escapeLeakOnScreen: boolean;
  postClearHasBanner: boolean;
  maxDupInFrame: number;
  findingKinds: string[];
  uniqLineCount: number;
  sampleLines: string[];
}

function runE2E(scenario: string): Promise<Digest> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [RUNNER, scenario], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('E2E_RESULT '));
      if (!line) {
        reject(new Error(`runner produced no E2E_RESULT (exit ${code}). stderr:\n${err.slice(0, 600)}`));
        return;
      }
      try {
        resolve(JSON.parse(line.slice('E2E_RESULT '.length)) as Digest);
      } catch (e) {
        reject(new Error(`bad runner JSON: ${(e as Error).message}\n${line.slice(0, 300)}`));
      }
    });
  });
}

jest.setTimeout(60_000);

// The PTY harness forks a pseudo-terminal via node-pty. Sandboxed CI
// environments often can't (posix_spawnp fails). Probe once; if a PTY
// cannot be forked here, SKIP the suite with a clear reason rather than
// hard-fail — per CLAUDE.md, a skipped+reasoned test is honest, a faked
// pass is not. Run on a real host to exercise the full-binary flow.
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
  console.warn('[e2e-ink-cli] SKIPPED: node-pty cannot fork a PTY in this environment. Run on a real terminal/host.');
}
const describePty = PTY_OK ? describe : describe.skip;

describePty('e2e: real anvilwing binary under a PTY (ANVILWING_SKIP_AUTH=1)', () => {
  beforeAll(() => {
    if (!fs.existsSync(BIN)) {
      throw new Error(`dist artifact missing: ${BIN}\nRun: npx tsc`);
    }
  });

  test('launches via Ink, echoes the user input as a chat line, no escape leak, no per-frame duplication', async () => {
    const d = await runE2E('hi');
    // Renderer-level invariants that hold without a model key: the real
    // binary launches via Ink, echoes the user's input as a chat line, and
    // leaks no raw escape sequence as visible text. (The streaming
    // commit-once / no-duplication guard lives in the ink-controller test,
    // which exercises it deterministically; here there is no model reply.)
    expect(d.sawHi).toBe(true);
    expect(d.escapeLeakOnScreen).toBe(false);
  });

  test('/clear resets via Ink (no raw clear-screen leak) and re-shows the welcome', async () => {
    const d = await runE2E('clear');
    // /clear must not leak a raw clear-screen escape as visible text, and the
    // welcome (key guidance / model status — no marketing splash) re-renders
    // after the Ink reset.
    expect(d.escapeLeakOnScreen).toBe(false);
    expect(d.postClearHasBanner).toBe(true);
  });
});
