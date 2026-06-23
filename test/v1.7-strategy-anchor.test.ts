/**
 * Long-horizon strategy wiring — audit #20 and #23 (2026-06-12 design pass).
 *
 *  #20  Stale pending todos from a PRIOR request hijacked the next user
 *       prompt: CURRENT_TODOS was never cleared on a fresh prompt, so the
 *       auto-continue loop saw old pending items and ground the OLD plan.
 *  #23  Auto-continue re-anchoring carried almost no goal text — canned
 *       "Continue fixing — edit the next file" keywords replaced the
 *       original task, so a drifted model had nothing to steer back to.
 *
 * Behavioral coverage for clearCurrentTodos lives in test/todoTools.test.ts;
 * this pins the shell wiring (the runtime graph isn't jest-importable
 * in-process — see the testing-runtime memory).
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const SHELL = readFileSync(
  join(resolve(__dirname, '..'), 'src', 'headless', 'interactiveShell.ts'),
  'utf8',
);

describe('#20 — a fresh user prompt drops the previous request\'s plan', () => {
  test('clearCurrentTodos is imported and called inside the fresh-prompt branch', () => {
    expect(SHELL).toMatch(/import \{ getCurrentTodos, clearCurrentTodos \} from '\.\.\/tools\/todoTools\.js'/);
    // It sits next to the governor/failure reset — the fresh-user-prompt block.
    expect(SHELL).toMatch(/this\.adversarialCorrectionCount = 0;[\s\S]{0,400}clearCurrentTodos\(\);/);
  });
});

describe('#23 — every auto-continue restates the original goal', () => {
  test('the anchor line carries the original request text', () => {
    // Cap raised 300→1500 in the goal-pin pass (v1.5.40) so the whole goal,
    // not a stub, rides the re-anchor.
    expect(SHELL).toMatch(/Original request \(stay anchored to it\): "\$\{originalPrompt\.trim\(\)\.slice\(0, 1500\)\}"/);
  });

  test('the failing-test continuation and the canned keyword prompts all append the anchor', () => {
    const anchored = SHELL.match(/\$\{anchor\}/g) ?? [];
    // failing-test branch + the four keyword branches = at least 5 sites.
    expect(anchored.length).toBeGreaterThanOrEqual(5);
  });
});
