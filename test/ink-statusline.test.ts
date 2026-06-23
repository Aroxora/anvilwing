/**
 * Phase-1 of the Ink migration. Proves the StatusLine component actually
 * renders to a real Ink reconciler — not via a mocked terminal, not via
 * jest's ESM-vs-CJS gymnastics. Spawns scripts/ink-smoke.mjs as a child
 * process, captures stdout, asserts on the cleaned frame.
 *
 * Per CLAUDE.md "Tests run real, no compromises": this test exercises
 * Ink end-to-end against the same dist artifact the real CLI loads.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { THINKING_VERBS } from '../src/core/thinkingVerbs';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ink-smoke.mjs');
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILT = path.resolve(REPO_ROOT, 'dist', 'ui', 'ink', 'StatusLine.js');

describe('Ink StatusLine — Phase 1 (subprocess smoke)', () => {
  beforeAll(() => {
    if (!fs.existsSync(BUILT)) {
      throw new Error(`dist artifact missing: ${BUILT}\nRun: npx tsc -p tsconfig.json`);
    }
  });

  const run = (...args: string[]): string =>
    execFileSync('node', [SCRIPT, ...args], { encoding: 'utf-8', cwd: REPO_ROOT });

  test('status: renders the message text', () => {
    expect(run('status', 'Thinking…').trim()).toBe('Thinking…');
  });

  test('StatusLine carries no mode row — the meta line lives below the input box (App.metaLine)', () => {
    const src = fs.readFileSync(
      path.resolve(REPO_ROOT, 'src', 'ui', 'ink', 'StatusLine.tsx'),
      'utf-8',
    );
    expect(src).not.toMatch(/modeMessage/);
  });

  test('empty: renders zero output when no props', () => {
    expect(run('empty')).toBe('');
  });

  test('cjk + emoji: renders without truncation drift', () => {
    const out = run('cjk').trim();
    expect(out).toContain('处理中');
    expect(out).toContain('你好世界');
    expect(out).toContain('👨‍👩‍👧‍👦');
  });

  test('gerund: a generic thinking spinner renders a rotating whimsical verb, not the literal sentinel', () => {
    const out = run('gerund').trim();
    // The working line shows a sparkle, then one of the curated gerunds + `…`.
    const m = out.match(/([A-Z][a-z]+)…/);
    expect(m).not.toBeNull();
    expect(THINKING_VERBS).toContain(m![1]);
  });

  test('spinner-meta: the working line carries elapsed · ↑ tokens · esc to interrupt (§4)', () => {
    // §4: while working, dim meta shows `(Ns · ↑ X tokens · esc to interrupt)`.
    // The smoke harness passes startTime (≈8s ago) + tokensUsed:1234 so all
    // three fields render on the real frame; elapsed is left tolerant (timing).
    const out = run('spinner-meta', 'Synthesizing').trim();
    expect(out).toContain('Synthesizing');
    expect(out).toMatch(/\(\d+s · ↑ 1\.2k tokens · esc to interrupt\)/);
  });

  test('reconciler diffs: a different message produces a different frame', () => {
    const a = run('status', 'first').trim();
    const b = run('status', 'second').trim();
    expect(a).toBe('first');
    expect(b).toBe('second');
  });
});
