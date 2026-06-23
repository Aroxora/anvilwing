/**
 * User-visible context compaction.
 *
 * When the conversation approaches the model window, the context manager
 * prunes/summarizes it — previously silent. Now the agent reports freedTokens
 * via onContextPruned, the controller emits a 'context.compacted' event, and
 * the shell renders a dim note (Claude Code parity).
 *
 * The compaction MECHANISM is exercised against the REAL ContextManager
 * (import.meta-free → in-process): feed an over-budget conversation and assert
 * it actually prunes. The note text is pure → tested directly. Source
 * assertions lock the agent→controller→shell event wiring (tsc already proves
 * the event type is part of AgentEventUnion).
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ContextManager } from '../src/core/contextManager.js';
import { formatCompactionNote } from '../src/core/compactionNote.js';
import type { ConversationMessage } from '../src/core/types.js';

const REPO = resolve(__dirname, '..');
const CONTRACT = readFileSync(join(REPO, 'src', 'contracts', 'v1', 'agent.ts'), 'utf8');
const AGENT = readFileSync(join(REPO, 'src', 'core', 'agent.ts'), 'utf8');
const CONTROLLER = readFileSync(join(REPO, 'src', 'runtime', 'agentController.ts'), 'utf8');
const SHELL = readFileSync(join(REPO, 'src', 'headless', 'interactiveShell.ts'), 'utf8');

describe('ContextManager actually compacts an over-budget conversation (real)', () => {
  it('prunes messages when total tokens exceed the target', async () => {
    const cm = new ContextManager({
      maxTokens: 150,
      targetTokens: 100,
      preserveRecentMessages: 2,
      estimatedCharsPerToken: 4,
      useLLMSummarization: false, // no LLM → deterministic simple prune
    });

    const messages: ConversationMessage[] = [{ role: 'system', content: 'You are a coding agent.' }];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(200) }); // ~50 tokens each
    }

    expect(cm.isApproachingLimit(messages)).toBe(true);
    const result = await cm.pruneMessagesWithSummary(messages);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.pruned.length).toBeLessThan(messages.length);
    expect(result.summarized).toBe(false); // no callback → simple prune

    // freed-tokens math (what the agent reports): before − after > 0
    const before = cm.getStats(messages).totalTokens;
    const after = cm.getStats(result.pruned).totalTokens;
    expect(before - after).toBeGreaterThan(0);
  });

  it('does not prune when under the target', async () => {
    const cm = new ContextManager({ maxTokens: 100000, targetTokens: 80000, useLLMSummarization: false });
    const result = await cm.pruneMessagesWithSummary([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
    expect(result.removed).toBe(0);
  });
});

describe('formatCompactionNote — pure, emoji-free', () => {
  it('reports pruned messages, freed tokens, and resulting percent', () => {
    const note = formatCompactionNote({ removed: 8, freedTokens: 12500, summarized: false, percentage: 62 });
    expect(note).toBe('Compacted context — pruned 8 messages, freed ~12,500 tokens · 62% context used');
    expect(note).not.toMatch(/[📋⏪🔄🧠]/);
  });

  it('says "summarized" when the LLM summary path ran, and pluralizes', () => {
    expect(formatCompactionNote({ removed: 1, freedTokens: 0, summarized: true, percentage: 0 }))
      .toBe('Compacted context — summarized 1 message');
  });
});

describe('compaction event — source wiring locked', () => {
  it('contract declares the context.compacted event', () => {
    expect(CONTRACT).toMatch(/'context\.compacted'/);
    expect(CONTRACT).toMatch(/interface ContextCompactedEvent/);
  });
  it('agent computes freedTokens and fires onContextPruned', () => {
    expect(AGENT).toMatch(/freedTokens: Math\.max\(0, beforeTokens - stats\.totalTokens\)/);
    expect(AGENT).toMatch(/onContextPruned\?\.\(result\.removed/);
  });
  it('controller emits the context.compacted event to the sink', () => {
    expect(CONTROLLER).toMatch(/type: 'context\.compacted'/);
  });
  it('shell renders the compaction note', () => {
    expect(SHELL).toMatch(/case 'context\.compacted'/);
    expect(SHELL).toMatch(/formatCompactionNote\(/);
  });
});
