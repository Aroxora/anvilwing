/**
 * Regression: the production summarizationCallback (agentSession.ts) caught all
 * errors and RETURNED "[Summarization failed: …]" as a string. ContextManager
 * then inserted that string AS the context summary — permanently replacing the
 * pruned history with an error message — and its catch (designed to fall back to
 * simple pruning that keeps real recent messages) could never fire. The fix
 * makes the callback THROW on failure.
 *
 * Drives the REAL ContextManager to prove the contract: a throwing callback →
 * simple-prune fallback that keeps real messages; a string-returning callback →
 * the old poisoning behavior (the thing the fix avoids).
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ContextManager } from '../../src/core/contextManager.js';
import type { ConversationMessage, SummarizationCallback } from '../../src/core/contextManager.js';

function cfg(callback: SummarizationCallback) {
  return {
    maxTokens: 1000,
    targetTokens: 1,
    preserveRecentMessages: 3,
    useLLMSummarization: true,
    summarizationCallback: callback,
  };
}

function makeMessages(): ConversationMessage[] {
  const msgs: ConversationMessage[] = [{ role: 'system', content: 'SYSTEM PROMPT' }];
  for (let i = 0; i < 10; i++) {
    msgs.push({ role: 'user', content: `user message number ${i} OLD${i}` });
    msgs.push({ role: 'assistant', content: `assistant reply number ${i}` });
  }
  // Mark the most-recent user message so we can assert it survives.
  msgs[msgs.length - 2] = { role: 'user', content: 'the latest question RECENT_MARKER' };
  return msgs;
}

describe('summarization failure → keeps real messages, not an error string', () => {
  test('a THROWING callback triggers the simple-prune fallback (real messages kept)', async () => {
    const cm = new ContextManager(cfg(async () => {
      throw new Error('LLM unavailable');
    }));
    const r = await cm.pruneMessagesWithSummary(makeMessages(), { force: true });

    expect(r.summarized).toBe(false); // fallback fired
    const blob = JSON.stringify(r.pruned);
    expect(blob).not.toContain('Summarization failed');
    expect(blob).toContain('RECENT_MARKER'); // real recent message preserved
  });

  test('a STRING-returning callback poisons history (the bug the fix removes)', async () => {
    const cm = new ContextManager(cfg(async () => '[Summarization failed: LLM unavailable]'));
    const r = await cm.pruneMessagesWithSummary(makeMessages(), { force: true });

    expect(r.summarized).toBe(true);
    expect(JSON.stringify(r.pruned)).toContain('Summarization failed'); // error text inserted AS the summary
  });

  test('source: the production callback throws on failure (never returns a failure string)', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'runtime', 'agentSession.ts'), 'utf8');
    expect(src).not.toMatch(/return `\[Summarization failed/);
    expect(src).toMatch(/throw error instanceof Error \? error : new Error/);
  });
});
