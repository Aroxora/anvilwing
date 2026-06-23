/**
 * v1.4 hardening pass: graceful quota / balance exhaustion handling for
 * Tavily (web search) and Anvilwing (LLM provider).
 *
 * Contract — when either external service runs out of free-tier or paid
 * balance, the user sees a SINGLE recognizable message that explains the
 * remediation (wait for monthly reset, or top up), NOT a raw HTTP code.
 *
 * Per CLAUDE.md "Test discipline for security and bug fixes": every block
 * here ships with both a behavioural assertion (drive the code path with
 * a faked failure) AND a source-string assertion (so a future refactor
 * that quietly drops the rewrite gets caught at CI time).
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  TAVILY_QUOTA_MESSAGE,
  ANVILWING_QUOTA_MESSAGE,
  isTavilyQuotaResponse,
  isAnvilwingQuotaError,
  buildAnvilwingQuotaError,
} from '../src/core/quotaErrors.js';

const repoRoot = resolve(__dirname, '..');
const quotaSrc = readFileSync(join(repoRoot, 'src', 'core', 'quotaErrors.ts'), 'utf8');
const webToolsSrc = readFileSync(join(repoRoot, 'src', 'tools', 'webTools.ts'), 'utf8');
const dsPluginSrc = readFileSync(
  join(repoRoot, 'src', 'plugins', 'providers', 'anvilwing', 'index.ts'),
  'utf8',
);

describe('Tavily quota detection — monthly cap surfaces as a clear message (#quota-tavily)', () => {
  test.each([
    [432, '', 'usage cap status'],
    [433, '', 'plan paused status'],
    [402, '', 'payment required status'],
    [429, '', 'rate limit status'],
    [400, 'You have hit your monthly limit', 'message-only fallback'],
    [500, 'usage_limit_exceeded for plan free', 'body-only signal'],
  ])('isTavilyQuotaResponse(%s, %j) is true (%s)', (status, body, _label) => {
    expect(isTavilyQuotaResponse(status as number, body as string)).toBe(true);
  });

  test.each([
    [200, ''],
    [404, ''],
    [500, 'internal server error'],
    [401, 'invalid api key'],
  ])('isTavilyQuotaResponse(%s, %j) is false (non-quota)', (status, body) => {
    expect(isTavilyQuotaResponse(status as number, body as string)).toBe(false);
  });

  test('TAVILY_QUOTA_MESSAGE explains both remediations (monthly reset AND top-up)', () => {
    expect(TAVILY_QUOTA_MESSAGE).toMatch(/monthly free-tier quota is exhausted/);
    expect(TAVILY_QUOTA_MESSAGE).toMatch(/re-enables on the 1st of next month/);
    expect(TAVILY_QUOTA_MESSAGE).toMatch(/top up/i);
    expect(TAVILY_QUOTA_MESSAGE).toMatch(/\/key tvly-/); // the real command (was the removed /secrets)
  });

  // Source guard: webTools.ts MUST call isTavilyQuotaResponse (or
  // return TAVILY_QUOTA_MESSAGE) on the Tavily HTTP paths, or a quota
  // response will leak through as "Tavily API error: 432" again.
  test('webTools.ts wires the quota check into the Tavily HTTP paths', () => {
    expect(webToolsSrc).toMatch(/isTavilyQuotaResponse|TAVILY_QUOTA_MESSAGE/);
  });
});

describe('Anvilwing quota detection — Insufficient Balance surfaces as a clear message (#quota-anvilwing)', () => {
  test('402 status on an SDK-shaped error trips the detector', () => {
    const err = Object.assign(new Error('Request failed with status code 402'), { status: 402 });
    expect(isAnvilwingQuotaError(err)).toBe(true);
  });

  test.each([
    'Insufficient Balance',
    'insufficient_balance',
    'Your balance is not enough',
    'HTTP 402: Insufficient Balance',
    'Payment Required',
  ])('message %j trips the detector', (msg) => {
    expect(isAnvilwingQuotaError(new Error(msg))).toBe(true);
  });

  test.each([
    'rate limit exceeded',
    'invalid api key',
    'network error',
    '',
  ])('non-quota message %j does NOT trip the detector', (msg) => {
    expect(isAnvilwingQuotaError(new Error(msg))).toBe(false);
  });

  test('non-Error values do not crash the detector', () => {
    expect(isAnvilwingQuotaError(null)).toBe(false);
    expect(isAnvilwingQuotaError(undefined)).toBe(false);
    expect(isAnvilwingQuotaError({ status: 402 })).toBe(false); // not an Error instance
    expect(isAnvilwingQuotaError('Insufficient Balance')).toBe(false);
  });

  test('ANVILWING_QUOTA_MESSAGE explains both remediations (top up; or set a different key)', () => {
    expect(ANVILWING_QUOTA_MESSAGE).toMatch(/account balance is exhausted/);
    expect(ANVILWING_QUOTA_MESSAGE).toMatch(/Top up/i);
    expect(ANVILWING_QUOTA_MESSAGE).toMatch(/does not auto-reset/i);
    expect(ANVILWING_QUOTA_MESSAGE).toMatch(/\/key sk-/); // the real command (was the removed /secrets)
  });

  test('buildAnvilwingQuotaError tags the Error so retry layers can skip it', () => {
    const err = buildAnvilwingQuotaError() as Error & { isQuotaExhausted?: boolean; provider?: string };
    expect(err.message).toBe(ANVILWING_QUOTA_MESSAGE);
    expect(err.isQuotaExhausted).toBe(true);
    expect(err.provider).toBe('anvilwing');
  });

  // Source guard: the anvilwing plugin MUST translate a 402 / Insufficient
  // Balance into the friendly message — otherwise users see the raw
  // OpenAI SDK error and the rewrite is a placebo.
  test('anvilwing plugin wires the quota translation', () => {
    expect(dsPluginSrc).toMatch(/isAnvilwingQuotaError|buildAnvilwingQuotaError/);
  });

  // The retry / circuit-breaker layer must NOT retry quota errors (they
  // never become success without external action). The plugin tags the
  // rewritten error; the layer reads the tag.
  test('quotaErrors.ts marks the error non-retryable via isQuotaExhausted', () => {
    expect(quotaSrc).toMatch(/isQuotaExhausted\?\s*:\s*boolean/);
  });
});

describe('Integration — Tavily HTTP failure path returns the quota message verbatim', () => {
  // Drives the REAL webTools handler with a stubbed fetch to confirm the
  // user-visible string at the WebSearch tool boundary is exactly the
  // quota message, not a raw status code.
  test('searchTavily 432 response returns TAVILY_QUOTA_MESSAGE', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init: unknown) => {
      return new Response('Your monthly usage limit has been reached', {
        status: 432,
        headers: { 'Content-Type': 'text/plain' },
      });
    }) as typeof globalThis.fetch;

    try {
      const mod = await import('../src/tools/webTools.js');
      const tools = mod.createWebTools();
      const webSearch = tools.find((t) => t.name === 'WebSearch');
      expect(webSearch).toBeTruthy();
      // Use the no-local-key path is unreliable for this test (proxy URL hit), so
      // we set a fake key so searchTavily() is exercised.
      process.env['TAVILY_API_KEY'] = 'tvly-test';
      const { setSecretValue } = await import('../src/core/secretStore.js');
      setSecretValue('TAVILY_API_KEY', 'tvly-test');
      const out = await webSearch!.handler({ query: 'ping' }, {} as never);
      expect(typeof out).toBe('string');
      expect(out as string).toContain('Tavily monthly free-tier quota is exhausted');
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env['TAVILY_API_KEY'];
    }
  });
});
