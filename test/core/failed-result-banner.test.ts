/**
 * Failed tool results render RED (not the uniform dim block) so the user can
 * scan the transcript for what went wrong. The interactiveShell tool.complete
 * handler detects failure by looking for the `═══ FAILED ═══` banner in the
 * result — the banner verifiedFailure() emits. This locks that producer↔detector
 * contract: if the banner text ever changes, the silent display regression
 * (failures rendering dim again) is caught here, and a success must NOT carry it.
 *
 * (interactiveShell itself can't be imported into jest — see the source guard.)
 */

import { describe, expect, test } from '@jest/globals';
import { verifiedFailure, verifiedSuccess } from '../../src/core/resultVerification.js';

const FAILED_BANNER = '═══ FAILED ═══';

describe('failed tool result is detectable by its banner', () => {
  test('verifiedFailure output contains the banner the shell keys on', () => {
    const out = verifiedFailure('Command failed with exit code 127', 'Output:\ncmd: not found');
    expect(out).toContain(FAILED_BANNER);
    expect(out).toContain('Command failed with exit code 127');
  });

  test('verifiedSuccess output does NOT contain the failure banner', () => {
    const out = verifiedSuccess('All good', 'ran the build, 0 errors');
    expect(out).not.toContain(FAILED_BANNER);
  });

  test('the banner is a contiguous string (no ANSI splits the keyed text)', () => {
    // The shell does result.includes('═══ FAILED ═══'); ANSI must wrap the whole
    // banner, not interleave it, or the detector silently misses failures.
    const out = verifiedFailure('boom', 'details');
    const noAnsi = out.replace(/\x1b\[[0-9;]*m/g, '');
    expect(noAnsi).toContain(FAILED_BANNER);
  });

  test('source guard: the shell routes a FAILED result to the red error render', () => {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    const shell = readFileSync(resolve(__dirname, '..', '..', 'src', 'headless', 'interactiveShell.ts'), 'utf8');
    expect(shell).toMatch(/event\.result\.includes\('═══ FAILED ═══'\)/);
    expect(shell).toMatch(/addEvent\(resultFailed \? 'error' : 'tool-result', summary\)/);
  });
});
