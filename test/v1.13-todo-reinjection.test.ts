/**
 * Claude Code parity gap #2: the live TODO plan is now re-injected into EVERY
 * request as a transient <system-reminder>, so the model never loses its
 * checklist when older turns (including the original TodoWrite result) are
 * compacted away. This is what keeps the agent finishing a long, multi-step
 * task instead of drifting after compaction.
 *
 * Unit (buildTodoReminder) + behavioural against the REAL AgentRuntime (the
 * reminder reaches the provider request but is NOT persisted in history).
 */

import { describe, expect, test, beforeEach } from '@jest/globals';
import { createTodoTools, clearCurrentTodos, buildTodoReminder } from '../src/tools/todoTools';
import { AgentRuntime } from '../src/core/agent';
import { ContextManager } from '../src/core/contextManager';
import { ToolRuntime } from '../src/core/toolRuntime';
import type {
  ConversationMessage, LLMProvider, ProviderResponse, ProviderToolDefinition, StreamChunk,
} from '../src/core/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function setTodos(todos: Array<{ content: string; status: string; activeForm?: string }>): Promise<void> {
  const write = createTodoTools().find((t) => t.name === 'TodoWrite')!;
  await (write.handler as (a: unknown) => Promise<unknown>)({ todos });
}

describe('buildTodoReminder', () => {
  beforeEach(() => clearCurrentTodos());

  test('null when there is no actionable plan (empty or all completed)', () => {
    expect(buildTodoReminder()).toBeNull();
  });

  test('formats open items with a keep-going instruction', async () => {
    await setTodos([
      { content: 'Write the parser', status: 'completed' },
      { content: 'Wire it into the CLI', status: 'in_progress', activeForm: 'Wiring it into the CLI' },
      { content: 'Add tests', status: 'pending' },
    ]);
    const r = buildTodoReminder()!;
    expect(r).toContain('<system-reminder>');
    expect(r).toMatch(/Keep going until EVERY item is \[x\] completed/);
    expect(r).toContain('[x] Write the parser');
    expect(r).toContain('[~] Wiring it into the CLI'); // in-progress uses activeForm
    expect(r).toContain('[ ] Add tests');
  });

  test('null again once every item is completed (no noise on a finished plan)', async () => {
    await setTodos([
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'completed' },
    ]);
    expect(buildTodoReminder()).toBeNull();
  });
});

class CapturingProvider implements LLMProvider {
  readonly id = 'capturing' as const;
  readonly model = 'mock';
  lastMessages: ConversationMessage[] = [];
  async generate(): Promise<ProviderResponse> { return { type: 'message', content: 'done', stopReason: 'stop' }; }
  async *generateStream(msgs: ConversationMessage[], _t: ProviderToolDefinition[]): AsyncIterable<StreamChunk> {
    this.lastMessages = msgs;
    yield { type: 'content', content: 'ok' };
    yield { type: 'done' };
  }
}

function makeRuntime(provider: LLMProvider): AgentRuntime {
  return new AgentRuntime({
    provider,
    toolRuntime: new ToolRuntime([], { enableCache: false }),
    systemPrompt: 'test',
    contextManager: new ContextManager({ maxTokens: 100_000, targetTokens: 80_000 }),
    providerId: provider.id as string,
    modelId: provider.model as string,
    workingDirectory: process.cwd(),
    callbacks: {},
  });
}

describe('the agent injects the live plan into the request (not persisted)', () => {
  beforeEach(() => clearCurrentTodos());

  test('a pending plan reaches the provider request as a <system-reminder>', async () => {
    await setTodos([{ content: 'Finish the migration', status: 'in_progress', activeForm: 'Finishing the migration' }]);
    const provider = new CapturingProvider();
    const runtime = makeRuntime(provider);
    await runtime.send('go', true);
    const reminder = provider.lastMessages.find(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('<system-reminder>'),
    );
    expect(reminder).toBeDefined();
    expect(reminder!.content).toContain('Finishing the migration');
    // It must be transient: the persisted history must NOT contain the reminder.
    const history = runtime.getHistory();
    expect(history.some((m) => typeof m.content === 'string' && m.content.includes('<system-reminder>'))).toBe(false);
  });

  test('no plan → no reminder in the request', async () => {
    const provider = new CapturingProvider();
    await makeRuntime(provider).send('go', true);
    expect(provider.lastMessages.some(
      (m) => typeof m.content === 'string' && m.content.includes('<system-reminder>'),
    )).toBe(false);
  });
});
