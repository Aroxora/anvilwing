/**
 * Phase 3 — Ink App integration. Proves StatusLine + Suggestions + Prompt
 * compose correctly with one render tree. Real subprocess, real stdin
 * pipe, real Ink reconciler.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ink-app-smoke.mjs');
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILT = path.resolve(REPO_ROOT, 'dist', 'ui', 'ink', 'App.js');

interface RunResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  outcome: { type: 'submit'; text: string } | { type: 'cancel' } | null;
  /** Cleaned final frame from stdout (ANSI stripped). */
  frame: string;
}

const STRIP_ANSI = (s: string): string => s
  .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
  .replace(/\x1b\][^\x07]*\x07/g, '')
  .replace(/\x1b./g, '');

interface Step {
  bytes: string;
  dwellMs?: number;
}

async function runApp(args: string[], steps: Step[] = []): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = ''; let stdout = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.stdout.on('data', (b) => { stdout += b.toString(); });

    let outcome: RunResult['outcome'] = null;
    const run = async () => {
      // Give Ink a moment to render the initial frame before we drive
      // input — we want test "frame contains X" assertions to see the
      // first commit, not the pre-render empty state.
      await new Promise((r) => setTimeout(r, 200));
      for (const step of steps) {
        child.stdin.write(step.bytes);
        await new Promise((r) => setTimeout(r, step.dwellMs ?? 120));
      }
    };

    child.on('exit', (code) => {
      for (const line of stderr.split('\n')) {
        const sub = line.match(/^SUBMIT:\s*(.*)$/);
        if (sub) outcome = { type: 'submit', text: sub[1] || '' };
        if (line === 'CANCEL') outcome = { type: 'cancel' };
      }
      // Take the last frame (after the final clear-region escape Ink emits).
      const segments = stdout.split(/\x1b\[\d*J/);
      const frame = STRIP_ANSI(segments[segments.length - 1] || stdout);
      resolve({ exitCode: code, stderr, stdout, outcome, frame });
    });

    void run();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 12_000);
  });
}

jest.setTimeout(20_000);
// See ink-controller.test.ts: retry transient ink-subprocess timing flakes.
jest.retryTimes(3);

describe('Ink App — Phase 3 (integration)', () => {
  beforeAll(() => {
    if (!fs.existsSync(BUILT)) {
      throw new Error(`dist artifact missing: ${BUILT}\nRun: npx tsc -p tsconfig.json`);
    }
  });

  test('renders status + prompt together; prompt accepts input', async () => {
    const r = await runApp(
      ['--message', 'Working', '--mode', 'HITL: on'],
      [{ bytes: 'hello\r', dwellMs: 200 }]
    );
    expect(r.outcome).toEqual({ type: 'submit', text: 'hello' });
    // Frame contains both the status and the prompt content.
    expect(r.frame).toContain('Working');
    expect(r.frame).toContain('HITL: on');
  });

  test('prompt-only mode (no status) still works', async () => {
    const r = await runApp(
      ['--no-status'],
      [{ bytes: 'x\r', dwellMs: 200 }]
    );
    // outcome is the authoritative proof of the submitted text — the
    // captured frame is the *post-submit* state where the buffer has
    // already been cleared, so we don't assert on it here.
    expect(r.outcome).toEqual({ type: 'submit', text: 'x' });
  });

  test('Ctrl+C with empty buffer cancels even with status visible', async () => {
    const r = await runApp(
      ['--message', 'Working'],
      [{ bytes: '\x03', dwellMs: 200 }]
    );
    expect(r.outcome).toEqual({ type: 'cancel' });
  });

  // ── Phase 4: <Static> chat history ─────────────────────────────────

  test('chat history renders above status + prompt (Phase 4)', async () => {
    const r = await runApp(
      [
        '--history', 'user:hello agent|assistant:hi! how can I help|tool:Bash: ls',
        '--message', 'Ready',
      ],
      [{ bytes: '\r', dwellMs: 300 }]
    );
    expect(r.outcome).toEqual({ type: 'submit', text: '' });
    // Combine the entire stdout (history is committed via <Static> as a
    // separate write so it's outside the last clear-region segment).
    const fullStripped = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '');
    expect(fullStripped).toContain('hello agent');
    expect(fullStripped).toContain('hi! how can I help');
    expect(fullStripped).toContain('Bash: ls');
  });

  test('history items render in order (Phase 4)', async () => {
    const r = await runApp(
      [
        '--history', 'system:line A|system:line B|system:line C',
        '--no-status',
      ],
      [{ bytes: '\r', dwellMs: 300 }]
    );
    expect(r.outcome).toEqual({ type: 'submit', text: '' });
    const fullStripped = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '');
    const a = fullStripped.indexOf('line A');
    const b = fullStripped.indexOf('line B');
    const c = fullStripped.indexOf('line C');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  test('empty history is fine — only prompt renders (Phase 4)', async () => {
    const r = await runApp(
      ['--no-status'],
      [{ bytes: 'ping\r', dwellMs: 200 }]
    );
    expect(r.outcome).toEqual({ type: 'submit', text: 'ping' });
  });
});
