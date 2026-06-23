/**
 * End-to-end test of the REAL anvilwing binary for the `/`-command palette
 * (Claude Code parity, the `/` half of typed completion). Per CLAUDE.md
 * "Renderer / UI changes: end-to-end test the actual user flow" + the panel
 * memory ("PTY-assert BODIES, not headers"): spawns dist/bin/anvilwing.js under
 * a PTY, types `/`, refines to `/di`, and Tab-completes — asserting the palette
 * renders command bodies (descriptions), filters live, and completes on the
 * real virtual screen.
 *
 * Deterministic, PTY-free coverage of the completion logic lives in
 * test/slash-commands.test.ts (runs in every environment incl. CI); this proves
 * it against the shipped binary on a host where a PTY can fork.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.resolve(REPO_ROOT, 'scripts', 'e2e-ink-cli-runner.mjs');
const BIN = path.resolve(REPO_ROOT, 'dist', 'bin', 'anvilwing.js');

interface Digest {
  scenario: string;
  escapeLeakOnScreen: boolean;
  sawSlashCmd: boolean;
  sawSlashDesc: boolean;
  sawSlashCompleted: boolean;
}

function runE2E(scenario: string): Promise<Digest> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [RUNNER, scenario], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('E2E_RESULT '));
      if (!line) { reject(new Error(`runner produced no E2E_RESULT (exit ${code}). stderr:\n${err.slice(0, 600)}`)); return; }
      try { resolve(JSON.parse(line.slice('E2E_RESULT '.length)) as Digest); }
      catch (e) { reject(new Error(`bad runner JSON: ${(e as Error).message}\n${line.slice(0, 300)}`)); }
    });
  });
}

jest.setTimeout(60_000);

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
// Like the other PTY render suites, this is fragile on a contended shared CI
// runner, so skip it there (mirrors jest.config.cjs IS_CI; override with
// ANVILWING_RUN_UI_TESTS=1). It runs in the pre-push hook on a real host. The
// CI-runnable proof of the same feature is test/slash-commands.test.ts.
const IS_CI = (process.env['CI'] === 'true' || process.env['CI'] === '1' || process.env['GITHUB_ACTIONS'] === 'true')
  && process.env['ANVILWING_RUN_UI_TESTS'] !== '1';
const PTY_OK = !IS_CI && ptyCanFork();
if (!PTY_OK) {
  // eslint-disable-next-line no-console
  console.warn('[e2e-slash-palette] SKIPPED: opt-in PTY render test (no PTY here or CI). CI uses test/slash-commands.test.ts; runs on the pre-push hook.');
}
const describePty = PTY_OK ? describe : describe.skip;

describePty('e2e: real anvilwing binary — `/` command palette', () => {
  beforeAll(() => {
    if (!fs.existsSync(BIN)) {
      throw new Error(`dist artifact missing: ${BIN}\nRun: npx tsc`);
    }
  });

  test('typing / opens the palette with command bodies; /di filters; Tab completes to /diff', async () => {
    const d = await runE2E('slash-palette');
    expect(d.sawSlashCmd).toBe(true);        // a command name rendered
    expect(d.sawSlashDesc).toBe(true);       // a description BODY rendered (not just a header)
    expect(d.sawSlashCompleted).toBe(true);  // Tab completed /di → /diff in the input row
    expect(d.escapeLeakOnScreen).toBe(false);
  });
});
