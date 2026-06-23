/**
 * Hardening test for the resilient-provider error classifier.
 *
 * Bug shipped in 1.1.7: the classifier did `(error.status ?? '').toLowerCase()`
 * on a numeric `.status` (HTTP code), which crashed every fallback-eligible
 * error path with "(...).toLowerCase is not a function". The submit flow
 * died on the first prompt of a fresh session.
 *
 * The classifier is now hardened with `String(...)` coercion on every
 * lookup; this test pins that behaviour so a future "clean it up to
 * native types" PR can't regress.
 */

import { isFallbackEligibleError } from '../src/providers/resilientProvider.js';

describe('isFallbackEligibleError — type-safety hardening', () => {
  test('numeric .status does not crash (1.1.7 regression)', () => {
    // The shape that crashed: a fetch-style error with an HTTP-numeric
    // status. The classifier must coerce, not throw.
    const err = Object.assign(new Error('upstream'), { status: 502 });
    expect(() => isFallbackEligibleError(err)).not.toThrow();
  });

  test('numeric .code does not crash', () => {
    const err = Object.assign(new Error('upstream'), { code: 429 });
    expect(() => isFallbackEligibleError(err)).not.toThrow();
  });

  test('object-shaped .type / .reason do not crash', () => {
    const err = Object.assign(new Error('weird'), { type: { kind: 'rate' }, reason: { detail: 'x' } });
    expect(() => isFallbackEligibleError(err)).not.toThrow();
  });

  test('null / undefined values are safe', () => {
    expect(() => isFallbackEligibleError(Object.assign(new Error('e'), { status: null, code: undefined }))).not.toThrow();
    expect(() => isFallbackEligibleError(null)).not.toThrow();
    expect(() => isFallbackEligibleError(undefined)).not.toThrow();
  });

  test('still classifies real fallback-eligible errors correctly', () => {
    // Documented OpenAI-style insufficient_quota — must continue to
    // be detected after the String() coercion change.
    const quotaErr = Object.assign(new Error('quota'), { code: 'insufficient_quota' });
    expect(isFallbackEligibleError(quotaErr)).toBe(true);

    const apiKeyErr = Object.assign(new Error('bad key'), { code: 'invalid_api_key' });
    expect(isFallbackEligibleError(apiKeyErr)).toBe(true);
  });
});
