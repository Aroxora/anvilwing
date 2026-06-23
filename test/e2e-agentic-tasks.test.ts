/**
 * LIVE behavioural proofs that the real binary + real model DO WHAT'S ASKED
 * across more than "create a file" — the common task shapes a coding agent must
 * get right, each asserted on the REAL disk:
 *   - EDIT an existing file (change X→Y surgically, keep the rest)
 *   - RUN a shell command and use its output (write stdout to a file)
 *   - a 2-STEP task (create a.txt, then derive b.txt from it)
 *
 * Driven through scripts/e2e-agentic-tasks-runner.mjs as a SUBPROCESS (clean
 * node process, not the jest worker — a direct pty.spawn from the worker stalls
 * the model round-trip). Key-gated, never faked (CLAUDE.md "tests run real"):
 * with no ANVILWING_API_KEY (env or gitignored .env) the suite SKIPS with a
 * reason instead of substituting a mock.
 */
import { describe, expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const RUNNER = resolve(REPO_ROOT, 'scripts', 'e2e-agentic-tasks-runner.mjs');
const BIN = resolve(REPO_ROOT, 'dist', 'bin', 'anvilwing.js');

interface Digest {
  scenario?: string;
  skipped?: string;
  sawError?: boolean;
  // edit
  changed?: boolean; oldGone?: boolean; keptOtherLine?: boolean;
  // bash
  outFileHasCommandOutput?: boolean;
  // twostep
  step1Ok?: boolean; step2Ok?: boolean;
  // multifile
  bothChanged?: boolean; bothOldGone?: boolean; keptContext?: boolean;
  // recover
  bugFixed?: boolean; outputCaptured?: boolean;
  // clearmem
  forgotSecret?: boolean; sawAcknowledge?: boolean;
}

function keyAvailable(): boolean {
  if (process.env['ANVILWING_API_KEY']) return true;
  try { return /^ANVILWING_API_KEY=.+/m.test(readFileSync(join(REPO_ROOT, '.env'), 'utf8')); }
  catch { return false; }
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

function runTask(scenario: string): Promise<Digest> {
  return new Promise((res, rej) => {
    const child = spawn('node', [RUNNER, scenario], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('error', rej);
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('TASK_RESULT '));
      if (!line) { rej(new Error(`runner produced no TASK_RESULT (exit ${code}). stderr:\n${err.slice(0, 800)}`)); return; }
      try { res(JSON.parse(line.slice('TASK_RESULT '.length)) as Digest); }
      catch (e) { rej(new Error(`bad runner JSON: ${(e as Error).message}\n${line.slice(0, 300)}`)); }
    });
  });
}

const PTY_OK = ptyCanFork();
const KEY_OK = keyAvailable();
if (!PTY_OK) {
  // eslint-disable-next-line no-console
  console.warn('[e2e-agentic-tasks] SKIPPED: node-pty cannot fork a PTY here.');
} else if (!KEY_OK) {
  // eslint-disable-next-line no-console
  console.warn('[e2e-agentic-tasks] SKIPPED: no ANVILWING_API_KEY in env or .env — the live round-trip cannot run for real. Provide the key and re-run locally.');
}
const describeLive = PTY_OK && KEY_OK ? describe : describe.skip;

jest.setTimeout(220_000);

describeLive('e2e: real binary, real model — does what is asked across task shapes', () => {
  test('EDIT: changes X→Y in an existing file, surgically (old value gone, other lines kept)', async () => {
    const d = await runTask('edit');
    expect(d.sawError).toBe(false);
    expect(d.changed).toBe(true);     // NEW_VALUE_BETA is on disk
    expect(d.oldGone).toBe(true);     // OLD_VALUE_ALPHA is gone
    expect(d.keptOtherLine).toBe(true); // a surgical edit, not a whole-file clobber
  });

  test('RUN: executes a shell command and writes its real output to a file', async () => {
    const d = await runTask('bash');
    expect(d.sawError).toBe(false);
    expect(d.outFileHasCommandOutput).toBe(true); // out.txt holds the command's stdout
  });

  test('TWO-STEP: creates a.txt, then derives b.txt from it (both land on disk)', async () => {
    const d = await runTask('twostep');
    expect(d.sawError).toBe(false);
    expect(d.step1Ok).toBe(true); // a.txt === "hello"
    expect(d.step2Ok).toBe(true); // b.txt === "HELLO"
  });

  test('MULTI-FILE: changes a marker in BOTH files, surgically (context preserved)', async () => {
    const d = await runTask('multifile');
    expect(d.sawError).toBe(false);
    expect(d.bothChanged).toBe(true); // MARKER_NEW in one.txt AND two.txt
    expect(d.bothOldGone).toBe(true); // MARKER_OLD gone from both
    expect(d.keptContext).toBe(true); // surrounding lines preserved in both
  });

  test('ERROR-RECOVERY: diagnoses a real bug, fixes the source, and captures the corrected output', async () => {
    // buggy.js has an off-by-one that prints SUM=NaN; the agent must read,
    // fix, re-run, and write SUM=12 to fixed.txt — the diagnose-and-fix loop.
    const d = await runTask('recover');
    expect(d.sawError).toBe(false);
    expect(d.bugFixed).toBe(true);       // the `<= nums.length` off-by-one is gone
    expect(d.outputCaptured).toBe(true); // fixed.txt holds SUM=12
  });

  test('/CLEAR: starts a fresh conversation — the model forgets the prior turn (Claude Code parity)', async () => {
    // Tell the agent a secret, /clear, then ask for it back. A working /clear
    // resets the model's history, so it no longer knows the secret.
    const d = await runTask('clearmem');
    expect(d.sawError).toBe(false);
    expect(d.sawAcknowledge).toBe(true); // it DID see the secret before /clear
    expect(d.forgotSecret).toBe(true);   // …and no longer knows it after /clear
  });
});
