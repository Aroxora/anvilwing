/**
 * e2e: the "thinking spews blank vertical lines" bug.
 *
 * Symptom (user report): while the model is thinking, the terminal fills with
 * blank vertical lines and stacked copies of the spinner / input box, with the
 * assistant response pushed down below the mess.
 *
 * Root cause (probe-verified — see scripts + measurements in the PR):
 * Ink's standard (non-incremental) log-update re-emits the ENTIRE dynamic
 * region on every animation frame. The thinking spinner self-ticks ~8×/s and
 * the token meter updates per chunk, so the whole multi-line frame — the
 * bordered input box, the permission strip, the meta line, and the blank
 * `marginTop` rows between them — is rewritten on every tick. Once the
 * transcript fills the screen the cursor sits at the bottom row, so each
 * rewrite's trailing newline scrolls the viewport; the matching per-line
 * cursor-up erase clamps at row 0 and cannot reclaim what scrolled into
 * scrollback. Net: a fresh copy of the frame (blank rows included) leaks
 * upward on every tick.
 *
 * Fix: mount Ink with `incrementalRendering: true` so only the lines that
 * CHANGED between frames are rewritten. The unchanged chrome (the box) is
 * emitted once and then skipped, so animating the spinner no longer rewrites —
 * or scrolls — the whole frame.
 *
 * This test drives the REAL InkPromptController (through createPromptController,
 * the same factory production uses) in a subprocess and asserts on its real
 * stdout. The discriminator: how many times the unchanged input-box border is
 * emitted across a full thinking+stream turn. Measured: 8 with the fix, 67
 * without (the spinner line itself, which legitimately changes each tick,
 * appears ~63× either way — proving the frame count is comparable and the
 * difference is purely the skipped chrome).
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.resolve(REPO_ROOT, 'scripts', 'ink-controller-smoke.mjs');
const BUILT = path.resolve(REPO_ROOT, 'dist', 'ui', 'ink', 'InkPromptController.js');
const SRC = path.resolve(REPO_ROOT, 'src', 'ui', 'ink', 'InkPromptController.ts');

interface RunResult { exitCode: number | null; stdout: string; stderr: string }

function run(scenario: string, dwellMs = 4000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, scenario], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('exit', (code) => resolve({ exitCode: code, stdout, stderr }));
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, dwellMs + 8_000);
  });
}

jest.setTimeout(30_000);
// Ink subprocess timing can lag under CI CPU contention — retry transient
// flakes; a real break fails every attempt (thresholds have wide margin).
jest.retryTimes(3);

describe('thinking phase does not leak blank vertical lines (incremental render)', () => {
  beforeAll(() => {
    if (!fs.existsSync(BUILT)) {
      throw new Error(`dist artifact missing: ${BUILT}\nRun: npm run build`);
    }
  });

  test('the unchanged input-box chrome is NOT re-emitted on every animation frame', async () => {
    const r = await run('thinking-stream');
    expect(r.stderr).toContain('THINKING-DONE'); // the thinking phase actually ran

    // The spinner row legitimately changes every tick, so it is emitted many
    // times — this proves the turn animated through a real multi-frame
    // thinking phase (not a single static render that would trivially pass).
    const spinnerEmits = (r.stdout.match(/esc to interrupt/g) ?? []).length;
    expect(spinnerEmits).toBeGreaterThan(15);

    // The bordered input box is UNCHANGED for the whole turn. With incremental
    // rendering it is emitted only when it genuinely changes (initial mount +
    // each <Static> commit) — a small count bounded by the number of committed
    // turns, NOT by the number of animation ticks. Without the fix it is
    // re-emitted once per frame (measured: 67), and every one of those rewrites
    // is a frame that scrolls a blank-laden copy into the transcript.
    const boxTop = (r.stdout.match(/╭/g) ?? []).length;
    const boxBottom = (r.stdout.match(/╰/g) ?? []).length;
    // Fix → ~8; no-fix → ~67. A threshold of 25 separates them with wide margin
    // and is independent of how many spinner ticks the runner managed.
    expect(boxBottom).toBeLessThan(25);
    expect(boxTop).toBeLessThan(25);
    // And the box re-emission count must be far below the spinner tick count —
    // i.e. the chrome is decoupled from the animation (the property that was
    // violated by the bug).
    expect(boxBottom).toBeLessThan(spinnerEmits);

    // Reasoning ('thought') content must never leak into the visible chat.
    expect(r.stdout).not.toContain('reasoning step');
    // The streamed answer must still arrive.
    expect(r.stdout).toContain('drains microtasks');
  });

  test('source guard: the Ink mount enables incrementalRendering (regression tripwire)', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    // Both mount sites (initial start + /clear remount) must request it, or the
    // per-tick blank-line leak returns on whichever path drops it.
    const matches = src.match(/incrementalRendering:\s*true/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
