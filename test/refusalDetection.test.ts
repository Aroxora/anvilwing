/**
 * Regression: when the model returns a safety/policy refusal, the
 * interactive shell must treat that turn as terminal — auto-continue
 * resubmitting "continue" was producing the stuck "Thinking… (4m N s)"
 * spinner the user reported.
 */

import { isSafetyRefusal } from '../src/core/refusalDetection.js';

describe('isSafetyRefusal', () => {
  it('returns false for empty / whitespace input', () => {
    expect(isSafetyRefusal('')).toBe(false);
    expect(isSafetyRefusal(null)).toBe(false);
    expect(isSafetyRefusal(undefined)).toBe(false);
    expect(isSafetyRefusal('   \n\t  ')).toBe(false);
  });

  it('returns true for first-person "won\'t help" decline', () => {
    expect(isSafetyRefusal("I won't help with this request.")).toBe(true);
    expect(isSafetyRefusal('I will not help with that.')).toBe(true);
    expect(isSafetyRefusal("I'm not going to help with that.")).toBe(true);
  });

  it('returns true for "can\'t help" / "cannot help" variants', () => {
    expect(isSafetyRefusal("I can't help with this.")).toBe(true);
    expect(isSafetyRefusal("I cannot help with this request.")).toBe(true);
    expect(isSafetyRefusal("I'm unable to help with that.")).toBe(true);
  });

  it('returns true for "decline" variants', () => {
    expect(isSafetyRefusal('I decline this request.')).toBe(true);
    expect(isSafetyRefusal('I must decline.')).toBe(true);
    expect(isSafetyRefusal("I've declined this twice.")).toBe(true);
    expect(isSafetyRefusal("I'm declining to help here.")).toBe(true);
  });

  it('returns true for "guidelines/values/policy" wording', () => {
    expect(isSafetyRefusal('That goes against my guidelines.')).toBe(true);
    expect(isSafetyRefusal('That goes against my values.')).toBe(true);
    expect(isSafetyRefusal('That violates my usage policy.')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isSafetyRefusal("I CAN'T HELP WITH THAT.")).toBe(true);
    expect(isSafetyRefusal('I MUST DECLINE.')).toBe(true);
  });

  it('returns false for normal helpful responses', () => {
    expect(isSafetyRefusal('Sure, here is the answer:')).toBe(false);
    expect(isSafetyRefusal('I can help with that. First, run npm install.')).toBe(false);
    expect(isSafetyRefusal('Done. Three files were updated.')).toBe(false);
    // Negation of refusal phrases must not flip the result.
    expect(isSafetyRefusal("I'm happy to help.")).toBe(false);
  });

  it('only scans the first ~1KB so a buried refusal phrase is ignored', () => {
    // A 2KB lead-in followed by a refusal phrase should NOT be flagged
    // — refusals lead with the decline; this avoids tripping on a
    // user-quoted phrase mid-response.
    const padding = 'normal text. '.repeat(160); // ~2KB
    const text = padding + "i can't help";
    expect(text.length).toBeGreaterThan(1024);
    expect(isSafetyRefusal(text)).toBe(false);
  });
});
