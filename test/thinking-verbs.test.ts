/**
 * Rotating thinking gerunds — Claude Code parity (CLAUDE_CODE_UX.md §4).
 *
 * Fail-before/pass-after: the spinner previously sat on a static "Thinking…".
 * This proves (a) the verb pool exists and includes the spec-named gerunds,
 * (b) pickThinkingVerb is deterministic under a seeded rng, (c) `exclude`
 * guarantees a rotation always lands on a different word, (d) the generic
 * sentinel detector matches every historical "Thinking" spelling but rejects
 * specific tool-activity labels — and source assertions so a refactor that
 * drops the wiring is caught at CI time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  THINKING_VERBS,
  GENERIC_THINKING_LABEL,
  isGenericThinking,
  pickThinkingVerb,
} from '../src/core/thinkingVerbs';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('thinkingVerbs — verb pool', () => {
  test('includes every gerund the UX spec names', () => {
    for (const v of ['Thinking', 'Synthesizing', 'Forging', 'Puzzling', 'Conjuring', 'Noodling']) {
      expect(THINKING_VERBS).toContain(v);
    }
  });

  test('has no duplicates and every entry is a capitalised single word', () => {
    expect(new Set(THINKING_VERBS).size).toBe(THINKING_VERBS.length);
    for (const v of THINKING_VERBS) {
      expect(v).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  test('the canonical generic label is itself a member of the pool', () => {
    expect(THINKING_VERBS).toContain(GENERIC_THINKING_LABEL);
  });
});

describe('pickThinkingVerb', () => {
  test('is deterministic under a seeded rng', () => {
    const seeded = () => 0; // floor(0 * n) === 0 → first verb
    expect(pickThinkingVerb({ rng: seeded })).toBe(THINKING_VERBS[0]);
    const last = () => 0.999999;
    expect(pickThinkingVerb({ rng: last })).toBe(THINKING_VERBS[THINKING_VERBS.length - 1]);
  });

  test('always returns a member of the pool over many draws', () => {
    for (let i = 0; i < 200; i++) {
      expect(THINKING_VERBS).toContain(pickThinkingVerb());
    }
  });

  test('exclude never returns the excluded verb — a rotation always changes', () => {
    for (const cur of THINKING_VERBS) {
      for (let i = 0; i < 50; i++) {
        expect(pickThinkingVerb({ exclude: cur })).not.toBe(cur);
      }
    }
  });
});

describe('isGenericThinking — sentinel detection', () => {
  test.each(['Thinking', 'Thinking…', 'Thinking...', '  Thinking…  '])(
    'treats %j as generic',
    (msg) => expect(isGenericThinking(msg)).toBe(true),
  );

  test.each([
    'Running python3 fibonacci.py',
    'Searching the web',
    'Read(fibonacci.py)',
    'Forging',
    '',
    null,
    undefined,
  ])('treats %j as a specific (non-generic) label', (msg) => {
    expect(isGenericThinking(msg as string | null | undefined)).toBe(false);
  });
});

describe('source wiring — the renderer actually consumes the rotation', () => {
  test('StatusLine threads a rotating thinkingGerund through the working line', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/ui/ink/StatusLine.tsx'), 'utf8');
    expect(src).toMatch(/thinkingGerund/);
    expect(src).toMatch(/pickThinkingVerb/);
    // The label must swap the message for the gerund while spinning.
    expect(src).toMatch(/spinning\s*&&\s*thinkingGerund\s*\?/);
  });

  test('controller derives thinkingGerund from the generic-thinking sentinel', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/ui/ink/InkPromptController.ts'), 'utf8');
    expect(src).toMatch(/isGenericThinking\(/);
    expect(src).toMatch(/thinkingGerund/);
  });
});
