/**
 * narrationDedup — collapse adjacent near-duplicate assistant narration.
 *
 * Defense layer for the recurring "narration shows twice" bug. The primary
 * fix is upstream (agentController drops the already-streamed replay), but the
 * provider's streamed tokens and its reassembled message.complete can still
 * differ by punctuation/whitespace; if both ever reach history adjacently the
 * renderer must keep only the richer one, not glue them.
 *
 * Strings below are the EXACT pair from the user's v1.5.0 transcript.
 */

import {
  normalizeNarration,
  isNearDuplicateNarration,
  richerNarration,
} from '../../src/ui/ink/narrationDedup';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Streamed (rough — commas dropped) vs canonical message.complete (with commas).
const STREAMED = "I'll start by exploring the full repository to understand its structure architecture and current state before proposing an upgrade plan";
const CANONICAL = "I'll start by exploring the full repository to understand its structure, architecture, and current state before proposing an upgrade plan.";

describe('isNearDuplicateNarration', () => {
  test('the transcript pair (differs only by punctuation) is a near-duplicate', () => {
    expect(isNearDuplicateNarration(STREAMED, CANONICAL)).toBe(true);
    // richer = the canonical one (longer; kept its commas)
    expect(richerNarration(STREAMED, CANONICAL)).toBe(CANONICAL);
  });

  test('identical-after-normalization strings collapse', () => {
    expect(normalizeNarration('Hello,  world!')).toBe(normalizeNarration('hello world'));
    expect(isNearDuplicateNarration('Hello, world!', 'hello world')).toBe(true);
  });

  test('a near-superset (canonical adds a few words) collapses', () => {
    const a = 'Reading the config and the entry point.';
    const b = 'Reading the config and the entry point now to map the build.';
    expect(isNearDuplicateNarration(a, b)).toBe(true);
    expect(richerNarration(a, b)).toBe(b);
  });

  test('genuinely different adjacent messages are NOT collapsed', () => {
    expect(isNearDuplicateNarration(
      'Here is the plan for the refactor.',
      'Next steps: run the build and the tests.',
    )).toBe(false);
  });

  test('a short reply is not collapsed into an unrelated long one (0.6 floor)', () => {
    expect(isNearDuplicateNarration('ok', STREAMED)).toBe(false);
  });

  test('empty / whitespace never counts as a duplicate', () => {
    expect(isNearDuplicateNarration('', 'anything')).toBe(false);
    expect(isNearDuplicateNarration('   ', 'anything')).toBe(false);
  });
});

describe('the controller routes commits through the dedup choke point (source guard)', () => {
  const src = readFileSync(
    resolve(__dirname, '..', '..', 'src', 'ui', 'ink', 'InkPromptController.ts'),
    'utf8',
  );
  test('_commitStreaming + _finalizeStreamingIfAny push via _pushAssistant', () => {
    expect(src).toMatch(/_pushAssistant/);
    expect(src).toMatch(/isNearDuplicateNarration/);
    // the old exact-equality dedup is gone
    expect(src).not.toMatch(/incoming && incoming !== buffered/);
  });
});
