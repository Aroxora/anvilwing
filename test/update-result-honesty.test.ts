/**
 * updateAndContinue must not return a self-contradicting result. Its restart
 * catch used to return `{ success: true, error: 'Update successful but restart
 * failed: …' }` — success and a populated error at once (audit "exit0-failed").
 * The update itself succeeded; only the auto-restart spawn failed (already
 * surfaced via a logged warning), so the honest result is
 * `{ success: true, restarting: false }`.
 *
 * Source assertion (the behavioural path is impractical to run for real here:
 * exercising the catch needs performUpdate to run a real `npm i -g` and then the
 * restart spawn to throw — we will not run a real global install in CI). The
 * contradiction is a pure property of the return literal, well-suited to a
 * source guard. Fail-before: the old `success: true, error:` literal matched;
 * pass-after: it is gone.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(__dirname, '..', 'src', 'core', 'updateChecker.ts'), 'utf8');

describe('updateChecker result honesty (audit exit0-failed)', () => {
  test('no return reports success:true together with a populated error', () => {
    expect(src).not.toMatch(/success:\s*true\s*,\s*error:/);
  });

  test('the restart-failure path reports success with restarting:false', () => {
    expect(src).toContain('return { success: true, restarting: false };');
  });

  test('genuine update failure still reports success:false with the error', () => {
    // The honest failure path (performUpdate failed) is unchanged.
    expect(src).toContain('return { success: false, error: updateResult.error };');
  });
});
