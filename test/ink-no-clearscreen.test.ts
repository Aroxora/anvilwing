/**
 * Guarantees the Ink renderer never emits a clear-screen sequence
 * (\x1b[2J or \x1b[1J) on mount or via state updates. Pre-existing
 * shell content above the launch point must survive — Ink is supposed
 * to write inline going downward, not "take over" the terminal.
 *
 * This is the test that backs the user-visible promise. If a future
 * change accidentally introduces an `Ink.render(..., { exitOnCtrlC,
 * patchConsole, ... })` option that emits clear-screen, this catches it.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ink-controller-smoke.mjs');
const REPO_ROOT = path.resolve(__dirname, '..');

jest.setTimeout(20_000);
// See ink-controller.test.ts: retry transient ink-subprocess timing flakes.
jest.retryTimes(3);

interface RunResult { stdout: string; stderr: string; exitCode: number | null; }

async function run(scenario: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, scenario], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    setTimeout(() => { try { child.stdin.end(); } catch { /* noop */ } }, 1_000);
    child.on('exit', (code) => resolve({ stdout, stderr, exitCode: code }));
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 9_000);
  });
}

describe('Ink renderer — no clear-screen on mount', () => {
  beforeAll(() => {
    if (!fs.existsSync(path.resolve(REPO_ROOT, 'dist/ui/ink/InkPromptController.js'))) {
      throw new Error('dist artifact missing — run `npx tsc -p tsconfig.json` first');
    }
  });

  test('addEvent flow never writes \\x1b[2J or \\x1b[1J', async () => {
    const r = await run('addEvent-flow');
    // \x1b[2J = clear entire screen, \x1b[1J = clear from cursor up.
    // Either would visually wipe pre-existing terminal content.
    // \x1b[J alone (clear-from-cursor-down) is fine — Ink uses it to
    // tidy its own render zone, not to wipe scrollback.
    expect(r.stdout).not.toMatch(/\x1b\[2J/);
    expect(r.stdout).not.toMatch(/\x1b\[1J/);
  });

  test('mode-toggle flow never writes \\x1b[2J or \\x1b[1J', async () => {
    const r = await run('mode-toggle');
    expect(r.stdout).not.toMatch(/\x1b\[2J/);
    expect(r.stdout).not.toMatch(/\x1b\[1J/);
  });
});
