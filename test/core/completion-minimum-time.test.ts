/**
 * "Get it done in minimum time, every time." A finished one-shot task must be
 * recognized as COMPLETE on the first check, so the auto-continue loop doesn't
 * re-prompt the model to re-verify an already-done result — which (observed
 * against the real binary) loops "File verified … contains X" several times
 * until the stall governor halts it with "tell me how to proceed".
 *
 * Fail-before: a plain "I created hello.txt" response matched none of the
 * narrow completion phrases, so analyzeCompletion returned isComplete:false →
 * the loop kept going. Pass-after: the structural-completion gate recognizes a
 * concrete completion with no remaining-work / error / question / doc-spam
 * signal. Multi-step turns (which carry an incomplete-work indicator) and
 * failing-test turns must still continue.
 */

import { describe, expect, test } from '@jest/globals';
import { TaskCompletionDetector } from '../../src/core/taskCompletionDetector.js';

const fresh = () => new TaskCompletionDetector();

describe('completion sticks on a finished one-shot task', () => {
  test('"I created hello.txt …" (after a write) is complete on the first check', () => {
    const a = fresh().analyzeCompletion(
      'I created hello.txt with the content HELLO_FROM_ANVILWING (19 bytes, no trailing newline).',
      ['Write'],
    );
    expect(a.isComplete).toBe(true);
  });

  test('a verification response ("File verified … exists … contains X") is complete', () => {
    const a = fresh().analyzeCompletion(
      'File verified — hello.txt exists and contains exactly HELLO_FROM_ANVILWING.',
      ['Read'],
    );
    expect(a.isComplete).toBe(true);
  });

  test('"I updated the config" is complete (no remaining-work signal)', () => {
    const a = fresh().analyzeCompletion('I updated the config to enable the cache.', ['Edit']);
    expect(a.isComplete).toBe(true);
  });
});

describe('completion is NOT declared early (multi-step / failures / spam still continue)', () => {
  test('a multi-step turn continues — "Next, I will …" vetoes completion', () => {
    const a = fresh().analyzeCompletion(
      'I created the model file. Next, I will wire it into the controller.',
      ['Write'],
    );
    expect(a.isComplete).toBe(false);
  });

  test('a visible test failure overrides any completion phrasing', () => {
    const a = fresh().analyzeCompletion('I updated the file.\nTests: 2 failed, 3 passed', ['Edit']);
    expect(a.isComplete).toBe(false);
  });

  test('documentation-spam never counts as completion', () => {
    const a = fresh().analyzeCompletion('I created SUMMARY.md with a full report of the work.', ['Write']);
    expect(a.isComplete).toBe(false);
  });

  test('an error mention keeps the task open', () => {
    const a = fresh().analyzeCompletion('I wrote the function but there is still a problem with the parser.', ['Write']);
    expect(a.isComplete).toBe(false);
  });
});

describe('"let me know" is a sign-off, not in-progress work', () => {
  test('it no longer flips the incomplete-work indicator', () => {
    const sig = fresh().analyzeCompletion(
      'I updated the config. Let me know if you need anything else.',
      ['Edit'],
    ).signals;
    expect(sig.hasIncompleteWorkIndicators).toBe(false);
  });
  test('"let me <action>" still signals in-progress work', () => {
    const sig = fresh().analyzeCompletion('Let me add the validation now.', ['Edit']).signals;
    expect(sig.hasIncompleteWorkIndicators).toBe(true);
  });
});
