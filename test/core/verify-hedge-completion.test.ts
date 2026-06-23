/**
 * F3 + F4: a finished turn that ends ONLY on a verification hedge ("let me
 * double-check the output") trips hasIncompleteWorkIndicators, never matches the
 * DONE: sentinel, and loops — eventually to a governor-forced halt (reproduced
 * against the real binary; see the agent-quality memo "let me double-check defeats
 * completion detection"). F3 completes such a turn on the SECOND consecutive hedge
 * (one re-check is allowed). F4 resets the singleton detector across requests so
 * the counter (and other state) can't leak between user prompts.
 *
 * TaskCompletionDetector is a plain exported class — drive it directly.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TaskCompletionDetector } from '../../src/core/taskCompletionDetector.js';

const shellSrc = readFileSync(
  resolve(__dirname, '..', '..', 'src', 'headless', 'interactiveShell.ts'),
  'utf8'
);
const detectorSrc = readFileSync(
  resolve(__dirname, '..', '..', 'src', 'core', 'taskCompletionDetector.ts'),
  'utf8'
);

describe('F3: verify-hedge over-verify loop completes on the 2nd consecutive hedge', () => {
  it('does NOT complete on the first hedge, completes on the second', () => {
    const d = new TaskCompletionDetector();
    const hedge = 'I fixed the off-by-one in the parser. Let me double-check the output.';
    const first = d.analyzeCompletion(hedge, []);
    expect(first.isComplete).toBe(false); // one re-check is allowed
    const second = d.analyzeCompletion(hedge, []);
    expect(second.isComplete).toBe(true);
    expect(second.reason).toMatch(/re-verifying a finished result/i);
  });

  it('a hedge that carries MORE work via a connector never completes (no false stop)', () => {
    const d = new TaskCompletionDetector();
    const withWork = 'I fixed the parser. Let me double-check the output, then add the tests.';
    expect(d.analyzeCompletion(withWork, []).isComplete).toBe(false);
    expect(d.analyzeCompletion(withWork, []).isComplete).toBe(false); // still continuing
    expect(d.analyzeCompletion(withWork, []).isComplete).toBe(false);
  });

  it('a pending todo blocks the hedge-completion path', () => {
    const d = new TaskCompletionDetector();
    d.updateTodoStats(1, 0); // one task still pending
    const hedge = 'Implemented step 1. Let me double-check the output.';
    expect(d.analyzeCompletion(hedge, []).isComplete).toBe(false);
    expect(d.analyzeCompletion(hedge, []).isComplete).toBe(false);
  });

  it('a follow-up question blocks the hedge-completion path', () => {
    const d = new TaskCompletionDetector();
    const q = 'I fixed it. Let me double-check the output. Should I also update the README?';
    expect(d.analyzeCompletion(q, []).isComplete).toBe(false);
    expect(d.analyzeCompletion(q, []).isComplete).toBe(false);
  });

  it('a real "still failing" statement is never treated as a verify-hedge', () => {
    const d = new TaskCompletionDetector();
    const broken = 'I changed the parser but the build still fails. Let me double-check.';
    // detectFailingTestOrBuild / incomplete "still fails" keeps it going regardless of hedges
    expect(d.analyzeCompletion(broken, []).isComplete).toBe(false);
    expect(d.analyzeCompletion(broken, []).isComplete).toBe(false);
  });

  it('a DONE: turn completes immediately via the sentinel, not via the hedge counter', () => {
    const d = new TaskCompletionDetector();
    const done = 'Fixed the parser.\nDONE: fixed the off-by-one; npm test exited 0.';
    expect(d.analyzeCompletion(done, []).isComplete).toBe(true);
  });

  it('an intervening non-hedge turn resets the counter (no completion on a later lone hedge)', () => {
    const d = new TaskCompletionDetector();
    const hedge = 'I fixed it. Let me double-check the output.';
    expect(d.analyzeCompletion(hedge, []).isComplete).toBe(false); // count 1
    // a normal progress turn with a tool resets the streak
    d.analyzeCompletion('Reading the next file to continue.', ['read_file']);
    expect(d.analyzeCompletion(hedge, []).isComplete).toBe(false); // count back to 1, not 2
  });
});

describe('F4: the singleton completion detector is reset across requests', () => {
  it('reset() clears the verify-hedge streak', () => {
    const d = new TaskCompletionDetector();
    const hedge = 'I fixed it. Let me double-check the output.';
    d.analyzeCompletion(hedge, []); // streak 1
    d.reset();
    // After reset the streak is 0, so a lone hedge does not immediately complete.
    expect(d.analyzeCompletion(hedge, []).isComplete).toBe(false);
  });

  it('the shell resets the detector on a fresh prompt AND on /clear (F4 source guard)', () => {
    // Fresh-prompt block (alongside failureRegistry.reset) and the /clear handler.
    const resets = shellSrc.match(/getTaskCompletionDetector\(\)\.reset\(\)/g) ?? [];
    expect(resets.length).toBeGreaterThanOrEqual(2);
  });

  it('the detector resets its hedge counter inside reset() (F3 source guard)', () => {
    expect(detectorSrc).toMatch(/reset\(\)[\s\S]*consecutiveVerifyHedge = 0/);
    expect(detectorSrc).toMatch(/isVerifyHedgeOnly/);
    expect(detectorSrc).toMatch(/REMAINING_WORK_CONNECTOR_PATTERN/);
  });
});
