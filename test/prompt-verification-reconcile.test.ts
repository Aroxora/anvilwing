/**
 * F5: the system prompt used to contradict itself on verification. The template
 * (agent-schemas.json) says "verify ONCE … never announce another check", while
 * the CRITICAL-severity core.test_until_green rule said "ALWAYS run the relevant
 * test/build … Loop until exit code 0" — and the CRITICAL flag out-ranks the
 * unflagged template line, re-licensing the exact "let me double-check" hedging
 * the template bans (and feeding the F3 over-verify loop).
 *
 * config.ts assembles the prompt via import.meta (not jest-importable — see the
 * testing-runtime convention), so we pin the reconciliation at the contract level:
 * a regression that re-introduces the unconditional "ALWAYS run" trigger, or
 * removes the red-loop teeth / the pass-stop, fails CI.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(resolve(REPO, ...p), 'utf8');

const RULES = JSON.parse(read('agents', 'anvilwing-code.rules.json'));
const SCHEMAS_SRC = read('src', 'contracts', 'agent-schemas.json');

const findRule = (id: string): { summary: string; severity?: string } | undefined => {
  const all = JSON.stringify(RULES);
  const re = new RegExp(`"id":"${id.replace('.', '\\.')}","summary":"((?:[^"\\\\]|\\\\.)*)"`);
  const m = all.match(re);
  return m ? { summary: JSON.parse(`"${m[1]}"`) } : undefined;
};

describe('core.test_until_green: conditional trigger, teeth kept', () => {
  const rule = findRule('core.test_until_green');

  it('exists', () => {
    expect(rule).toBeDefined();
  });

  it('drops the unconditional "ALWAYS run" trigger that contradicted the template', () => {
    expect(rule!.summary).not.toMatch(/ALWAYS run the relevant test\/build/i);
  });

  it('keeps the red-loop teeth (loop until green while a relevant check is red)', () => {
    expect(rule!.summary).toMatch(/if it FAILS/i);
    expect(rule!.summary).toMatch(/loop until exit code 0/i);
    expect(rule!.summary).toMatch(/never declare done while a relevant (test|build)/i);
  });

  it('adds the pass-stop: a passing check (or no relevant check) means stop, do not re-run', () => {
    expect(rule!.summary).toMatch(/if it PASSES, or no relevant check exists/i);
    expect(rule!.summary).toMatch(/do NOT run or re-read/i);
  });
});

describe('rule.final_check: no ritual full build/test fallback', () => {
  const rule = findRule('rule.final_check');

  it('runs the check that exercises THIS change, not a bare npm run build && npm test', () => {
    expect(rule).toBeDefined();
    expect(rule!.summary).not.toMatch(/npm run build && npm test/);
    expect(rule!.summary).toMatch(/exercises THIS change|validate_all_changes/i);
  });
});

describe('template: obstacles-as-signal disposition (reflection baked into the agent DNA)', () => {
  it('teaches that a blocker is signal that can point to a better approach', () => {
    expect(SCHEMAS_SRC).toMatch(/Treat obstacles as signal/);
    expect(SCHEMAS_SRC).toMatch(/points to a simpler or more robust approach|better design/i);
  });

  it('is proactive — applied on the agent\'s own initiative, not only when asked', () => {
    expect(SCHEMAS_SRC).toMatch(/on your own initiative, without being asked/);
  });

  it('reconciles with the no-slop rule: act on it, never narrate it (minimal spam)', () => {
    expect(SCHEMAS_SRC).toMatch(/Act on the reframing; do not perform it/);
    expect(SCHEMAS_SRC).toMatch(/Never add motivational commentary/);
    expect(SCHEMAS_SRC).toMatch(/stay silent about it/);
  });
});

describe('template: positive stop rule for exact-match demands', () => {
  it('teaches that ONE deterministic comparison is decisive for equality checks', () => {
    expect(SCHEMAS_SRC).toMatch(/byte-identical check, the proof is ONE deterministic comparison/);
    expect(SCHEMAS_SRC).toMatch(/cmp -s|grep -Fxq|sha256sum/);
  });

  it('still bans the re-announce-another-check hedging it always banned', () => {
    expect(SCHEMAS_SRC).toMatch(/never announce another check/);
  });
});
