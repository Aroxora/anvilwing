/**
 * Two audit fixes, source-guarded (deterministic, CI):
 *  - the BYO-key Tavily search used a 24-hour abort timer while claiming a 30s
 *    timeout — the agent could hang indefinitely. Now 30s, matching the message.
 *  - the quota error messages pointed users at `/secrets set …`, a command that
 *    was removed, and asserted a stale "75% promo period" billing fact. Now they
 *    point at the real /key command and drop the time-sensitive claim.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

test('Tavily search uses a 30s timeout, not a 24-hour one', () => {
  const web = read('src/tools/webTools.ts');
  expect(web).not.toMatch(/24 \* 60 \* 60/);
});

test('quota messages point at the real /key command, not the removed /secrets', () => {
  const q = read('src/core/quotaErrors.ts');
  expect(q).not.toMatch(/\/secrets/);
  expect(q).toMatch(/\/key sk-/);
  expect(q).toMatch(/\/key tvly-/);
});

test('the Anvilwing quota message dropped the stale time-sensitive promo claim', () => {
  expect(read('src/core/quotaErrors.ts')).not.toMatch(/promo period/i);
});
