/**
 * openaiChatCompletionsProvider security-honesty (discovery sweep, Anvilwing).
 *
 * Three appearance-only controls were removed/fixed:
 *  - safeJSONParse's depth/property "limits" were a no-op: the reviver read
 *    `this.__depth`, never set inside an arrow reviver, so deep JSON parsed
 *    unchecked. Now enforced for real by an iterative post-parse walk.
 *  - The constructor "rate limiting check" gated CONSTRUCTION (once), never
 *    requests, with a false "wait before making more requests" message — deleted.
 *  - isPotentiallyCompromisedKey was self-admitted theater ("in production these
 *    should come from a threat intelligence feed") that false-flagged legit keys
 *    (any 3 sequential digits / sk-test- prefix) — deleted.
 *
 * Behavioural fail-before/pass-after on the real safeJSONParse + source guards
 * that the theater stays gone.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { safeJSONParse } from '../src/providers/openaiChatCompletionsProvider';

const src = readFileSync(resolve(__dirname, '..', 'src', 'providers', 'openaiChatCompletionsProvider.ts'), 'utf8');

describe('safeJSONParse enforces real depth + property limits', () => {
  test('rejects JSON nested deeper than maxDepth (the old reviver never fired)', () => {
    let deep = '0';
    for (let i = 0; i < 30; i++) deep = `{"a":${deep}}`; // 30 levels deep
    expect(() => safeJSONParse(deep, { maxDepth: 5 })).toThrow(/depth/i);
  });

  test('rejects an object with more properties than maxProperties', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 50; i++) obj[`k${i}`] = i;
    expect(() => safeJSONParse(JSON.stringify(obj), { maxProperties: 10 })).toThrow(/propert/i);
  });

  test('parses normal JSON within limits and still cleans prototype-pollution', () => {
    expect(safeJSONParse<{ a: number }>('{"a":1,"b":{"c":2}}')).toEqual({ a: 1, b: { c: 2 } });
    // The __proto__ key is rewritten to a safe key, not applied to the prototype.
    const parsed = safeJSONParse<Record<string, unknown>>('{"__proto__":{"polluted":true},"x":1}');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(parsed['x']).toBe(1);
  });

  test('does NOT corrupt tool-argument values that merely contain constructor:/prototype:', () => {
    // A write_file tool call whose CONTENT is source code mentioning these tokens
    // — the old raw-string scrub mangled it into invalid JSON.
    const code = 'const x = { constructor: 1, prototype: 2 }; // obj.__proto__ note';
    const json = JSON.stringify({ path: 'a.js', content: code });
    const parsed = safeJSONParse<{ path: string; content: string }>(json);
    expect(parsed.path).toBe('a.js');
    expect(parsed.content).toBe(code); // value preserved verbatim, not scrubbed
  });
});

describe('security theater removed', () => {
  test('the constructor no longer gates on a no-op rate limiter', () => {
    expect(src).not.toMatch(/globalRateLimiter\.isAllowed/);
    expect(src).not.toMatch(/Rate limit exceeded for OpenAI provider/);
  });

  test('the fake compromised-key check is gone', () => {
    expect(src).not.toMatch(/isPotentiallyCompromisedKey/);
    expect(src).not.toMatch(/isSequentialDigits/);
    expect(src).not.toMatch(/patterns associated with compromised keys/);
  });

  test('safeJSONParse no longer relies on the dead this.__depth reviver', () => {
    expect(src).not.toMatch(/this as any\)\?\.__depth/);
    expect(src).toMatch(/function enforceJsonLimits/);
  });
});
