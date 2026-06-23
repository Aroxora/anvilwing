/**
 * Claude Code parity gap #9: a manual /compact command. Context could only be
 * compacted automatically; now a user can reclaim it on demand on a long task.
 *
 * Behavioural against the REAL AgentRuntime.compactNow() (forces a real
 * summarize-and-notify pass) + source contract for the /compact wiring.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { AgentRuntime } from '../src/core/agent';
import { ContextManager } from '../src/core/contextManager';
import { ToolRuntime } from '../src/core/toolRuntime';
import type { ConversationMessage, LLMProvider, ProviderResponse } from '../src/core/types';

const REPO = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf8');

class NoopProvider implements LLMProvider {
  readonly id = 'noop' as const;
  readonly model = 'mock';
  async generate(): Promise<ProviderResponse> { return { type: 'message', content: 'ok', stopReason: 'stop' }; }
}

function longHistory(): ConversationMessage[] {
  const h: ConversationMessage[] = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Migrate the whole service from REST to gRPC, end to end.' },
  ];
  for (let i = 0; i < 30; i++) {
    h.push({ role: 'assistant', content: `Step ${i}: edited service module ${i} with substantial detail here.` });
    h.push({ role: 'user', content: `Continue with step ${i + 1}.` });
  }
  return h;
}

describe('compactNow() forces a compaction on demand', () => {
  test('it summarizes, reports what was freed, and fires the context.compacted callback', async () => {
    let prunedEvent: { removed: number } | null = null;
    const cm = new ContextManager({
      maxTokens: 100_000,
      targetTokens: 1_000,
      preserveRecentMessages: 2,
      useLLMSummarization: true,
      summarizationCallback: async () => 'A summary of the earlier migration steps.',
    });
    const runtime = new AgentRuntime({
      provider: new NoopProvider(),
      toolRuntime: new ToolRuntime([], { enableCache: false }),
      systemPrompt: 'test',
      contextManager: cm,
      providerId: 'noop',
      modelId: 'mock',
      workingDirectory: process.cwd(),
      callbacks: { onContextPruned: (removed) => { prunedEvent = { removed }; } },
    });
    runtime.loadHistory(longHistory());
    const before = runtime.getHistory().length;

    const res = await runtime.compactNow();

    expect(res.removed).toBeGreaterThan(0);
    expect(res.summarized).toBe(true);
    expect(runtime.getHistory().length).toBeLessThan(before); // history actually shrank
    expect(prunedEvent).not.toBeNull();                        // the UI-note callback fired
    // The goal pin (#8) rides this path too — the original request survives.
    const text = runtime.getHistory().map((m) => String(m.content)).join('\n');
    expect(text).toContain('Migrate the whole service from REST to gRPC');
  });

  test('compactNow on an empty/short history removes nothing (clean no-op)', async () => {
    const runtime = new AgentRuntime({
      provider: new NoopProvider(),
      toolRuntime: new ToolRuntime([], { enableCache: false }),
      systemPrompt: 'test',
      contextManager: new ContextManager({ maxTokens: 100_000, targetTokens: 1_000, useLLMSummarization: true, summarizationCallback: async () => 's' }),
      providerId: 'noop',
      modelId: 'mock',
      workingDirectory: process.cwd(),
      callbacks: {},
    });
    runtime.loadHistory([{ role: 'user', content: 'hi' }]);
    const res = await runtime.compactNow();
    expect(res.removed).toBe(0);
  });
});

describe('/compact is wired into the shell and the command palette', () => {
  test('the shell handles /compact via controller.compactNow() and renders the note', () => {
    const shell = read('src', 'headless', 'interactiveShell.ts');
    expect(shell).toMatch(/lower === '\/compact'/);
    expect(shell).toMatch(/this\.controller\.compactNow\(\)/);
    expect(shell).toMatch(/formatCompactionNote\(\{/);
  });

  test('compactNow forces compaction regardless of budget', () => {
    expect(read('src', 'core', 'agent.ts')).toMatch(/pruneMessagesWithSummary\(this\.messages, \{ force: true \}\)/);
  });

  test('/compact appears in the slash-command palette', () => {
    expect(read('src', 'core', 'slashCommands.ts')).toMatch(/command: '\/compact'/);
  });
});
