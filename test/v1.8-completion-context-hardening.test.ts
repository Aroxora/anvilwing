/**
 * v1.8 hardening — three adversarially-verified correctness bugs in the agent
 * core (workflow wf_257b0a65-3fc, 2026-06-12). Each ships fail-before/pass-after
 * behavioural coverage against the REAL source plus a source-string assertion so
 * a future refactor that drops the guard is caught at CI time.
 *
 *  completion-loop  Bare "I'll <verb> … later" in the FINAL paragraph escaped
 *                   INCOMPLETE_WORK_PATTERNS (it required "now I'll"), so the
 *                   structural completion gate declared a one-shot task done
 *                   while the model had just deferred remaining work.
 *  context #2       truncateFileOutput kept head+tail by a fixed ~100 chars/line
 *                   estimate and never measured the result — long-line files blew
 *                   ~3x past the 50k char cap (maxToolOutputLength), defeating the
 *                   per-tool context budget.
 *  context #3       truncateSearchOutput had the same /80 estimate AND returned
 *                   the FULL output (no cut) when line count was under budget,
 *                   while truncateToolOutput still reported wasTruncated=true.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TaskCompletionDetector } from '../src/core/taskCompletionDetector.js';
import { createDefaultContextManager } from '../src/core/contextManager.js';

const REPO = resolve(__dirname, '..');
const COMPLETION_SRC = readFileSync(resolve(REPO, 'src/core/taskCompletionDetector.ts'), 'utf8');
const CONTEXT_SRC = readFileSync(resolve(REPO, 'src/core/contextManager.ts'), 'utf8');

const CAP = 50_000; // createDefaultContextManager().config.maxToolOutputLength

describe('completion-loop — forward-looking "I\'ll … later" in the final paragraph is incomplete work', () => {
  test('FAIL-BEFORE/PASS-AFTER: a deferred-work final paragraph is NOT a completion', () => {
    const det = new TaskCompletionDetector();
    const response =
      "I've implemented the core feature successfully.\n\n" +
      "I'll handle the edge cases and documentation later when needed.";
    const a = det.analyzeCompletion(response, ['search_replace']);
    expect(a.signals.hasIncompleteWorkIndicators).toBe(true);
    expect(a.isComplete).toBe(false);
  });

  test('regression guard: a courtesy sign-off ("I\'ll be here…") still reads as complete', () => {
    const det = new TaskCompletionDetector();
    const response =
      'I created scripts/run.sh and verified it runs.\n\n' +
      "I'll be here if you need anything else.";
    const a = det.analyzeCompletion(response, ['Write']);
    // "be" is not an action verb, so the new pattern must NOT veto this turn.
    expect(a.signals.hasIncompleteWorkIndicators).toBe(false);
    expect(a.isComplete).toBe(true);
  });

  test('a clean concrete completion with no deferral is still complete', () => {
    const det = new TaskCompletionDetector();
    const a = det.analyzeCompletion('I created the file and the build passed.', ['Write']);
    expect(a.signals.hasIncompleteWorkIndicators).toBe(false);
    expect(a.isComplete).toBe(true);
  });

  test('source: the incomplete-work patterns catch a future-tense work commitment', () => {
    expect(COMPLETION_SRC).toMatch(/I\(\?:'ll\|\\s\+will\)/);
  });
});

describe('context — line-based truncation must respect the char cap (maxToolOutputLength)', () => {
  test('FAIL-BEFORE/PASS-AFTER: a 1000-line long-line file Read stays within the cap', () => {
    const cm = createDefaultContextManager();
    const out = Array.from({ length: 1000 }, (_, i) => `line ${i}: ${' '.repeat(150)}`).join('\n');
    expect(out.length).toBeGreaterThan(CAP); // sanity: input overflows
    const r = cm.truncateToolOutput(out, 'Read');
    expect(r.wasTruncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(CAP);
  });

  test('FAIL-BEFORE/PASS-AFTER: a long-line Grep result stays within the cap', () => {
    const cm = createDefaultContextManager();
    const out = Array.from({ length: 700 }, (_, i) => `path/to/file${i}: ${' '.repeat(185)}`).join('\n');
    expect(out.length).toBeGreaterThan(CAP);
    const r = cm.truncateToolOutput(out, 'Grep');
    expect(r.content.length).toBeLessThanOrEqual(CAP);
  });

  test('FAIL-BEFORE/PASS-AFTER: search output that overflows by char (few long lines) is actually cut', () => {
    const cm = createDefaultContextManager();
    // 300 lines × ~194 chars = ~58k: line count is UNDER the /80 budget, so the
    // old code returned the full output while reporting wasTruncated=true.
    const out = Array.from({ length: 300 }, (_, i) => `match ${i}: ${' '.repeat(180)}`).join('\n');
    expect(out.length).toBeGreaterThan(CAP);
    const r = cm.truncateToolOutput(out, 'Grep');
    expect(r.wasTruncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(CAP);
  });

  test('a normal multi-line file (short lines) is still summarised head+tail, under the cap', () => {
    const cm = createDefaultContextManager();
    const out = Array.from({ length: 5000 }, (_, i) => `short line ${i}`).join('\n');
    const r = cm.truncateToolOutput(out, 'Read');
    expect(r.wasTruncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(CAP);
    expect(r.content).toMatch(/lines truncated for context management|characters truncated/);
  });

  test('source: both line-based truncators enforce the maxLength char bound', () => {
    // The fix: after building the line-based result, fall back to a char-bounded
    // cut when it still exceeds maxLength.
    const fileFn = CONTEXT_SRC.slice(CONTEXT_SRC.indexOf('private truncateFileOutput'));
    const fileBody = fileFn.slice(0, fileFn.indexOf('private truncateSearchOutput'));
    const searchFn = CONTEXT_SRC.slice(CONTEXT_SRC.indexOf('private truncateSearchOutput'));
    const searchBody = searchFn.slice(0, searchFn.indexOf('private truncateBashOutput'));
    expect(fileBody).toMatch(/<= maxLength|truncateDefault/);
    expect(searchBody).toMatch(/<= maxLength|truncateDefault/);
  });
});
