/**
 * sanitizeErrorMessage redacts secrets from error messages / logs / console
 * output (Anvilwing: keep secrets safe even when blueprints are public). The
 * `sk-…` pattern was hex-only, so it caught a Anvilwing key but LEAKED an OpenAI
 * base62 key (sk-AbC…), an sk-proj-/sk-ant- key, or a bare JWT found in a user's
 * file/config/log. Broadened to cover those — without false-positiving on normal
 * prose (a real key is ≥20 chars after the prefix).
 *
 * Drives the REAL sanitizeErrorMessage.
 */

import { describe, expect, test } from '@jest/globals';
import { sanitizeErrorMessage } from '../../src/core/secretStore.js';

describe('sanitizeErrorMessage redacts every common key format', () => {
  test.each([
    ['Anvilwing hex sk-', 'failed: sk-1234567890abcdef1234567890abcdef'],
    ['OpenAI base62 sk-', 'failed: sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD'],
    ['sk-proj- key', 'sk-proj-AbCdEf123456789012345678901234567890'],
    ['sk-ant- key', 'sk-ant-api03-AbCdEf1234567890123456789012345'],
    ['tvly- key', 'tvly-abcdef1234567890ABCDEF'],
    ['bare JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabc123XYZ'],
    ['Bearer token', 'Authorization: Bearer abcDEF1234567890_xyz-token99'],
  ])('%s is redacted', (_label, msg) => {
    const out = sanitizeErrorMessage(msg);
    expect(out).toContain('[REDACTED]');
    // none of the secret material survives
    expect(out).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(out).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
    expect(out).not.toMatch(/tvly-[A-Za-z0-9_-]{16,}/);
  });

  test.each([
    ['short sk- in prose', 'the sk-8 ski lift opens at 9am'],
    ['plain prose', 'function calculate returns the sum of two numbers'],
    ['a hex-looking word', 'the commit abc1234 fixed the deadbeef bug'],
  ])('does NOT false-redact: %s', (_label, msg) => {
    expect(sanitizeErrorMessage(msg)).not.toContain('[REDACTED]');
  });

  test('source guard: sk- pattern is no longer hex-only + a JWT pattern exists', () => {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'secretStore.ts'), 'utf8');
    expect(src).toMatch(/sk-\[A-Za-z0-9_-\]\{20,\}/);
    expect(src).not.toMatch(/sk-\[a-f0-9\]\{32,\}/); // the hex-only pattern is gone
    expect(src).toMatch(/eyJ\[A-Za-z0-9_-\]/); // JWT pattern
  });
});
