/**
 * Phase 2 — Ink Prompt input box.
 *
 * Real-world test: spawn the prompt smoke harness as a subprocess, pipe
 * keystrokes through stdin, capture stderr's outcome markers (SUBMIT /
 * CANCEL / STATE), assert on the final buffer.
 *
 * Per CLAUDE.md "Tests run real, no compromises" — no mocked stdin, no
 * stub for Ink's reconciler. The harness mounts a real Ink tree with
 * process.stdin / process.stdout and the test drives it byte-by-byte.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ink-prompt-smoke.mjs');
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILT = path.resolve(REPO_ROOT, 'dist', 'ui', 'ink', 'Prompt.js');

interface RunResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  /** Final SUBMIT / CANCEL / null. */
  outcome: { type: 'submit'; text: string } | { type: 'cancel' } | null;
  /** Last STATE: line, decoded as { text, cursor } */
  lastState: { text: string; cursor: number } | null;
}

interface KeystrokeStep {
  /** Bytes to write to the subprocess stdin */
  bytes: string;
  /** Optional dwell after writing, in ms — gives Ink time to render */
  dwellMs?: number;
  /**
   * Block until the child echoes this exact buffer (via its STATE: line)
   * before sending the next step. Real terminals deliver each keystroke as
   * its own read because the render loop drains stdin between presses; under
   * heavy parallel test load a fixed dwell can't guarantee that, letting the
   * pipe coalesce typed text with a following control byte (which is then
   * sanitised as paste). Gating on the echoed state reproduces real
   * one-keystroke-at-a-time delivery deterministically.
   */
  awaitBufferEquals?: string;
}

async function runPrompt(steps: KeystrokeStep[], extraArgs: string[] = []): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, ...extraArgs], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    // Live view of the latest echoed buffer, updated as STATE: lines stream
    // in, so run() can gate the next keystroke on the child having rendered
    // the previous one.
    let liveBuffer: string | null = null;
    child.stderr.on('data', (b) => {
      stderr += b.toString();
      const matches = stderr.match(/^STATE:\s*(.*)\|\d+$/gm);
      if (matches && matches.length) {
        const last = matches[matches.length - 1]!.match(/^STATE:\s*(.*)\|\d+$/);
        if (last) liveBuffer = last[1] || '';
      }
    });
    child.stdout.on('data', (b) => { stdout += b.toString(); });

    let lastState: RunResult['lastState'] = null;
    let outcome: RunResult['outcome'] = null;

    // Drive the keystrokes serially with the requested dwells so Ink's
    // reconciler has a tick between actions. 120ms default lets Ink
    // commit the previous render before the next chunk arrives — without
    // this gap, Ink batches multiple keypresses into one parser call and
    // the reducer + render cycle can lag the input.
    const run = async () => {
      for (const step of steps) {
        child.stdin.write(step.bytes);
        if (step.awaitBufferEquals !== undefined) {
          const target = step.awaitBufferEquals;
          const deadline = Date.now() + 4000;
          while (liveBuffer !== target && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 25));
          }
        }
        await new Promise((r) => setTimeout(r, step.dwellMs ?? 120));
      }
      // Don't end stdin — the prompt may need to keep listening.
    };

    child.on('exit', (code) => {
      if (process.env['INK_TEST_DEBUG']) {
        const log = `[ink-test] exit=${code}\n--- stderr ---\n${stderr}\n--- stdout(first 200) ---\n${stdout.slice(0, 200)}\n`;
        fs.writeFileSync('/tmp/ink-test-debug.log', log, { flag: 'a' });
      }
      // Parse stderr for STATE: lines and SUBMIT/CANCEL outcomes.
      for (const line of stderr.split('\n')) {
        const stateMatch = line.match(/^STATE:\s*(.*)\|(\d+)$/);
        if (stateMatch) {
          lastState = { text: stateMatch[1] || '', cursor: Number(stateMatch[2]) };
          continue;
        }
        const submitMatch = line.match(/^SUBMIT:\s*(.*)$/);
        if (submitMatch) {
          outcome = { type: 'submit', text: submitMatch[1] || '' };
          continue;
        }
        if (line === 'CANCEL') outcome = { type: 'cancel' };
      }
      resolve({ exitCode: code, stderr, stdout, outcome, lastState });
    });

    void run();

    // Hard timeout so a hang doesn't wedge the suite. Set above jest's
    // per-test default (5s) — the per-test timeout is bumped on each
    // describe to 15s.
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, 12_000);
  });
}

