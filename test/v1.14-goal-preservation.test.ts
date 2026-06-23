/**
 * Claude Code parity gap #8: pin the ORIGINAL GOAL across compaction.
 *
 * The default compaction path is LLM-summarization. The summary may compress,
 * soften, or DROP the precise original request — so on a long task the agent
 * could lose sight of WHAT it was asked to do once early turns are compacted.
 * Only the fallback prune path re-surfaced the first user message; the
 * summarization path did not. Now both pin the original request verbatim.
 *
 * Behavioural against the REAL ContextManager: a summarizer that deliberately
 * drops the goal, and we assert the compacted output still carries it verbatim.
 */

import { describe, expect, test } from '@jest/globals';
import { ContextManager } from '../src/core/contextManager';
import type { ConversationMessage } from '../src/core/types';

const GOAL =
  'Build a real-time rocket telemetry dashboard: ingest the UDP packet stream, ' +
  'decode the CCSDS frames, and render altitude/velocity/attitude with a 50ms refresh.';

function longConversation(): ConversationMessage[] {
  const msgs: ConversationMessage[] = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: GOAL },
  ];
  // Many later turns so summarization has something to compact (and the first
  // user message is NOT in the kept recent window).
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: 'assistant', content: `Working on sub-step ${i}: editing module ${i}.` });
    msgs.push({ role: 'user', content: `Continue with sub-step ${i + 1}, please proceed.` });
  }
  return msgs;
}

describe('the original goal survives LLM-summarization compaction', () => {
  test('the compacted summary pins the original request verbatim even when the summarizer drops it', async () => {
    const cm = new ContextManager({
      maxTokens: 100_000,
      targetTokens: 1_000,           // tiny target so force-prune definitely summarizes
      preserveRecentMessages: 2,
      useLLMSummarization: true,
      // A summarizer that NEVER mentions the rocket goal — proves the pin, not the summary.
      summarizationCallback: async () => 'The user and assistant exchanged several steps about editing modules.',
    });

    const result = await cm.pruneMessagesWithSummary(longConversation(), { force: true });
    expect(result.summarized).toBe(true);

    const summaryMsg = result.pruned.find(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('Context Summary'),
    );
    expect(summaryMsg).toBeDefined();
    const text = summaryMsg!.content as string;
    // Fail-before: the goal was nowhere in the summarization-path output.
    expect(text).toMatch(/Original request/);
    expect(text).toContain('rocket telemetry dashboard');
    expect(text).toContain('CCSDS frames'); // the FULL goal, not a 300-char stub
  });

  test('when the first user message is still in the kept window, it is NOT duplicated', async () => {
    const cm = new ContextManager({
      maxTokens: 100_000,
      targetTokens: 1_000,
      preserveRecentMessages: 50,    // keep everything recent → first user stays
      useLLMSummarization: true,
      summarizationCallback: async () => 'summary',
    });
    const short: ConversationMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: GOAL },
      { role: 'assistant', content: 'ok' },
    ];
    const result = await cm.pruneMessagesWithSummary(short, { force: true });
    // Nothing to summarize away → no goal re-surfacing needed (no duplication).
    const summaryMsg = result.pruned.find(
      (m) => typeof m.content === 'string' && m.content.includes('Original request'),
    );
    expect(summaryMsg).toBeUndefined();
  });
});
