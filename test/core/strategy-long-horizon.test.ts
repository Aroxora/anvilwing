/**
 * Long-horizon strategy fixes (design audit #20-23): a multi-turn run must
 * stay anchored to the original goal and not let a previous request's plan or
 * a lossy compaction derail it.
 *
 *  #20 stale todos cleared on a fresh user prompt (shell source guard).
 *  #21 simple-prune compaction pins the original task when it prunes it away.
 *  #22 a tool-calling assistant message's calls survive summarization input.
 *  #23 auto-continue prompts re-anchor to the original request (shell guard).
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ContextManager } from '../../src/core/contextManager.js';
import type { ConversationMessage } from '../../src/core/contextManager.js';

const SHELL = readFileSync(resolve(__dirname, '..', '..', 'src', 'headless', 'interactiveShell.ts'), 'utf8');
const SESSION = readFileSync(resolve(__dirname, '..', '..', 'src', 'runtime', 'agentSession.ts'), 'utf8');

describe('#20 fresh prompt drops the previous plan', () => {
  test('the shell clears todos on a new user request', () => {
    expect(SHELL).toMatch(/clearCurrentTodos\(\)/);
    // imported alongside getCurrentTodos
    expect(SHELL).toMatch(/getCurrentTodos,\s*clearCurrentTodos/);
  });
});

describe('#21 simple-prune compaction pins the original task', () => {
  test('the first user request is restated when it gets pruned away', () => {
    const cm = new ContextManager({ maxTokens: 100_000, targetTokens: 400, preserveRecentMessages: 1, useLLMSummarization: false });
    const msgs: ConversationMessage[] = [
      { role: 'system', content: 'BASE' },
      { role: 'user', content: 'TASK_ANCHOR: build the parser and make the suite green' },
    ];
    for (let i = 0; i < 12; i++) {
      msgs.push({ role: 'assistant', content: `working ${i} ${'x'.repeat(300)}` });
      msgs.push({ role: 'user', content: `more ${i}` });
    }
    const r = cm.pruneMessages(msgs);
    expect(r.removed).toBeGreaterThan(0);
    const blob = JSON.stringify(r.pruned);
    // The literal first message is gone from the kept tail, but its text
    // survives in the compaction note.
    expect(blob).toContain('TASK_ANCHOR: build the parser');
    expect(blob).toMatch(/Original request:/);
  });
});

describe('#22 summarization keeps the assistant tool-call trace', () => {
  test('serializeMessage appends called-tools for a content-less tool turn', () => {
    expect(SESSION).toMatch(/\[called: /);
    expect(SESSION).toMatch(/c\.arguments as Record<string, unknown>/);
  });
});

describe('#23 auto-continue re-anchors to the original request', () => {
  test('the continuation prompt restates the original goal text', () => {
    expect(SHELL).toMatch(/Original request \(stay anchored to it\)/);
    expect(SHELL).toMatch(/\$\{anchor\}/);
  });
});
