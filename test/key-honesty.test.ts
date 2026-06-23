/**
 * Anvilwing hardening — secrets never live in the design.
 *
 * The repo shipped a baked-in Anvilwing key (`sk-…`) in src/core/secretStore.ts
 * (and a real key in test/jest-setup.cjs) — secrets inside the source, which
 * shipped in the npm `dist/` and git history. This is the exact failure mode
 * the Anvilwing principle exists to prevent. These tests fail-before / pass-after the fix
 * and stand as a permanent guard.
 *
 * Behavioural + source assertions, per CLAUDE.md test discipline.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SRC = resolve(__dirname, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|cjs|mjs|js)$/.test(entry)) out.push(p);
  }
  return out;
}

// Real provider-key shapes. NOT the redaction *patterns* in secretStore.ts
// (those read like `sk-[a-f0-9]{32,}` — a bracket follows `sk-`, so a literal
// key never matches them and vice-versa).
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /sk-[0-9a-f]{32,}/i, label: 'Anvilwing/OpenAI hex API key' },
  { re: /sk-proj-[A-Za-z0-9_-]{20,}/, label: 'OpenAI project key' },
  { re: /sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}/, label: 'Anthropic key' },
  { re: /AKIA[0-9A-Z]{16}/, label: 'AWS access key id' },
  { re: /xoxb-[0-9A-Za-z-]{20,}/, label: 'Slack bot token' },
  { re: /ghp_[A-Za-z0-9]{36,}/, label: 'GitHub PAT' },
];

describe('Anvilwing — no secret lives in the source', () => {
  test('no real provider API key is hardcoded anywhere under src/', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const { re, label } of SECRET_PATTERNS) {
        const m = src.match(re);
        // Ignore placeholders/examples (sk-proj-xxxxxxxx, 0000…): a real key is
        // high-entropy and never has a 5+ run of one character.
        if (m && !/(.)\1{4,}/.test(m[0])) {
          offenders.push(`${file.slice(SRC.length + 1)}: ${label} (${m[0].slice(0, 8)}…)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('secretStore has no baked-in Anvilwing default', () => {
    const src = readFileSync(join(SRC, 'core', 'secretStore.ts'), 'utf8');
    // The old code returned a hardcoded `sk-…` for ANVILWING_API_KEY.
    expect(src).not.toMatch(/sk-[0-9a-f]{32}/i);
    expect(src).not.toMatch(/const defaultKey\s*=/);
  });

  test('the test harness uses a placeholder key, never a real one', () => {
    const src = readFileSync(resolve(__dirname, 'jest-setup.cjs'), 'utf8');
    expect(src).toMatch(/sk-test-placeholder/);
    expect(src).not.toMatch(/sk-[0-9a-f]{32}/i);
  });

  test('Anvilwing credentials are resolved at runtime (bring-your-own-key → clear error)', () => {
    const src = readFileSync(join(SRC, 'plugins', 'providers', 'anvilwing', 'index.ts'), 'utf8');
    expect(src).toMatch(/resolveAnvilwingOptions/);
    expect(src).toMatch(/ANVILWING_API_KEY/);
    // Bring-your-own-key: a missing key yields a clear error, and NO key is ever
    // baked into source — it's read from env/secret store at runtime.
    expect(src).toMatch(/No Anvilwing API key/);
    expect(src).not.toMatch(/sk-[0-9a-f]{32}/i);
    expect(src).not.toMatch(/tvly-[A-Za-z0-9-]{8,}/);
  });
});
