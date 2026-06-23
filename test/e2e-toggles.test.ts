/**
 * End-to-end test of the REAL anvilwing binary for the Ctrl+T toggles menu,
 * per CLAUDE.md "Renderer / UI changes: end-to-end test the actual user flow".
 * Spawns dist/bin/anvilwing.js under a PTY (via scripts/e2e-ink-cli-runner.mjs),
 * presses Ctrl+T (\x14), and asserts on the real virtual screen that the
 * toggles menu renders all three below-box settings with their on/off state.
 *
 * This is the keyboard-access surface for the below-box toggles (auto-continue,
 * confirm actions / HITL, debug) that previously needed slash commands.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.resolve(REPO_ROOT, 'scripts', 'e2e-ink-cli-runner.mjs');
const BIN = path.resolve(REPO_ROOT, 'dist', 'bin', 'anvilwing.js');

interface Digest {
  scenario: string;
  sawTogglesTitle: boolean;
  sawAutoToggle: boolean;
  sawConfirmToggle: boolean;
  sawDebugToggle: boolean;
  sawToggleState: boolean;
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
  console.warn('[e2e-toggles] SKIPPED: node-pty cannot fork a PTY in this environment.');
}
const describePty = PTY_OK ? describe : describe.skip;

describePty('e2e: real anvilwing binary — Ctrl+T toggles menu', () => {
  beforeAll(() => {
    if (!fs.existsSync(BIN)) {
      throw new Error(`dist artifact missing: ${BIN}\nRun: npx tsc`);
    }
  });

  test('Ctrl+T opens a menu with all three toggles and their on/off state', async () => {
    const d = await runE2E('toggles');
    expect(d.sawTogglesTitle).toBe(true);
    expect(d.sawAutoToggle).toBe(true);
    expect(d.sawConfirmToggle).toBe(true);
    expect(d.sawDebugToggle).toBe(true);
    expect(d.sawToggleState).toBe(true);     // on/off renders, not just labels
    expect(d.escapeLeakOnScreen).toBe(false);
  });
});
