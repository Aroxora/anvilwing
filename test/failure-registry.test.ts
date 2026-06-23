/**
 * Cross-turn failure registry — catches the same error recurring across
 * auto-continue turns (a thrash the governor's consecutive-stall check misses)
 * and nudges the agent to change approach.
 *
 * Pure module → tested directly (fail-before: it didn't exist). The wiring into
 * interactiveShell's auto-continue block is source-asserted (import.meta blocks
 * Jest from importing that file).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FailureRegistry, extractErrorSignatures } from '../src/core/failureRegistry.js';

const SHELL = readFileSync(resolve(__dirname, '..', 'src', 'headless', 'interactiveShell.ts'), 'utf8');

describe('extractErrorSignatures', () => {
  it('picks up TS codes, missing modules, FAIL lines, runtime errors, and shell errors', () => {
    const sigs = extractErrorSignatures(
      `src/x.ts:3:1 - error TS2304: Cannot find name 'foo'\n` +
      `Cannot find module './missing.js'\n` +
      `FAIL test/auth.test.ts\n` +
      `TypeError: Cannot read properties of undefined (reading 'id')\n` +
      `bash: frobnicate: command not found\n` +
      `ENOENT: no such file or directory\n`
    );
    expect(sigs).toContain('TS2304');
    expect(sigs).toContain('module:./missing.js');
    expect(sigs.some((s) => s.startsWith('fail:'))).toBe(true);
    expect(sigs.some((s) => s.startsWith('TypeError:'))).toBe(true);
    expect(sigs).toContain('command-not-found');
    expect(sigs).toContain('ENOENT');
  });

  it('returns nothing for clean output', () => {
    expect(extractErrorSignatures('Tests: 857 passed, 0 failed\nDone in 3.2s')).toEqual([]);
    expect(extractErrorSignatures('')).toEqual([]);
  });

  it('normalizes quoted identifiers so the same error class merges', () => {
    const a = extractErrorSignatures(`TypeError: Cannot read properties of undefined (reading 'aaa')`)[0];
    const b = extractErrorSignatures(`TypeError: Cannot read properties of undefined (reading 'bbb')`)[0];
    expect(a).toBe(b);
  });
});

describe('FailureRegistry — cross-turn recurrence', () => {
  it('nudges only once the same failure recurs threshold times', () => {
    const r = new FailureRegistry();
    r.trackTurn(`error TS2304: Cannot find name 'x'`);
    expect(r.nudge()).toBeNull();
    r.trackTurn(`error TS2304: Cannot find name 'y'`); // same TS code, different name
    expect(r.nudge()).toBeNull();
    r.trackTurn(`error TS2304: Cannot find name 'z'`);
    const n = r.nudge();
    expect(n).toBeTruthy();
    expect(n).toContain('TS2304');
    expect(n).toContain('3×');
    expect(r.repeated()).toEqual([{ signature: 'TS2304', count: 3 }]);
  });

  it('does NOT nudge when failures differ each turn', () => {
    const r = new FailureRegistry();
    r.trackTurn(`Cannot find module 'a'`);
    r.trackTurn(`Cannot find module 'b'`);
    r.trackTurn(`Cannot find module 'c'`);
    expect(r.nudge()).toBeNull();
    expect(r.repeated()).toEqual([]);
  });

  it('counts each signature at most once per turn', () => {
    const r = new FailureRegistry();
    // same error twice in ONE turn = one count
    r.trackTurn(`error TS1005\nerror TS1005`);
    expect(r.repeated(1)).toEqual([{ signature: 'TS1005', count: 1 }]);
  });

  it('reset clears the history', () => {
    const r = new FailureRegistry();
    r.trackTurn('FAIL a'); r.trackTurn('FAIL a'); r.trackTurn('FAIL a');
    expect(r.nudge()).toBeTruthy();
    r.reset();
    expect(r.nudge()).toBeNull();
    expect(r.repeated(1)).toEqual([]);
  });
});

describe('failure-registry wiring — source locked', () => {
  it('shell instantiates + resets the registry and feeds real turn output', () => {
    expect(SHELL).toMatch(/private failureRegistry = new FailureRegistry\(\)/);
    expect(SHELL).toMatch(/this\.failureRegistry\.reset\(\)/);
    expect(SHELL).toMatch(/this\.failureRegistry\.trackTurn\(combinedTurnOutput\)/);
    // the governor now sees the real combined output too (was an empty buffer)
    expect(SHELL).toMatch(/detectFailingTestOrBuild\(combinedTurnOutput\)/);
  });
  it('shell prepends the recurrence nudge to the auto-continue prompt', () => {
    expect(SHELL).toMatch(/const failureNudge = this\.failureRegistry\.nudge\(\)/);
    expect(SHELL).toMatch(/failureNudge\s*\n?\s*\?/);
  });
});
