/**
 * Characterization tests for the canonical error-classification module (audit
 * Rank 5, Phase 1). The expected values below were captured from the
 * PRE-extraction code (baseProvider + resilientProvider) via a live probe, so
 * this suite proves the extraction is behaviour-PRESERVING: any drift in a
 * pattern or predicate turns a case red.
 *
 * It also pins the deliberate DIVERGENCE between the two sites (base has no
 * enotfound/ssl; the resilient set does) — the reason they must NOT be merged
 * into a superset — and the re-export identity (the providers' public names
 * are the very functions from the canonical module).
 */

import {
  isBaseTransientError,
  isBaseRateLimitError,
  isAuthError,
  isResilientTransientError,
  isResilientRateLimitError,
  shouldRetryResilient,
  isFallbackEligibleError,
  getFallbackReason,
  isContextOverflowError,
  isAgentTransientError,
} from '../src/core/errorClassification';
import * as base from '../src/providers/baseProvider';
import * as resilient from '../src/providers/resilientProvider';

const E = (msg: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(msg), extra);

describe('baseProvider classifiers (verbatim, kept distinct from resilient)', () => {
  test.each([
    ['socket hang up', true, false, false],
    ['ECONNRESET happened', true, false, false],
    ['HTTP 503 bad', true, false, false],
    ['overloaded', true, false, false],
    ['enotfound dns', false, false, false], // DIVERGENCE: base has no enotfound
    ['ssl handshake failed', false, false, false], // DIVERGENCE: base has no ssl
    ['rate limit exceeded', false, true, false],
    ['too many requests', false, true, false],
    ['throttled', false, false, false], // base rate-limit only checks rate/429
    ['unauthorized', false, false, true],
    ['invalid api key', false, false, true],
    ['random thing', false, false, false],
  ])('%s → transient/rateLimit/auth', (msg, t, r, a) => {
    const e = E(msg as string);
    expect(isBaseTransientError(e)).toBe(t);
    expect(isBaseRateLimitError(e)).toBe(r);
    expect(isAuthError(e)).toBe(a);
  });

  test('status codes: 429 → rate limit; 401/403 → auth', () => {
    expect(isBaseRateLimitError(E('', { status: 429 }))).toBe(true);
    expect(isAuthError(E('', { status: 401 }))).toBe(true);
    expect(isAuthError(E('', { status: 403 }))).toBe(true);
  });

  test('non-Error input is never classified', () => {
    expect(isBaseTransientError('socket')).toBe(false);
    expect(isBaseRateLimitError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe('resilient transient/rate-limit predicates (verbatim)', () => {
  test.each([
    'enotfound dns', 'ssl handshake failed', 'econnreset', 'tls certificate',
    'gateway timeout', 'premature close', 'zlib error',
  ])('%s → resilient transient true (superset of base)', (msg) => {
    expect(isResilientTransientError(E(msg))).toBe(true);
  });

  test('cause-chain walk: a nested transient cause is transient', () => {
    expect(isResilientTransientError(E('outer', { cause: E('econnreset inner') }))).toBe(true);
    expect(isResilientTransientError(E('outer', { cause: E('totally unrelated') }))).toBe(false);
  });

  test('error name check (FetchError/AbortError) → transient', () => {
    const fetchErr = E('boom'); fetchErr.name = 'FetchError';
    expect(isResilientTransientError(fetchErr)).toBe(true);
  });

  test.each(['rate limit', 'throttled', 'capacity issue', 'overloaded', 'quota exceeded'])(
    '%s → resilient rate limit true',
    (msg) => { expect(isResilientRateLimitError(E(msg))).toBe(true); },
  );

  test('shouldRetryResilient = rateLimit OR transient', () => {
    expect(shouldRetryResilient(E('econnreset'))).toBe(true);
    expect(shouldRetryResilient(E('throttled'))).toBe(true);
    expect(shouldRetryResilient(E('totally unrelated'))).toBe(false);
  });

  test('shouldRetryResilient does NOT retry fallback-eligible errors — they short-circuit to fallback', () => {
    // Quota/billing/auth/model errors won't be fixed by retrying the same
    // provider; retrying just burns minutes of backoff before fallback.
    expect(shouldRetryResilient(E('quota exceeded'))).toBe(false);
    expect(shouldRetryResilient(E('insufficient_quota'))).toBe(false);
    expect(shouldRetryResilient(E('invalid api key'))).toBe(false);
    expect(shouldRetryResilient(E('billing'))).toBe(false);
    expect(shouldRetryResilient(E('model_not_found'))).toBe(false);
    // Genuine transient / rate-limit still retries.
    expect(shouldRetryResilient(E('throttled'))).toBe(true);
    expect(shouldRetryResilient(E('econnreset'))).toBe(true);
    expect(shouldRetryResilient(E('503 service unavailable'))).toBe(true);
  });
});

describe('isFallbackEligibleError / getFallbackReason (verbatim, incl. String() coercion)', () => {
  test.each([
    ['unauthorized', true, 'Invalid API key'],
    ['invalid api key', true, 'API key expired or invalid'],
    ['insufficient_quota', true, 'API quota exceeded or billing issue'],
    ['model not found', true, 'Model not available'],
    ['region restricted', true, 'Regional restriction'],
    ['random thing', false, 'Provider error'],
  ])('%s → eligible=%s reason=%s', (msg, eligible, reason) => {
    const e = E(msg as string);
    expect(isFallbackEligibleError(e)).toBe(eligible);
    expect(getFallbackReason(e)).toBe(reason);
  });

  test('structured fields: code/type matched; a bare numeric .status is NOT', () => {
    expect(isFallbackEligibleError(E('x', { code: 'model_not_found' }))).toBe(true);
    expect(isFallbackEligibleError(E('x', { type: 'insufficient_quota' }))).toBe(true);
    // The 1.1.7 guard: a numeric status must not crash, and bare 401/403/429
    // (no matching message) is not fallback-eligible (status isn't the 400/401/403 check).
    expect(isFallbackEligibleError(E('', { status: 429 }))).toBe(false);
    expect(isFallbackEligibleError(E('', { status: 401 }))).toBe(false);
    expect(isFallbackEligibleError(E('', { status: 403 }))).toBe(false);
  });

  test('non-Error input is never fallback-eligible', () => {
    expect(isFallbackEligibleError(null)).toBe(false);
    expect(getFallbackReason(null)).toBe('Unknown error');
  });
});

describe('agent classifiers (verbatim — a third, fold-everything-into-transient semantics)', () => {
  test.each([
    ['context length exceeded', true],
    ['token limit reached', true], // token && limit
    ['maximum tokens', true], // token && maximum
    ['context window full', true],
    ['max_tokens', true],
    ['too many tokens', true],
    ['token alone', false], // token without limit/exceed/maximum
    ['random', false],
  ])('isContextOverflowError(%s) === %s', (msg, expected) => {
    expect(isContextOverflowError(new Error(msg as string))).toBe(expected);
  });

  test.each([
    'econnreset', 'etimedout', 'enotfound', 'fetch failed', 'rate limit', '429',
    '500', '503', 'service unavailable', 'overloaded', 'server error', 'temporarily unavailable',
  ])('isAgentTransientError(%s) → true (rate-limit + 5xx folded in)', (msg) => {
    expect(isAgentTransientError(new Error(msg))).toBe(true);
  });

  test('agent transient does NOT include ssl/tls (divergence from resilient)', () => {
    expect(isAgentTransientError(new Error('ssl handshake'))).toBe(false);
    expect(isResilientTransientError(new Error('ssl handshake'))).toBe(true);
  });

  test('non-Error input is never classified', () => {
    expect(isContextOverflowError('context length')).toBe(false);
    expect(isAgentTransientError(null)).toBe(false);
  });
});

describe('re-export identity: providers expose the canonical functions', () => {
  test('baseProvider re-exports are the same function objects', () => {
    expect(base.isTransientError).toBe(isBaseTransientError);
    expect(base.isRateLimitError).toBe(isBaseRateLimitError);
    expect(base.isAuthError).toBe(isAuthError);
  });

  test('resilientProvider re-exports are the same function objects', () => {
    expect(resilient.isFallbackEligibleError).toBe(isFallbackEligibleError);
    expect(resilient.getFallbackReason).toBe(getFallbackReason);
  });
});
