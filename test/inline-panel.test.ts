/**
 * Inline panel dismissal contract: panels persist until the user presses a
 * key — there is NO auto-dismiss timer. (The old 8s timer yanked /context
 * and /help mid-read; its old test simulated the timer inside the test
 * body — mock-of-SUT — so it kept passing no matter what the shell did.)
 *
 * Behavioral coverage for dismiss-on-keypress lives in the PTY e2e
 * (test/e2e-context.test.ts: "an inline panel dismisses on any keypress");
 * this file pins the source contract so a future re-introduction of a
 * dismissal timer fails CI.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const SHELL = readFileSync(
  join(resolve(__dirname, '..'), 'src', 'headless', 'interactiveShell.ts'),
  'utf8',
);

describe('inline panels persist until a keypress (no auto-dismiss timer)', () => {
  it('the shell has no scheduleInlinePanelDismiss / panel timer', () => {
    expect(SHELL).not.toMatch(/scheduleInlinePanelDismiss/);
    expect(SHELL).not.toMatch(/inlinePanelDismissTimer/);
  });

  it('dismissInlinePanel clears the panel directly (keypress path)', () => {
    expect(SHELL).toMatch(
      /private dismissInlinePanel\(\): void \{\s*\n\s*this\.promptController\?\.clearInlinePanel\(\);\s*\n\s*\}/,
    );
  });

  it('every panel writer sets the panel without arming a timer', () => {
    // setInlinePanel call sites must not be followed by a schedule call.
    expect(SHELL).toMatch(/setInlinePanel\(lines\);\s*\n\s*\}/);
  });
});
