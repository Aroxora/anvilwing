/**
 * End-to-end test of the REAL anvilwing binary for /context, per CLAUDE.md
 * "Renderer / UI changes: end-to-end test the actual user flow". Spawns
 * dist/bin/anvilwing.js under a PTY (via scripts/e2e-ink-cli-runner.mjs),
 * types `/context`, and asserts on the real virtual screen that the usage
 * panel BODY renders: the "Context" header, the real 1M window, the
 * "% context left" line, and the Window/Free body rows.
 *
 * This is the test that would have caught the invisible-body bug: the inline
 * panel (used by /help · /keys · /context) was never passed to App as a block,
 * so only its first line leaked into the meta-chips row and the body never
 * showed on a real terminal. Component tests passed; this real-binary drive is
 * what exposes it.
 *
 * Auth is bypassed with ANVILWING_SKIP_AUTH=1 — /context reads the local
 * context window + history with no model round-trip.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.resolve(REPO_ROOT, 'scripts', 'e2e-ink-cli-runner.mjs');
const BIN = path.resolve(REPO_ROOT, 'dist', 'bin', 'anvilwing.js');

interface Digest {
  scenario: string;
  sawContextHeader: boolean;
  sawWindowTokens: boolean;
  sawContextLeft: boolean;
  sawContextBody: boolean;
  escapeLeakOnScreen: boolean;
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
const PTY_OK = ptyCanFork();
if (!PTY_OK) {
  // eslint-disable-next-line no-console
  console.warn('[e2e-context] SKIPPED: node-pty cannot fork a PTY in this environment. Run on a real terminal/host.');
}
const describePty = PTY_OK ? describe : describe.skip;

describePty('e2e: real anvilwing binary — /context renders the usage panel body', () => {
  beforeAll(() => {
    if (!fs.existsSync(BIN)) {
      throw new Error(`dist artifact missing: ${BIN}\nRun: npx tsc`);
    }
  });

  test('/context shows the window, % context left, and Window/Free body rows', async () => {
    const d = await runE2E('context');
    expect(d.sawContextHeader).toBe(true);
    expect(d.sawWindowTokens).toBe(true);   // real 1,000,000 window
    expect(d.sawContextLeft).toBe(true);
    expect(d.sawContextBody).toBe(true);     // body rows render (not just the header)
    expect(d.escapeLeakOnScreen).toBe(false);
  });
});
