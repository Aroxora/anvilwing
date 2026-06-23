/**
 * End-to-end PTY test for the live follow-up prompt queue (Claude Code parity).
 * Per CLAUDE.md: renderer/UI changes (including the transient queued affordance
 * and queue drain paths) require a real-binary PTY test with real keystrokes.
 *
 * Uses ANVILWING_SKIP_AUTH=1 + the ANVILWING_TEST_FORCE_BUSY_MS seam (added in
 * interactiveShell.ts) to create a controllable isProcessing window without a
 * real LLM key or network. The seam forces the exact production queuing branch
 * (handleSubmit while isProcessing) and exercises drain on timeout.
 *
 * This file + the 'followup-queue' scenario in the runner + the seam together
 * satisfy the "real binary + real keystrokes + real rendered output" contract.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.resolve(REPO_ROOT, 'scripts', 'e2e-ink-cli-runner.mjs');
const BIN = path.resolve(REPO_ROOT, 'dist', 'bin', 'anvilwing.js');

interface QueueDigest {
  scenario: string;
  escapeLeakOnScreen: boolean;
  sawFollowOne: boolean;
  sawFollowTwo: boolean;
  sawOldQueuedBanner: boolean; // must be false (we no longer emit polluting banners)
  sawTransientQueued: boolean; // the real shipped UI surface
  sawBusyWithQueue: boolean;   // during the forced busy seam we see both TEST BUSY and the queue indicator
  findingKinds: string[];
  sampleLines: string[];
}

// Source-string guard (per CLAUDE.md + plan): if a future refactor removes the
// core mechanism that makes the queue graceful (history defer + transient UI
// instead of polluting banners), this test fails at CI time.
const controllerSrc = fs.readFileSync(
  path.join(REPO_ROOT, 'src/ui/ink/InkPromptController.ts'),
  'utf8'
);
const shellSrc = fs.readFileSync(
  path.join(REPO_ROOT, 'src/headless/interactiveShell.ts'),
  'utf8'
);
expect(controllerSrc).toMatch(/followUpQueueMode/);
expect(controllerSrc).toMatch(/setQueuedPrompts/);
expect(controllerSrc).toMatch(/addUserHistoryItem/);
expect(shellSrc).toMatch(/setFollowUpQueueMode/);
expect(shellSrc).toMatch(/setQueuedPrompts/);

function runQueueE2E(): Promise<QueueDigest> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [RUNNER, 'followup-queue'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('E2E_RESULT '));
      if (!line) {
        reject(new Error(`runner produced no E2E_RESULT (exit ${code}). stderr:\n${err.slice(0, 800)}`));
        return;
      }
      try {
        resolve(JSON.parse(line.slice('E2E_RESULT '.length)) as QueueDigest);
      } catch (e) {
        reject(new Error(`bad runner JSON: ${(e as Error).message}\n${line.slice(0, 400)}`));
      }
    });
  });
}

jest.setTimeout(90_000);

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

describe('live follow-up queue E2E (PTY + real binary + forced busy seam)', () => {
  beforeAll(() => {
    if (!fs.existsSync(BIN)) {
      throw new Error('dist/bin/anvilwing.js missing — run `npx tsc` first (required for E2E per CLAUDE.md)');
    }
  });

  if (!PTY_OK) {
    it.skip('SKIPPED: node-pty cannot fork PTY in this environment (common in CI sandboxes). Run on a real host/terminal with the pre-push hook. This is the honest behaviour required by CLAUDE.md for renderer E2E tests.', () => {});
    return;
  }

  test('types follow-ups live during forced busy window; input accepted, no crash, no old banner pollution (baseline)', async () => {
    const r = await runQueueE2E();

    // Basic renderer health (same as other e2e-*.test.ts)
    expect(r.escapeLeakOnScreen).toBe(false);
    expect(r.findingKinds).not.toContain('crash');

    // The follow-up texts were accepted by the live input path while isProcessing was forced
    expect(r.sawFollowOne).toBe(true);
    expect(r.sawFollowTwo).toBe(true);

    // GRACEFUL QUEUE REQUIREMENTS (fail-before / pass-after per CLAUDE.md + approved plan):
    // 1. No polluting "⏳ Queued (n pending)" system banners in the transcript.
    expect(r.sawOldQueuedBanner).toBe(false);

    // 2. The actual shipped transient queue surface ("⏳ Queued (N)") must be
    //    visible on the real rendered screen.
    expect(r.sawTransientQueued).toBe(true);

    // 3. During the forced busy window (TEST BUSY marker) the queue UI must
    //    also be present — proves live acceptance + transient rendering worked
    //    end-to-end through the real binary + real Ink + the production paths.
    expect(r.sawBusyWithQueue).toBe(true);

    // The scenario exercised the seam + queue entry point successfully.
    expect(r.scenario).toBe('followup-queue');
  });
});