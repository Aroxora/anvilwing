/**
 * End-to-end test of the REAL anvilwing binary for the permission-mode
 * Shift+Tab interaction, per CLAUDE.md "Renderer / UI changes: end-to-end
 * test the actual user flow". Spawns dist/bin/anvilwing.js under a PTY (via
 * scripts/e2e-ink-cli-runner.mjs), drives real CSI \x1b[Z (Shift+Tab) bytes,
 * and asserts against the real virtual screen that:
 *   - the persistent toggle-modes strip shows all three mode labels in one
 *     row below the input box;
 *   - the ACTIVE mode cycles default → acceptEdits → plan → default (the
 *     strip highlight is color-only, so the plain-text witness is the meta
 *     row's permission chip + the trailing hint swap);
 *   - the strip row and the meta row both render BELOW the input box's
 *     bottom border ╰ (positional, strip first, meta under it);
 *   - no raw escape leaks as visible text.
 *
 * Deterministic, PTY-free coverage of the same path (real Prompt →
 * controller → App strip) lives in test/ink-controller.test.ts so the cycle
 * is verified in every environment; this file proves it against the real
 * shipped binary on a host where a PTY can fork.
 *
 * Auth is bypassed with ANVILWING_SKIP_AUTH=1 so the shell renders without
 * credentials — Shift+Tab is a pure-UI interaction with no model round-trip.
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
  sawAcceptEdits: boolean;
  sawPlanMode: boolean;
  endsAtDefault: boolean;
  stripShowsAllModes: boolean;
  sawCycleHint: boolean;
  rowsBelowBox: boolean;
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
  console.warn('[e2e-permission-mode] SKIPPED: node-pty cannot fork a PTY in this environment. Run on a real terminal/host.');
}
const describePty = PTY_OK ? describe : describe.skip;

describePty('e2e: real anvilwing binary — Shift+Tab permission-mode cycle', () => {
  let d: Digest;

  beforeAll(async () => {
    if (!fs.existsSync(BIN)) {
      throw new Error(`dist artifact missing: ${BIN}\nRun: npx tsc`);
    }
    d = await runE2E('permission-cycle');
  });

  test('the toggle-modes strip shows all three mode labels in one row', () => {
    expect(d.stripShowsAllModes).toBe(true);
  });

  test('Shift+Tab cycles the active mode default → acceptEdits → plan → default; no escape leak', () => {
    expect(d.sawAcceptEdits).toBe(true);
    expect(d.sawPlanMode).toBe(true);
    expect(d.sawCycleHint).toBe(true);
    expect(d.endsAtDefault).toBe(true);
    expect(d.escapeLeakOnScreen).toBe(false);
  });

  test('strip row and meta row both render BELOW the input box bottom border ╰', () => {
    expect(d.rowsBelowBox).toBe(true);
  });
});
