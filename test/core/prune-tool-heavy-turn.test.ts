/**
 * Regression: proactive pruning was a guaranteed no-op inside a tool-heavy turn.
 * Both prune paths keep whole turns and count only USER turns, so a single
 * request with many tool rounds (one user message, dozens of assistant+tool
 * messages) kept the entire conversation and pruned nothing — it could overflow.
 * The fix shrinks the oldest verbose tool outputs in place when turn-level
 * pruning removes nothing while over budget.
 *
 * Drives the REAL ContextManager.
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ContextManager } from '../../src/core/contextManager.js';
import type { ConversationMessage } from '../../src/core/contextManager.js';

function toolHeavyTurn(): ConversationMessage[] {
  const big = 'X'.repeat(4000);
  const msgs: ConversationMessage[] = [
    { role: 'system', content: 'BASE PROMPT' },
    { role: 'user', content: 'TASK_MARKER: audit the whole repository' },
  ];
  for (let i = 0; i < 20; i++) {
    msgs.push({
      role: 'assistant',
      content: `step ${i}`,
      toolCalls: [{ id: `t${i}`, name: 'Read', arguments: { path: `f${i}` } }],
    } as ConversationMessage);
    msgs.push({ role: 'tool', content: `TOOL_OUTPUT_${i} ${big}`, toolCallId: `t${i}` } as ConversationMessage);
  }
  return msgs;
}

function cm(extra: Record<string, unknown> = {}) {
  return new ContextManager({ maxTokens: 100_000, targetTokens: 2000, preserveRecentMessages: 10, ...extra });
}

describe('pruning a tool-heavy single turn actually reduces tokens', () => {
  test('pruneMessages shrinks oldest tool outputs instead of no-op', () => {
    const msgs = toolHeavyTurn();
    const before = cm().estimateTotalTokens(msgs);
    const r = cm().pruneMessages(msgs);
    const after = cm().estimateTotalTokens(r.pruned);

    expect(r.removed).toBeGreaterThan(0);
    expect(after).toBeLessThan(before / 2); // materially reduced
    const blob = JSON.stringify(r.pruned);
    expect(blob).toContain('TASK_MARKER'); // user task preserved
    expect(blob).toContain('TOOL_OUTPUT_19'); // most-recent tool output preserved
    expect(blob).not.toContain('TOOL_OUTPUT_0'); // oldest tool output collapsed
  });

  test('pruneMessagesWithSummary applies the same fallback when nothing spans turns', async () => {
    const msgs = toolHeavyTurn();
    const manager = cm({ useLLMSummarization: true, summarizationCallback: async () => 'unused' });
    const before = manager.estimateTotalTokens(msgs);
    const r = await manager.pruneMessagesWithSummary(msgs, { force: true });

    expect(r.removed).toBeGreaterThan(0);
    expect(manager.estimateTotalTokens(r.pruned)).toBeLessThan(before / 2);
  });

  test('source: the intra-turn reducer exists and is wired into both paths', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'contextManager.ts'), 'utf8');
    expect(src).toMatch(/reduceOversizedHistory/);
    expect((src.match(/this\.reduceOversizedHistory\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
