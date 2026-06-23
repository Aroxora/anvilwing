#!/usr/bin/env node
// Drives the REAL built binary against the REAL model through a full agentic
// EXECUTION flow (task → Write tool → file lands on disk → finish) inside a
// sandboxed temp workdir, then prints an AGENTIC_RESULT JSON digest the jest
// e2e test asserts on. Run as a subprocess (like e2e-ink-cli-runner.mjs) so the
// network-calling binary spawns from a clean node process, not the jest worker.
//
// Key: from ANVILWING_API_KEY env or the gitignored .env (BYO). Prints
// AGENTIC_RESULT {"skipped":"no-key"} and exits 0 when no key is available.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = resolve(REPO, 'dist', 'bin', 'anvilwing.js');
const require = createRequire(import.meta.url);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][AB0]/g, '');

function resolveKey() {
  if (process.env.ANVILWING_API_KEY) return process.env.ANVILWING_API_KEY;
  try { return (readFileSync(join(REPO, '.env'), 'utf8').match(/^ANVILWING_API_KEY=(.+)$/m) || [])[1]?.trim() || null; }
  catch { return null; }
}

const KEY = resolveKey();
if (!KEY) { console.log('AGENTIC_RESULT ' + JSON.stringify({ skipped: 'no-key' })); process.exit(0); }

const pty = require('node-pty');
const work = mkdtempSync(join(tmpdir(), 'tw-agentic-'));
const data = mkdtempSync(join(tmpdir(), 'tw-agentic-data-'));
const proof = join(work, 'proof.txt');
const TASK = 'Create a file named proof.txt in the current directory containing exactly the text AGENTIC-OK-7 and nothing else. Then stop.';

const term = pty.spawn('node', [BIN], {
  name: 'xterm-256color', cols: 100, rows: 36, cwd: work,
  env: { ...process.env, ANVILWING_API_KEY: KEY, ANVILWING_DATA_DIR: data, FORCE_COLOR: '1' },
});
let buf = '';
term.onData((d) => { buf += d; });

try {
  const bootDeadline = Date.now() + 20_000;
  while (Date.now() < bootDeadline && !/for commands|for shortcuts|No Anvilwing/.test(strip(buf))) await wait(250);
  term.write(TASK + '\r');
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    if (existsSync(proof) && readFileSync(proof, 'utf8').includes('AGENTIC-OK-7')) break;
    await wait(1000);
  }
  await wait(1500);
  const screen = strip(buf);
  const fileExists = existsSync(proof);
  console.log('AGENTIC_RESULT ' + JSON.stringify({
    fileCreated: fileExists,
    fileContentOk: fileExists && readFileSync(proof, 'utf8').includes('AGENTIC-OK-7'),
    sawToolResult: /⎿|Created proof|line written|⏺\s+\w+\(/.test(screen),
    sawError: /\b(401|403|429|invalid api key|unauthorized)\b/i.test(screen),
  }));
} finally {
  try { term.kill(); } catch { /* ignore */ }
  rmSync(work, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
}
