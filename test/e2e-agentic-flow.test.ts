/**
 * LIVE end-to-end proof that the full Claude-Code-style agentic EXECUTION flow
 * works on the real binary against the real model: receive a task → call a tool
 * (Write) → the file ACTUALLY lands on disk with the asked-for content → finish.
 * This is the "does it actually do what's asked, end to end" contract — the
 * strongest check that running the CLI (`anvilwing` / `anvilwing`) does real
 * work, not just renders UI.
 *
 * Driven through scripts/e2e-agentic-runner.mjs as a SUBPROCESS (like
 * e2e-live-tokens) so the network-calling binary spawns from a clean node
 * process — a direct pty.spawn from the instrumented jest worker stalls the
 * model round-trip. The runner sandboxes the file write in a temp workdir.
 *
 * Key-gated, never faked (CLAUDE.md "tests run real"): with no real
 * ANVILWING_API_KEY (env or the gitignored .env) the suite SKIPS with a reason
 * rather than substituting a mock.
 */
import { describe, expect, test, beforeAll } from '@jest/globals';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const RUNNER = resolve(REPO_ROOT, 'scripts', 'e2e-agentic-runner.mjs');
const BIN = resolve(REPO_ROOT, 'dist', 'bin', 'anvilwing.js');

interface Digest {
  fileCreated?: boolean;
  fileContentOk?: boolean;
  sawToolResult?: boolean;
  sawError?: boolean;
  skipped?: string;
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

function runAgentic(): Promise<Digest> {
  return new Promise((res, rej) => {
    const child = spawn('node', [RUNNER], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('error', rej);
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('AGENTIC_RESULT '));
      if (!line) { rej(new Error(`runner produced no AGENTIC_RESULT (exit ${code}). stderr:\n${err.slice(0, 800)}`)); return; }
      try { res(JSON.parse(line.slice('AGENTIC_RESULT '.length)) as Digest); }
      catch (e) { rej(new Error(`bad runner JSON: ${(e as Error).message}\n${line.slice(0, 300)}`)); }
    });
  });
}

const PTY_OK = ptyCanFork();
const KEY_OK = keyAvailable();
if (!PTY_OK) {
  // eslint-disable-next-line no-console
  console.warn('[e2e-agentic-flow] SKIPPED: node-pty cannot fork a PTY here.');
} else if (!KEY_OK) {
  // eslint-disable-next-line no-console
  console.warn('[e2e-agentic-flow] SKIPPED: no ANVILWING_API_KEY in env or .env — the live agentic round-trip cannot run for real. Provide the key and re-run locally.');
}
const describeLive = PTY_OK && KEY_OK ? describe : describe.skip;

jest.setTimeout(200_000);

describeLive('e2e: real binary, real model — full agentic execution flow', () => {
  let d: Digest;

  beforeAll(async () => {
    if (!existsSync(BIN)) throw new Error(`dist artifact missing: ${BIN}\nRun: npx tsc`);
    d = await runAgentic();
  });

  test('the agent executed a Write tool and the file ACTUALLY landed on disk with the asked-for content', () => {
    expect(d.skipped).toBeUndefined();
    expect(d.fileCreated).toBe(true);
    expect(d.fileContentOk).toBe(true);
  });

  test('the tool execution is reflected in the rendered transcript and no auth/API error surfaced', () => {
    expect(d.sawToolResult).toBe(true);
    expect(d.sawError).toBe(false);
  });
});
