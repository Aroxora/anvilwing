/**
 * Auto-continue must read the turn's ACTUAL final response, not the response
 * buffer that message.complete already cleared.
 *
 * The bug (audit "autocontinue-buffer", adversarially upheld): the finally block
 * read this.currentResponseBuffer for the safety-refusal check, the governor's
 * combinedTurnOutput, and the completion detector — but the normal terminal
 * event (message.complete) clears that buffer first, so all three saw '' on
 * every successful turn. That permanently blinds completion detection (an
 * explicit "task complete" can never be seen) and safety-refusal termination.
 *
 * Fix: capture the authoritative final text into this.finalResponseText before
 * the clear, and feed the three reads from it. currentResponseBuffer and its
 * render path are untouched.
 *
 * Two layers per CLAUDE.md:
 *  - Behavioural, against the REAL detector: empty input can never produce the
 *    explicit-completion signal the shell needs; real text can. This is WHY
 *    feeding the cleared buffer was a bug.
 *  - Source-order guard: the finally reads use finalResponseText, not the
 *    cleared buffer. The `not.toContain(... currentResponseBuffer)` assertions
 *    fail before the fix (the old reads were exactly that) and pass after.
 *  The full shell-wiring E2E needs a live model key (skipped elsewhere with a
 *  reason, never mocked) — these two layers run on CI against real artifacts.
 */

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { TaskCompletionDetector } from '../src/core/taskCompletionDetector';

const SHELL = readFileSync(resolve(__dirname, '..', 'src', 'headless', 'interactiveShell.ts'), 'utf8');

describe('auto-continue final-response capture (audit autocontinue-buffer)', () => {
  test('the REAL completion detector needs the response text — empty input blinds it', () => {
    const withText = new TaskCompletionDetector().analyzeCompletion('Task complete. All done.', []);
    const empty = new TaskCompletionDetector().analyzeCompletion('', []);
    // The completion phrase trips the explicit-completion signal; '' never can —
    // and a high/medium-confidence "complete" verdict requires that signal.
    expect(withText.signals.hasExplicitCompletionStatement).toBe(true);
    expect(empty.signals.hasExplicitCompletionStatement).toBe(false);
    expect(withText.confidence).toBeGreaterThan(empty.confidence);
  });

  test('the finally auto-continue reads use finalResponseText, not the cleared buffer', () => {
    expect(SHELL).toContain('analyzeCompletion(this.finalResponseText, toolsUsed)');
    expect(SHELL).toContain('isSafetyRefusal(this.finalResponseText)');
    expect(SHELL).toContain("turnToolOutput + '\\n' + this.finalResponseText");
    // Pre-fix reads (the buffer message.complete already cleared) must be gone.
    expect(SHELL).not.toContain('analyzeCompletion(this.currentResponseBuffer');
    expect(SHELL).not.toContain('isSafetyRefusal(this.currentResponseBuffer)');
  });

  test('finalResponseText is captured before the clear and reset per turn', () => {
    // Captured from the authoritative sourceText on message.complete.
    expect(SHELL).toContain('this.finalResponseText = sourceText || this.finalResponseText');
    // Accumulated from deltas too (covers a turn that ends without message.complete).
    expect(SHELL).toContain('this.finalResponseText += event.content');
    // Reset at processPrompt start and message.start so it never leaks across turns.
    expect(SHELL).toContain("this.finalResponseText = '';");
    // The streaming buffer + its clears are left intact (render path unchanged).
    expect(SHELL).toContain("this.currentResponseBuffer = '';");
  });
});