const ENTER = '\r';
const BACKSPACE = '\x7f';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const CTRL_A = '\x01';
const CTRL_E = '\x05';
const CTRL_C = '\x03';
const CTRL_U = '\x15';
const CTRL_W = '\x17';
const CTRL_K = '\x0b';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const CTRL_O = '\x0f';
const CTRL_R = '\x12';
const ESC = '\x1b';
const TAB = '\t';

// Each subprocess test boots Node, mounts Ink, drives a sequence of
// keystrokes with dwells, captures stderr — comfortably exceeds the
// default 5s per-test timeout. 15s gives headroom without hiding hangs.
jest.setTimeout(20_000);
// See ink-controller.test.ts: retry transient ink-subprocess timing flakes.
jest.retryTimes(3);

describe('Ink Prompt — Phase 2 (subprocess + real stdin)', () => {
  beforeAll(() => {
    if (!fs.existsSync(BUILT)) {
      throw new Error(`dist artifact missing: ${BUILT}\nRun: npx tsc -p tsconfig.json`);
    }
  });

  test('typed text is captured and submitted on Enter', async () => {
    const r = await runPrompt([
      { bytes: 'hello world' },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'hello world' });
  });

  test('backspace removes the last character', async () => {
    const r = await runPrompt([
      { bytes: 'foox' },
      { bytes: BACKSPACE },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'foo' });
  });

  test('left/right arrows move the cursor mid-buffer', async () => {
    // Type "abXc", arrow-left once (cursor between X and c), backspace
    // (deletes X). Backspace removes the char *before* the cursor, so
    // cursor=3 → deletes char at index 2 = 'X' → buffer "abc".
    const r = await runPrompt([
      { bytes: 'abXc' },
      { bytes: LEFT },
      { bytes: BACKSPACE },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'abc' });
  });

  test('Ctrl+A jumps to home, Ctrl+E to end', async () => {
    // Type "world", Ctrl+A, type "hello ", Ctrl+E, submit.
    const r = await runPrompt([
      { bytes: 'world' },
      { bytes: CTRL_A },
      { bytes: 'hello ' },
      { bytes: CTRL_E },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'hello world' });
  });

  // These mods (Ctrl+U/W/K) are lone keystrokes in real use: the render
  // loop drains the pipe between keypresses, so the control byte always
  // arrives as its own chunk (Ink → key.ctrl + letter). The generous
  // dwell after the typed text reproduces that — without it, a fast test
  // write lets the pipe coalesce "foo bar"+\x17 into one paste-shaped
  // chunk, where the control byte is sanitised out (intended paste safety).
  test('Ctrl+W deletes the word before the cursor', async () => {
    const r = await runPrompt([
      { bytes: 'foo bar', awaitBufferEquals: 'foo bar' },
      { bytes: CTRL_W, awaitBufferEquals: 'foo ' },
      { bytes: ENTER, dwellMs: 250 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'foo ' });
  });

  test('Ctrl+U deletes everything left of the cursor', async () => {
    const r = await runPrompt([
      { bytes: 'discard this', awaitBufferEquals: 'discard this' },
      { bytes: CTRL_U, awaitBufferEquals: '' },
      { bytes: 'kept', awaitBufferEquals: 'kept' },
      { bytes: ENTER, dwellMs: 250 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'kept' });
  });

  test('Ctrl+K deletes from the cursor to end of line', async () => {
    // "abcdef", arrow-left ×3 → cursor at index 3, Ctrl+K drops "def".
    const r = await runPrompt([
      { bytes: 'abcdef', awaitBufferEquals: 'abcdef' },
      { bytes: LEFT, dwellMs: 150 }, { bytes: LEFT, dwellMs: 150 }, { bytes: LEFT, dwellMs: 150 },
      { bytes: CTRL_K, awaitBufferEquals: 'abc' },
      { bytes: ENTER, dwellMs: 250 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'abc' });
  });

  // Up/Down shell history (per session). The harness seeds history via
  // --history "first|second" (oldest→newest); awaitBufferEquals gates each
  // arrow on the recalled buffer so the sequence is deterministic under load.
  test('Up recalls the most recent history entry', async () => {
    const r = await runPrompt([
      { bytes: UP, awaitBufferEquals: 'second' },
      { bytes: ENTER, dwellMs: 250 },
    ], ['--history', 'first|second']);
    expect(r.outcome).toEqual({ type: 'submit', text: 'second' });
  });

  test('Up twice walks back to the oldest; Down returns toward newest', async () => {
    const r = await runPrompt([
      { bytes: UP, awaitBufferEquals: 'second' },
      { bytes: UP, awaitBufferEquals: 'first' },
      { bytes: DOWN, awaitBufferEquals: 'second' },
      { bytes: ENTER, dwellMs: 250 },
    ], ['--history', 'first|second']);
    expect(r.outcome).toEqual({ type: 'submit', text: 'second' });
  });

  test('Down past the newest restores the in-progress draft', async () => {
    const r = await runPrompt([
      { bytes: 'draft text', awaitBufferEquals: 'draft text' },
      { bytes: UP, awaitBufferEquals: 'old' },
      { bytes: DOWN, awaitBufferEquals: 'draft text' },
      { bytes: ENTER, dwellMs: 250 },
    ], ['--history', 'old']);
    expect(r.outcome).toEqual({ type: 'submit', text: 'draft text' });
  });

  test('Ctrl+O fires the expand-tool-result affordance (the "(ctrl+o to expand)" promise)', async () => {
    // The smoke harness wires onExpandToolResult to print EXPAND-FIRED. Type a
    // char first and gate on it echoing — that confirms Ink has mounted and is
    // processing input before Ctrl+O, so a slow mount under load can't drop the
    // keypress (Ctrl+O doesn't change the buffer, so it can't be awaited itself).
    const r = await runPrompt([
      { bytes: 'x', awaitBufferEquals: 'x' },
      { bytes: CTRL_O, dwellMs: 300 },
      { bytes: ENTER, dwellMs: 250 },
    ]);
    expect(r.stderr).toContain('EXPAND-FIRED');
  });

  // Ctrl+R reverse-i-search over the seeded history. A sentinel char (gated on
  // echo) confirms Ink is live so Ctrl+R lands as its own keystroke; the buffer
  // then mirrors the matched entry, so awaitBufferEquals tracks each step.
  const RHIST = ['--history', 'deploy the app|run the tests|deploy again'];

  test('Ctrl+R finds the newest matching history entry', async () => {
    const r = await runPrompt([
      { bytes: 'x', awaitBufferEquals: 'x' },
      { bytes: CTRL_R, dwellMs: 250 },
      { bytes: 'deploy', awaitBufferEquals: 'deploy again' },
      { bytes: ENTER, dwellMs: 250 },
    ], RHIST);
    expect(r.outcome).toEqual({ type: 'submit', text: 'deploy again' });
  });

  test('Ctrl+R again steps to the older match', async () => {
    const r = await runPrompt([
      { bytes: 'x', awaitBufferEquals: 'x' },
      { bytes: CTRL_R, dwellMs: 250 },
      { bytes: 'deploy', awaitBufferEquals: 'deploy again' },
      { bytes: CTRL_R, awaitBufferEquals: 'deploy the app' },
      { bytes: ENTER, dwellMs: 250 },
    ], RHIST);
    expect(r.outcome).toEqual({ type: 'submit', text: 'deploy the app' });
  });

  test('Esc cancels reverse-search and restores the pre-search draft', async () => {
    const r = await runPrompt([
      { bytes: 'mydraft', awaitBufferEquals: 'mydraft' },
      { bytes: CTRL_R, dwellMs: 250 },
      { bytes: 'deploy', awaitBufferEquals: 'deploy again' },
      { bytes: ESC, awaitBufferEquals: 'mydraft' },
      { bytes: ENTER, dwellMs: 250 },
    ], RHIST);
    expect(r.outcome).toEqual({ type: 'submit', text: 'mydraft' });
  });

  // @-mention autocomplete. The harness seeds the file list via
  // --completion-files; typing @<partial> opens the menu and the buffer
  // mirrors nothing until accept, so awaitBufferEquals tracks the accepted path.
  const CF = ['--completion-files', 'src/util.ts|src/utils/format.ts|README.md|src/core/agent.ts'];

  test('@-completion: Tab accepts the top match', async () => {
    const r = await runPrompt([
      { bytes: 'use @uti', awaitBufferEquals: 'use @uti' },
      { bytes: TAB, awaitBufferEquals: 'use @src/util.ts ' },
      { bytes: ENTER, dwellMs: 250 },
    ], CF);
    expect(r.outcome).toEqual({ type: 'submit', text: 'use @src/util.ts ' });
  });

  test('@-completion: Enter accepts when the menu is open (does not submit)', async () => {
    const r = await runPrompt([
      { bytes: '@agent', awaitBufferEquals: '@agent' },
      { bytes: ENTER, awaitBufferEquals: '@src/core/agent.ts ' }, // first Enter accepts
      { bytes: ENTER, dwellMs: 250 },                              // second Enter submits
    ], CF);
    expect(r.outcome).toEqual({ type: 'submit', text: '@src/core/agent.ts ' });
  });

  test('@-completion: Down moves the highlight, Tab accepts the 2nd match', async () => {
    const r = await runPrompt([
      { bytes: '@uti', awaitBufferEquals: '@uti' },
      { bytes: DOWN, dwellMs: 400 },
      { bytes: TAB, awaitBufferEquals: '@src/utils/format.ts ' },
      { bytes: ENTER, dwellMs: 250 },
    ], CF);
    expect(r.outcome).toEqual({ type: 'submit', text: '@src/utils/format.ts ' });
  });

  test('no @token: Enter submits normally (completion does not hijack submit)', async () => {
    const r = await runPrompt([
      { bytes: 'plain prompt', awaitBufferEquals: 'plain prompt' },
      { bytes: ENTER, dwellMs: 250 },
    ], CF);
    expect(r.outcome).toEqual({ type: 'submit', text: 'plain prompt' });
  });

  test('Ctrl+C with empty buffer cancels', async () => {
    const r = await runPrompt([
      { bytes: CTRL_C, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'cancel' });
  });

  test('Ctrl+C with non-empty buffer clears the buffer (does not exit)', async () => {
    const r = await runPrompt([
      { bytes: 'partial' },
      { bytes: CTRL_C },
      { bytes: 'replaced' },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'replaced' });
  });

  test('paste sanitization: ANSI escapes are stripped from input', async () => {
    // Same payload class as hardening issue #3.
    const r = await runPrompt([
      { bytes: 'a\x1b[2J\x1b[Hb', dwellMs: 100 },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'ab' });
  });

  test('paste sanitization: BEL / NUL stripped (\\b interpreted as backspace)', async () => {
    const r = await runPrompt([
      { bytes: 'x\x07y\x00z\bend', dwellMs: 100 },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    // \x07 (BEL) and \x00 (NUL) are stripped by sanitize. \x08 reaches
    // Ink's parser as a backspace key event, which removes the preceding
    // char from the buffer. So 'xyz' → backspace → 'xy', then 'end' →
    // 'xyend'. This is the documented Ink/terminal behaviour: the user
    // can't see the escape sequence inside paste, but they can paste a
    // literal BS to delete a character.
    expect(r.outcome).toEqual({ type: 'submit', text: 'xyend' });
  });

  test('initial value is preselected', async () => {
    const r = await runPrompt([
      { bytes: ENTER, dwellMs: 200 },
    ], ['--initial', 'preset']);
    expect(r.outcome).toEqual({ type: 'submit', text: 'preset' });
  });
});
