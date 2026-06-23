/**
 * LIVE end-to-end proof of the `↑ N tokens` slice, per CLAUDE.md's hard rule
 * for src/headless/interactiveShell.ts changes: spawn the REAL anvilwing
 * binary (dist/bin/anvilwing.js) under a PTY via scripts/e2e-ink-cli-runner.mjs,
 * submit a real prompt to the real Anvilwing API, and assert the spinner meta
 * shows a nonzero, increasing `↑ N tokens` while the response streams — the
 * integrated flow from provider usage/delta chunks through AgentController
 * events and TurnTokenMeter to the rendered StatusLine.
 *
 * Key-gated, never faked: with no real ANVILWING_API_KEY (env or gitignored
 * .env) the suite SKIPS with a reason instead of substituting a mock — the
 * deterministic, PTY-free pieces of the slice are covered in
 * test/turn-token-meter.test.ts, test/ink-controller.test.ts (spinner-meta)
 * and test/providers/openai-stream-usage.test.ts. Run locally before publish.
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
  tokenReadings: number[];
  sawTokenMeter: boolean;
  tokenIncreased: boolean;
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

function liveKeyAvailable(): boolean {
  if (process.env['ANVILWING_API_KEY']) return true;
  try {
    return /^ANVILWING_API_KEY=.+/m.test(fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8'));
  } catch {
    return false;
  }
}

const PTY_OK = ptyCanFork();
const KEY_OK = liveKeyAvailable();
if (!PTY_OK) {
  // eslint-disable-next-line no-console
  console.warn('[e2e-live-tokens] SKIPPED: node-pty cannot fork a PTY in this environment.');
} else if (!KEY_OK) {
  // eslint-disable-next-line no-console
  console.warn('[e2e-live-tokens] SKIPPED: no ANVILWING_API_KEY in env or .env — the live model round-trip cannot run for real. Provide the key and re-run locally.');
}
const describeLive = PTY_OK && KEY_OK ? describe : describe.skip;

jest.setTimeout(150_000);

describeLive('e2e: real binary, real model — live `↑ N tokens` meter', () => {
  let d: Digest;

  beforeAll(async () => {
    if (!fs.existsSync(BIN)) {
      throw new Error(`dist artifact missing: ${BIN}\nRun: npx tsc`);
    }
    d = await runE2E('live-tokens');
  });

  test('the spinner meta shows a nonzero token meter during the streamed response', () => {
    expect(d.sawTokenMeter).toBe(true);
  });

  test('the meter INCREASES across frames while streaming (live estimate, not a dead end-of-request count)', () => {
    expect(d.tokenIncreased).toBe(true);
    expect(d.tokenReadings.length).toBeGreaterThanOrEqual(2);
  });

  test('no raw escape leaks as visible text', () => {
    expect(d.escapeLeakOnScreen).toBe(false);
  });
});
