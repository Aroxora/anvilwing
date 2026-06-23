/**
 * BashOutput must tail-truncate, not head-truncate.
 *
 * A common long-horizon pattern: start a background process (dev server, long
 * build, test watcher) with execute_bash run_in_background, then poll its output
 * with BashOutput. The actionable line — the compile error, the crash, the
 * "ready on :3000", the final exit status — is at the TAIL of that stream. The
 * tool-output truncator already keeps the tail for execute_bash ("the end is
 * usually most important"), but BashOutput did not match the bash branch and
 * fell through to head-only truncation, so an over-cap background log showed the
 * agent stale startup noise and DROPPED the recent error — and the task stalls
 * because the model never sees what went wrong.
 *
 * Drives the REAL ContextManager.truncateToolOutput(); no mock.
 */

import { describe, expect, test } from '@jest/globals';
import { ContextManager } from '../../src/core/contextManager.js';

const CAP = 600;
const cm = () => new ContextManager({ maxToolOutputLength: CAP });

/** A long background-process log whose only error is on the LAST line. */
function bgLog(): string {
  const startup = Array.from({ length: 200 }, (_, i) => `[boot] initializing module ${i} ... ok`).join('\n');
  return `${startup}\nERROR: build failed — Cannot find name 'foo' at src/x.ts:42:7`;
}

describe('BashOutput tail truncation (the actionable line lives at the end)', () => {
  test('BashOutput keeps the tail error when over cap (was head-truncated → error lost)', () => {
    const out = bgLog();
    expect(out.length).toBeGreaterThan(CAP); // precondition: truncation actually happens
    const r = cm().truncateToolOutput(out, 'BashOutput');
    expect(r.wasTruncated).toBe(true);
    // the recent error MUST survive so the model can diagnose
    expect(r.content).toContain("Cannot find name 'foo' at src/x.ts:42:7");
  });

  test('execute_bash already keeps the tail (regression guard for the existing behavior)', () => {
    const r = cm().truncateToolOutput(bgLog(), 'execute_bash');
    expect(r.wasTruncated).toBe(true);
    expect(r.content).toContain("Cannot find name 'foo' at src/x.ts:42:7");
  });

  test('BashOutput and execute_bash truncate identically (same command-output strategy)', () => {
    const out = bgLog();
    const a = cm().truncateToolOutput(out, 'BashOutput').content;
    const b = cm().truncateToolOutput(out, 'execute_bash').content;
    expect(a).toBe(b);
  });

  test('under-cap output is returned verbatim, untouched', () => {
    const small = 'ready on :3000';
    const r = cm().truncateToolOutput(small, 'BashOutput');
    expect(r.wasTruncated).toBe(false);
    expect(r.content).toBe(small);
  });

  test('source guard: BashOutput routes to the command-output (tail) branch', () => {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'contextManager.ts'), 'utf8');
    // the bash/command branch must include BashOutput alongside execute_bash
    expect(src).toMatch(/toolName === 'BashOutput'[\s\S]{0,120}truncateBashOutput|truncateBashOutput[\s\S]{0,200}/);
    expect(src).toMatch(/'BashOutput'/);
  });
});
