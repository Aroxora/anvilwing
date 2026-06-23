/**
 * isFallbackEligibleError + getFallbackReason are the provider-fallback decision
 * gates: they decide whether an error means "give up on this provider and try the
 * next" vs "retry the same one". They are exported, pure, retry-critical, and were
 * untested. This locks their behaviour and guards the 1.1.7 regression where a
 * provider error with a NUMERIC `.status` crashed the first prompt of a session
 * (`(...).toLowerCase is not a function`) — the String() coercion at lines 159-162.
 */

import { isFallbackEligibleError, getFallbackReason } from '../../src/providers/resilientProvider.js';

function errWith(message: string, extra?: Record<string, unknown>): Error {
  const e = new Error(message);
  if (extra) Object.assign(e, extra);
  return e;
}

describe('isFallbackEligibleError — message patterns', () => {
  test.each([
    'insufficient_quota',
    'You have exceeded your current quota',
    'billing hard limit reached',
    'account suspended',
    'api key expired',
    'invalid_api_key',
    'invalid api key',
    'model not found',
    'this model does not exist',
    'model is deprecated',
    'access denied',
    'unauthorized',
    'HTTP 401',
    'returned 403',
    'status 400 invalid_argument',
    'not supported in your country',
    'this region is restricted',
  ])('eligible: %s', (msg) => {
    expect(isFallbackEligibleError(errWith(msg))).toBe(true);
  });

  test.each([
    'something went wrong',
    'temporary blip, please retry',
    'connection reset by peer', // transient → retry same provider, NOT fallback
    'rate limit exceeded',      // rate-limited → retry same provider, NOT fallback
  ])('not eligible: %s', (msg) => {
    expect(isFallbackEligibleError(errWith(msg))).toBe(false);
  });
});

describe('isFallbackEligibleError — structured (OpenAI/Google-style) fields', () => {
  it('matches string code/type/reason/status fields', () => {
    expect(isFallbackEligibleError(errWith('x', { code: 'insufficient_quota' }))).toBe(true);
    expect(isFallbackEligibleError(errWith('x', { type: 'model_not_found' }))).toBe(true);
    expect(isFallbackEligibleError(errWith('x', { code: 'invalid_api_key' }))).toBe(true);
    expect(isFallbackEligibleError(errWith('x', { reason: 'API_KEY_INVALID' }))).toBe(true);
    expect(isFallbackEligibleError(errWith('x', { status: 'INVALID_ARGUMENT' }))).toBe(true);
    expect(isFallbackEligibleError(errWith('x', { code: '403' }))).toBe(true);
  });

  it('1.1.7 regression: a NUMERIC status/code is coerced, never throws', () => {
    // The historical crash: `error.status` was a number and `.toLowerCase()` threw.
    expect(() => isFallbackEligibleError(errWith('boom', { status: 500 }))).not.toThrow();
    expect(() => isFallbackEligibleError(errWith('boom', { code: 429 }))).not.toThrow();
    // numeric code 401/403 still classifies as eligible after String() coercion
    expect(isFallbackEligibleError(errWith('boom', { code: 401 }))).toBe(true);
    expect(isFallbackEligibleError(errWith('boom', { code: 403 }))).toBe(true);
    // numeric status alone (no matching code) → not eligible, but must not crash
    expect(isFallbackEligibleError(errWith('boom', { status: 400 }))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isFallbackEligibleError('insufficient_quota')).toBe(false);
    expect(isFallbackEligibleError(null)).toBe(false);
    expect(isFallbackEligibleError(undefined)).toBe(false);
    expect(isFallbackEligibleError({ message: 'quota exceeded' })).toBe(false);
  });
});

describe('getFallbackReason — human-readable mapping (first match wins)', () => {
  test.each([
    ['quota exceeded for this month', 'API quota exceeded or billing issue'],
    ['billing account problem', 'API quota exceeded or billing issue'],
    ['your api key expired yesterday', 'API key expired or invalid'],
    ['model gpt-x not found', 'Model not available'],
    ['request was unauthorized', 'Invalid API key'],
    ['error 403 forbidden', 'Access denied'],
    ['invalid_argument in request', 'Invalid request or API key'],
    ['this country is not allowed', 'Regional restriction'],
    ['totally generic failure', 'Provider error'],
  ])('%s -> %s', (msg, reason) => {
    expect(getFallbackReason(errWith(msg))).toBe(reason);
  });

  it('returns "Unknown error" for non-Error values', () => {
    expect(getFallbackReason(42)).toBe('Unknown error');
    expect(getFallbackReason(null)).toBe('Unknown error');
  });
});
