/**
 * baseProvider's error classifiers (isTransientError / isRateLimitError /
 * isAuthError) and withRetry decide whether a failed model call is retried,
 * rate-limit-backed-off, or surfaced. They were exported but untested.
 *
 * Scope note (honest, per the audit): src/providers/baseProvider.ts is exported
 * but not imported by production today — the anvilwing `baseProvider` reference
 * is a local variable, not this module. So this is a contract/coverage pin
 * (lock behaviour before any future consolidation moves it), NOT a live-bug fix.
 */

import {
  isTransientError,
  isRateLimitError,
  isAuthError,
  withRetry,
  TRANSIENT_ERROR_PATTERNS,
} from '../../src/providers/baseProvider.js';

function errWith(message: string, extra?: { status?: number; code?: string; name?: string }): Error {
  const e = new Error(message);
  if (extra?.status !== undefined) (e as { status?: number }).status = extra.status;
  if (extra?.code !== undefined) (e as { code?: string }).code = extra.code;
  if (extra?.name !== undefined) e.name = extra.name;
  return e;
}

describe('isTransientError', () => {
  test.each([
    ['econnreset', true],
    ['ECONNRESET', true], // case-insensitive
    ['socket hang up', true],
    ['premature close', true],
    ['aborted', true],
    ['network error', true],
    ['request timeout', true],
    ['502 bad gateway', true],
    ['503 service unavailable', true],
    ['overloaded', true],
    ['internal error', false], // no numeric/transient token
    ['validation failed', false],
  ])('classifies %s -> %s', (msg, expected) => {
    expect(isTransientError(errWith(msg))).toBe(expected);
  });

  it('matches on the error code/name fields, not just the message', () => {
    expect(isTransientError(errWith('boom', { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientError(errWith('boom', { name: 'FetchError' }))).toBe(true);
  });

  it('returns false for non-Error values', () => {
    expect(isTransientError('econnreset')).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });

  it('every advertised transient pattern actually classifies as transient', () => {
    for (const pattern of TRANSIENT_ERROR_PATTERNS) {
      expect(isTransientError(errWith(`prefix ${pattern} suffix`))).toBe(true);
    }
  });
});

describe('isRateLimitError', () => {
  test.each([
    [errWith('rate limit exceeded'), true],
    [errWith('rate_limit hit'), true],
    [errWith('too many requests'), true],
    [errWith('429 Too Many Requests'), true],
    [errWith('boom', { status: 429 }), true],
    [errWith('internal server error', { status: 500 }), false],
    [errWith('bad request', { status: 400 }), false],
  ])('classifies correctly (#%#)', (err, expected) => {
    expect(isRateLimitError(err)).toBe(expected);
  });
});

describe('isAuthError', () => {
  test.each([
    [errWith('boom', { status: 401 }), true],
    [errWith('boom', { status: 403 }), true],
    [errWith('unauthorized'), true],
    [errWith('invalid api key'), true],
    [errWith('authentication required'), true],
    [errWith('boom', { status: 500 }), false],
    [errWith('socket hang up'), false],
  ])('classifies correctly (#%#)', (err, expected) => {
    expect(isAuthError(err)).toBe(expected);
  });
});

describe('withRetry', () => {
  const fast = { initialDelayMs: 1, maxDelayMs: 2, maxRetries: 3, backoffMultiplier: 2 };

  it('retries a transient failure then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts++;
        if (attempts < 2) throw errWith('socket hang up');
        return Promise.resolve('ok');
      },
      { config: fast }
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('does NOT retry an auth error — fails fast on the first attempt', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          return Promise.reject(errWith('unauthorized', { status: 401 }));
        },
        { config: fast }
      )
    ).rejects.toThrow(/unauthorized/);
    expect(attempts).toBe(1);
  });

  it('gives up after maxRetries on a persistent transient failure', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          return Promise.reject(errWith('econnreset'));
        },
        { config: fast }
      )
    ).rejects.toThrow(/econnreset/);
    expect(attempts).toBe(fast.maxRetries + 1); // initial try + maxRetries
  });

  it('does not retry a non-transient error', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          return Promise.reject(errWith('validation failed'));
        },
        { config: fast }
      )
    ).rejects.toThrow(/validation failed/);
    expect(attempts).toBe(1);
  });
});
