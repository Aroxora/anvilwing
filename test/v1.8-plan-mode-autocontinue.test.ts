/**
 * v1.8 hardening — plan-mode auto-continue loop (parity audit wf_b5a93168-332,
 * finding "Auto-continue loop does not check permission mode before continuing").
 *
 * In plan mode every mutating tool is blocked (planModeBlock). The post-turn
 * auto-continue gate only checked autoMode, so it kept regenerating "continue"
 * prompts → the model retried a mutating tool → blocked → loop, terminating
 * only via the governor stall ("Paused: no progress") instead of leaving the
 * proposed plan on screen for the user to approve (Shift+Tab). The gate now
 * consults permission mode via autoContinueAllowed().
 *
 * Behavioural coverage of the decision helper + a source net on the gate. The
 * full shell loop is not jest-importable (AgentController uses import.meta), so
 * end-to-end "loop actually stops in plan mode" needs a real-LLM run.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { autoContinueAllowed, setPermissionMode, getPermissionMode } from '../src/core/permissionMode.js';

const REPO = resolve(__dirname, '..');
const SHELL_SRC = readFileSync(resolve(REPO, 'src/headless/interactiveShell.ts'), 'utf8');

describe('autoContinueAllowed — plan mode is a single planning pass, no auto-continue', () => {
  test('plan mode blocks auto-continue even when autoMode is on', () => {
    expect(autoContinueAllowed('on', 'plan')).toBe(false);
  });

  test('default and acceptEdits allow auto-continue when autoMode is on', () => {
    expect(autoContinueAllowed('on', 'default')).toBe(true);
    expect(autoContinueAllowed('on', 'acceptEdits')).toBe(true);
  });

  test('autoMode off always blocks, regardless of permission mode', () => {
    expect(autoContinueAllowed('off', 'default')).toBe(false);
    expect(autoContinueAllowed('off', 'plan')).toBe(false);
    expect(autoContinueAllowed('off', 'acceptEdits')).toBe(false);
  });

  test('defaults to the live permission mode when none is passed', () => {
    const prev = getPermissionMode();
    try {
      setPermissionMode('plan');
      expect(autoContinueAllowed('on')).toBe(false);
      setPermissionMode('default');
      expect(autoContinueAllowed('on')).toBe(true);
    } finally {
      setPermissionMode(prev);
    }
  });
});

describe('source: the auto-continue gate consults permission mode', () => {
  test('interactiveShell imports and gates auto-continue through autoContinueAllowed', () => {
    expect(SHELL_SRC).toMatch(/import \{ autoContinueAllowed \} from '\.\.\/core\/permissionMode\.js'/);
    // The gate must be autoContinueAllowed(autoMode), NOT the old bare autoMode check.
    expect(SHELL_SRC).toMatch(/if \(autoContinueAllowed\(autoMode\)\)/);
  });
});
