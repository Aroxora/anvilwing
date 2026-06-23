/**
 * End-to-end test of the REAL anvilwing binary for /rewind, per CLAUDE.md
 * "Renderer / UI changes: end-to-end test the actual user flow". Spawns
 * dist/bin/anvilwing.js under a PTY (via scripts/e2e-ink-cli-runner.mjs), types
 * `/rewind` with no edits made yet, and asserts the real screen shows the
 * empty-state message — proving the command is wired in the shipped binary.
 *
 * The actual file revert (restore edited files, delete created ones) is covered
 * against the REAL fileChangeTracker on real files on disk in test/rewind.test.ts;
 * populating the tracker through the UI needs a model turn (key-gated), so this
 * E2E covers the wiring + empty state.
 *
 * Auth is bypassed with ANVILWING_SKIP_AUTH=1 — /rewind reads local change state
 * with no model round-trip.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.resolve(REPO_ROOT, 'scripts', 'e2e-ink-cli-runner.mjs');
const BIN = path.resolve(REPO_ROOT, 'dist', 'bin', 'anvilwing.js');

interface Digest {
  scenario: string;
  sawNothingToRewind: boolean;
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
  console.warn('[e2e-rewind] SKIPPED: node-pty cannot fork a PTY in this environment. Run on a real terminal/host.');
}
const describePty = PTY_OK ? describe : describe.skip;

describePty('e2e: real anvilwing binary — /rewind', () => {
  beforeAll(() => {
    if (!fs.existsSync(BIN)) {
      throw new Error(`dist artifact missing: ${BIN}\nRun: npx tsc`);
    }
  });

  test('/rewind with no edits shows the empty-state message', async () => {
    const d = await runE2E('rewind');
    expect(d.sawNothingToRewind).toBe(true);
    expect(d.escapeLeakOnScreen).toBe(false);
  });
});
