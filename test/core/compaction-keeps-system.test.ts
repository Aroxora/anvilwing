/**
 * Regression: ContextManager's turn-grouping (in BOTH pruneMessages and
 * pruneMessagesWithSummary) had branches for user/assistant/tool but none for
 * `system`, and no `else` — so a mid-conversation system message (a PRIOR
 * compaction summary, a recovery note) was silently dropped during pruning.
 * Repeated compaction therefore destroyed the previous summary. The fix adds a
 * `system` branch that carries those messages into a turn.
 *
 * Drives the REAL ContextManager.
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ContextManager } from '../../src/core/contextManager.js';
import type { ConversationMessage } from '../../src/core/contextManager.js';

describe('compaction preserves mid-conversation system messages', () => {
  test('pruneMessages keeps a RECENT mid-conversation system note (was dropped)', () => {
    const msgs: ConversationMessage[] = [{ role: 'system', content: 'BASE PROMPT' }];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'user', content: `u${i}` });
      msgs.push({ role: 'assistant', content: `a${i}` });
    }
    // A recent system note (e.g. an auto-recovery marker) just before the last reply.
    msgs.splice(msgs.length - 1, 0, { role: 'system', content: 'RECENT_SYS_NOTE_MARKER' });

    const cm = new ContextManager({ maxTokens: 1000, targetTokens: 1, preserveRecentMessages: 3 });
    const r = cm.pruneMessages(msgs);

    expect(JSON.stringify(r.pruned)).toContain('RECENT_SYS_NOTE_MARKER');
  });

  test('pruneMessagesWithSummary folds a PRIOR summary into the new summary (not dropped)', async () => {
    const msgs: ConversationMessage[] = [
      { role: 'system', content: 'BASE PROMPT' },
      { role: 'system', content: '=== Context Summary === PRIOR_SUMMARY_MARKER older history' },
    ];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'user', content: `u${i}` });
      msgs.push({ role: 'assistant', content: `a${i}` });
    }
    msgs[msgs.length - 2] = { role: 'user', content: 'latest RECENT_MARKER' };

    const cm = new ContextManager({
      maxTokens: 1000,
      targetTokens: 1,
      preserveRecentMessages: 3,
      useLLMSummarization: true,
      // Echo what it's asked to summarize so we can detect what reached toSummarize.
      summarizationCallback: async (toSummarize) =>
        'NEWSUMMARY:: ' + toSummarize.map((m) => m.content).join(' || '),
    });
    const r = await cm.pruneMessagesWithSummary(msgs, { force: true });

    expect(r.summarized).toBe(true);
    const blob = JSON.stringify(r.pruned);
    expect(blob).toContain('PRIOR_SUMMARY_MARKER'); // prior summary folded into the new one, not lost
    expect(blob).toContain('BASE PROMPT'); // base system still preserved
  });

  test('source: both grouping loops handle the system role', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'contextManager.ts'), 'utf8');
    const branches = src.match(/else if \(msg\.role === 'system'\)/g) ?? [];
    expect(branches.length).toBeGreaterThanOrEqual(2);
  });
});
