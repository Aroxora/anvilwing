/**
 * InputProtection.checkUnicodeAnomalys must strip EVERY occurrence of a unicode
 * anomaly (RTL override, zero-width chars), not just the first.
 *
 * The bug: the RegExp-pattern branch reused the shared `anomaly.pattern` object
 * directly. A `/g` RegExp's `.test()` advances `lastIndex` (stateful), so on a
 * later call `.test()` could start mid-string and miss a match — leaking
 * anomalies that should have been removed. The fix builds a FRESH `RegExp` per
 * call (forcing the `g` flag so `.replace` strips all occurrences), so there's
 * no `lastIndex` carried across calls.
 *
 * Behavioural (real InputProtection, no mock) + a source guard so a refactor
 * can't reintroduce the shared-stateful-regex pattern.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InputProtection } from '../src/core/inputProtection';

const RTL = '‮';   // right-to-left override
const ZWSP = '​';  // zero-width space

describe('unicode-anomaly stripping removes ALL occurrences', () => {
  test('validateInput strips every RTL override, not just the first', () => {
    const res = new InputProtection().validateInput(`a${RTL}b${RTL}c`);
    expect(res.sanitized.includes(RTL)).toBe(false);
    expect((res.sanitized.match(new RegExp(RTL, 'g')) || []).length).toBe(0);
  });

  test('validateInput strips every zero-width char', () => {
    const res = new InputProtection().validateInput(`x${ZWSP}y${ZWSP}z`);
    expect(res.sanitized.includes(ZWSP)).toBe(false);
  });

  test('validatePromptSubmission also strips repeated RTL overrides', () => {
    const res = new InputProtection().validatePromptSubmission(`a${RTL}b${RTL}c`);
    expect((res.sanitized.match(new RegExp(RTL, 'g')) || []).length).toBe(0);
  });

  test('repeated calls stay consistent (no leaked lastIndex state across calls)', () => {
    const ip = new InputProtection();
    // The stateful-/g bug surfaced as alternating results across calls on the
    // SAME instance; every call must fully strip.
    for (let i = 0; i < 5; i++) {
      expect(ip.validateInput(`a${RTL}b${RTL}c`).sanitized.includes(RTL)).toBe(false);
    }
  });

  test('source: a fresh RegExp is built per call (no shared stateful pattern)', () => {
    const src = readFileSync(resolve(__dirname, '..', 'src', 'core', 'inputProtection.ts'), 'utf8');
    expect(src).toMatch(/new RegExp\(anomaly\.pattern\.source/);
    // The old shared-object reuse (": anomaly.pattern;") must be gone.
    expect(src).not.toMatch(/:\s*anomaly\.pattern;/);
  });
});
