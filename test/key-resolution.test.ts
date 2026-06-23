/**
 * Bring-your-own-key resolution (replaces the removed hosted-auth subsystem).
 * Locks the key-source resolution (your own Anvilwing key vs none), the
 * welcome/banner line, and the provider endpoint. Deterministic, no network.
 *
 * IMPORTANT: no real API key appears here — Anvilwing forbids baking keys into
 * the repo.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveKeyMode, keyModeLine, resolveAnvilwingEndpoint,
} from '../src/core/keyResolution';

const SAVED = { ...process.env };

beforeEach(() => {
  delete process.env['ANVILWING_API_KEY'];
  delete process.env['TAVILY_API_KEY'];
});
afterEach(() => {
  for (const k of ['ANVILWING_API_KEY', 'TAVILY_API_KEY']) {
    if (k in SAVED) process.env[k] = SAVED[k]!; else delete process.env[k];
  }
});

describe('resolveKeyMode — own vs none', () => {
  test('none — no key set', () => {
    const s = resolveKeyMode();
    expect(s.mode).toBe('none');
    expect(s.ownAnvilwing).toBe(false);
    expect(keyModeLine(s)).toBeNull();
  });

  test('own — user has a Anvilwing key', () => {
    process.env['ANVILWING_API_KEY'] = 'sk-fake-own';
    const s = resolveKeyMode();
    expect(s.mode).toBe('own');
    expect(s.ownAnvilwing).toBe(true);
    expect(keyModeLine(s)).toMatch(/Using your own keys/);
  });

  // keyModeLine formatting is tested with explicit KeyStatus objects so it
  // does NOT depend on the global secret store (a module-load-frozen singleton
  // another test may have written a Tavily key into).
  test('own + Tavily key → "Tavily ✓"', () => {
    expect(keyModeLine({ mode: 'own', ownAnvilwing: true, ownTavily: true })).toMatch(/Tavily ✓/);
  });

  test('own without Tavily → shared-proxy note', () => {
    expect(keyModeLine({ mode: 'own', ownAnvilwing: true, ownTavily: false })).toMatch(/Tavily \(shared proxy\)/);
  });

  test('none → no line', () => {
    expect(keyModeLine({ mode: 'none', ownAnvilwing: false, ownTavily: false })).toBeNull();
  });
});

describe('resolveAnvilwingEndpoint — bring-your-own-key', () => {
  test('own → the user key hits the Anvilwing API directly', () => {
    process.env['ANVILWING_API_KEY'] = 'sk-own';
    const ep = resolveAnvilwingEndpoint();
    expect(ep.apiKey).toBe('sk-own');
    expect(ep.baseURL).toBe('https://api.deepseek.com');
  });

  test('ANVILWING_BASE_URL overrides the endpoint', () => {
    process.env['ANVILWING_API_KEY'] = 'sk-own';
    process.env['ANVILWING_BASE_URL'] = 'https://example.test/v1';
    try {
      expect(resolveAnvilwingEndpoint().baseURL).toBe('https://example.test/v1');
    } finally {
      delete process.env['ANVILWING_BASE_URL'];
    }
  });

  test('none → empty endpoint (caller raises the /key hint)', () => {
    const ep = resolveAnvilwingEndpoint();
    expect(ep.apiKey).toBe('');
    expect(ep.baseURL).toBe('');
  });
});

describe('the hosting/login subsystem is gone (source guard)', () => {
  const SRC = resolve(__dirname, '..', 'src');
  test('no hostedAuth module, no login plumbing in the shell', () => {
    const shell = readFileSync(resolve(SRC, 'headless', 'interactiveShell.ts'), 'utf8');
    expect(shell).not.toMatch(/hostedAuth|loginViaLoopback|clearHostedSession|HOSTED_ANVILWING_PROXY|handleLogin/);
    expect(shell).not.toMatch(/'\/login'|'\/logout'|'\/account'/);
  });
  test('keyResolution exposes only own/none — no hosted mode', () => {
    const kr = readFileSync(resolve(SRC, 'core', 'keyResolution.ts'), 'utf8');
    expect(kr).toMatch(/KeyMode = 'own' \| 'none'/);
    expect(kr).not.toMatch(/hosted|signedIn|session|loginViaLoopback/i);
  });
});
