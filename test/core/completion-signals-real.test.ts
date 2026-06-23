/**
 * Regression: TaskCompletionDetector's file-write / commit signals were
 * permanently false — they read this.toolHistory, which nothing ever fed
 * (recordToolCall has zero callers). So the scored `hasRecentCommits` (+0.1)
 * could never fire: "multi-signal" completion confidence was response-regex
 * theater. The fix derives the signals from `toolsUsed` — the tools
 * analyzeCompletion is already handed for the round.
 *
 * Drives the REAL detector.
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TaskCompletionDetector } from '../../src/core/taskCompletionDetector.js';

describe('TaskCompletionDetector — signals reflect real tool activity', () => {
  test('hasRecentCommits is true when this round used bash and the response mentions a commit', () => {
    const d = new TaskCompletionDetector();
    const a = d.analyzeCompletion('All done — I ran git commit and committed the changes.', ['Bash']);
    expect(a.signals.hasRecentCommits).toBe(true);
  });

  test('hasRecentCommits is false without a bash tool this round (no phantom signal)', () => {
    const d = new TaskCompletionDetector();
    const a = d.analyzeCompletion('All done — I committed the changes.', []);
    expect(a.signals.hasRecentCommits).toBe(false);
  });

  test('hasRecentFileWrites reflects a write tool used this round', () => {
    const d = new TaskCompletionDetector();
    const a = d.analyzeCompletion('Updated the file.', ['Edit']);
    expect(a.signals.hasRecentFileWrites).toBe(true);
  });

  test('source: signals are derived from toolsUsed, not the unfed toolHistory alone', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'taskCompletionDetector.ts'), 'utf8');
    expect(src).toMatch(/toolsUsed\.some\(isBashTool\)/);
    expect(src).toMatch(/toolsUsed\.some\(isWriteTool\)/);
  });
});
