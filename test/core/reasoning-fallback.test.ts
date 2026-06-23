/**
 * Guard the reasoning-synthesis fallback: it must fire ONLY when the turn
 * produced no response at all. The bug it replaces gated on currentResponseBuffer
 * (cleared at message.complete) plus stale timeout flags, so synthesized
 * (punctuation-mangled) reasoning got glued onto a real answer — the duplicated
 * "thought process" users reported.
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldSynthesizeFromReasoning } from '../../src/core/reasoningFallback.js';

const base = {
  hasReceivedResponseContent: false,
  finalResponseText: '',
  currentResponseBuffer: '',
  reasoningBuffer: 'I should run the build, then verify the output.',
};

describe('shouldSynthesizeFromReasoning', () => {
  test('fires for a genuinely empty turn that only produced reasoning', () => {
    expect(shouldSynthesizeFromReasoning(base)).toBe(true);
  });

  test('does NOT fire when streamed response content was received (the dup bug)', () => {
    expect(shouldSynthesizeFromReasoning({ ...base, hasReceivedResponseContent: true })).toBe(false);
  });

  test('does NOT fire when a final response was captured (anvilwing non-delta path)', () => {
    expect(shouldSynthesizeFromReasoning({ ...base, finalResponseText: 'The make data build timed out; reran it.' })).toBe(false);
  });

  test('does NOT fire while a response buffer is still filling', () => {
    expect(shouldSynthesizeFromReasoning({ ...base, currentResponseBuffer: 'partial answer' })).toBe(false);
  });

  test('does NOT fire when there is no reasoning to synthesize', () => {
    expect(shouldSynthesizeFromReasoning({ ...base, reasoningBuffer: '   ' })).toBe(false);
  });

  test('source: all three shell fallback sites use the guard (none gate on currentResponseBuffer alone)', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'headless', 'interactiveShell.ts'), 'utf8');
    const uses = src.match(/shouldSynthesizeFromReasoning\(\{/g) ?? [];
    expect(uses.length).toBe(3);
    // The old buggy gate must be gone.
    expect(src).not.toMatch(/reasoningBuffer\.trim\(\) && !this\.currentResponseBuffer\.trim\(\)/);
  });
});
