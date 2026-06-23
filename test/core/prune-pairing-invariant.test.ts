/**
 * Long-horizon hard-failure guard: pruned history must ALWAYS satisfy the
 * OpenAI/Anvilwing tool-pairing invariant —
 *
 *   1. every `role:'tool'` message's nearest preceding non-tool message is an
 *      assistant whose toolCalls include its toolCallId, and
 *   2. every assistant message with toolCalls is immediately followed by tool
 *      replies covering ALL its ids before any non-tool message.
 *
 * If pruning ever emits a history violating this, the very next API call 400s
 * ("tool message without preceding tool_calls") and a long run dies mid-task —
 * the worst possible long-horizon failure. This drives the REAL ContextManager
 * prune paths over adversarial histories (parallel tool calls, mid-turn system
 * notes, tool-heavy single turns, tiny budgets that force maximal pruning) and
 * asserts the invariant on every output.
 */

import { describe, expect, test } from '@jest/globals';
import { ContextManager } from '../../src/core/contextManager.js';
import type { ConversationMessage } from '../../src/core/contextManager.js';

type Msg = ConversationMessage & { toolCallId?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };

/** Assert the strict API pairing invariant over a message list. */
function assertPairingInvariant(messages: Msg[], label: string): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'tool') {
      // walk back to the nearest non-tool message
      let j = i - 1;
      while (j >= 0 && messages[j]!.role === 'tool') j--;
      const anchor = j >= 0 ? messages[j]! : null;
      const ok = Boolean(anchor && anchor.role === 'assistant' &&
        (anchor.toolCalls ?? []).some((c) => c.id === m.toolCallId));
      if (!ok) {
        throw new Error(`[${label}] orphaned tool message at index ${i} (toolCallId=${m.toolCallId}) — next API call would 400`);
      }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const want = new Set(m.toolCalls.map((c) => c.id));
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === 'tool') {
        want.delete(messages[j]!.toolCallId ?? '');
        j++;
      }
      if (want.size > 0) {
        throw new Error(`[${label}] assistant at index ${i} missing tool replies for: ${[...want].join(',')}`);
      }
    }
  }
}

const big = (tag: string) => `${tag} ${'Z'.repeat(3000)}`;

/** Multi-turn history with parallel tool calls + mid-turn system notes. */
function adversarialHistory(): Msg[] {
  const msgs: Msg[] = [{ role: 'system', content: 'BASE' }];
  for (let t = 0; t < 8; t++) {
    msgs.push({ role: 'user', content: `request ${t}` });
    // parallel tool calls (2 ids on one assistant message)
    msgs.push({
      role: 'assistant', content: `working ${t}`,
      toolCalls: [
        { id: `a${t}`, name: 'Read', arguments: { path: `x${t}` } },
        { id: `b${t}`, name: 'Grep', arguments: { pattern: `p${t}` } },
      ],
    });
    msgs.push({ role: 'tool', content: big(`RA${t}`), toolCallId: `a${t}` });
    msgs.push({ role: 'tool', content: big(`RB${t}`), toolCallId: `b${t}` });
    if (t % 3 === 1) msgs.push({ role: 'system', content: `compaction note ${t}` });
    msgs.push({ role: 'assistant', content: `answer ${t}` });
  }
  return msgs;
}

/** One user request, many sequential tool rounds (the tool-heavy shape). */
function toolHeavySingleTurn(): Msg[] {
  const msgs: Msg[] = [
    { role: 'system', content: 'BASE' },
    { role: 'user', content: 'audit everything' },
  ];
  for (let i = 0; i < 25; i++) {
    msgs.push({ role: 'assistant', content: `step ${i}`, toolCalls: [{ id: `t${i}`, name: 'Read', arguments: { f: i } }] });
    msgs.push({ role: 'tool', content: big(`OUT${i}`), toolCallId: `t${i}` });
  }
  msgs.push({ role: 'assistant', content: 'done' });
  return msgs;
}

const BUDGETS = [800, 2000, 6000, 20_000]; // tiny → roomy: each forces a different cut line

describe('pruned history always satisfies the API tool-pairing invariant', () => {
  test.each(BUDGETS)('pruneMessages @ target=%s tokens (multi-turn, parallel calls)', (target) => {
    const cm = new ContextManager({ maxTokens: 100_000, targetTokens: target, preserveRecentMessages: 2 });
    const r = cm.pruneMessages(adversarialHistory());
    assertPairingInvariant(r.pruned as Msg[], `multi-turn@${target}`);
  });

  test.each(BUDGETS)('pruneMessages @ target=%s tokens (tool-heavy single turn)', (target) => {
    const cm = new ContextManager({ maxTokens: 100_000, targetTokens: target, preserveRecentMessages: 2 });
    const r = cm.pruneMessages(toolHeavySingleTurn());
    assertPairingInvariant(r.pruned as Msg[], `tool-heavy@${target}`);
  });

  test.each(BUDGETS)('pruneMessagesWithSummary @ target=%s tokens', async (target) => {
    const cm = new ContextManager({
      maxTokens: 100_000, targetTokens: target, preserveRecentMessages: 2,
      useLLMSummarization: true, summarizationCallback: async () => 'SUMMARY OF OLDER TURNS',
    });
    const r = await cm.pruneMessagesWithSummary(adversarialHistory(), { force: true });
    assertPairingInvariant(r.pruned as Msg[], `summary@${target}`);
  });

  test('the system prompt survives every budget', () => {
    for (const target of BUDGETS) {
      const cm = new ContextManager({ maxTokens: 100_000, targetTokens: target, preserveRecentMessages: 2 });
      const r = cm.pruneMessages(adversarialHistory());
      expect(r.pruned[0]?.role).toBe('system');
      expect(r.pruned[0]?.content).toBe('BASE');
    }
  });
});
