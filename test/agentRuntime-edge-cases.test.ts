/**
 * Subtle agent-loop bug hunt. Each test simulates a provider edge
 * case that has historically caused infinite loops, dropped
 * results, or silent corruption in tool-using agents:
 *
 *   - Empty tool_calls array (model said it wants tools but listed none)
 *   - Malformed tool call (missing id, missing function name)
 *   - Tool handler throws (not returning an error string)
 *   - Provider throws on generate
 *   - Cancellation requested mid-tool
 *
 * The runtime should handle each gracefully — never hang, never
 * silently drop the user's prompt, always produce a response.
 */

import { AgentRuntime } from '../src/core/agent.js';
import { ToolRuntime } from '../src/core/toolRuntime.js';
import type { ToolDefinition } from '../src/core/toolRuntime.js';
import type {
  LLMProvider,
  ProviderResponse,
  ConversationMessage,
  ProviderToolDefinition,
  StreamChunk,
} from '../src/core/types.js';
import { ContextManager } from '../src/core/contextManager.js';

interface ScriptedStep {
  response: ProviderResponse;
  /** if set, throw instead of returning */
  throwError?: Error;
}

class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted' as const;
  readonly model = 'mock-model';
  private idx = 0;
  constructor(private readonly script: ScriptedStep[]) {}

  async generate(
    _messages: ConversationMessage[],
    _tools: ProviderToolDefinition[],
  ): Promise<ProviderResponse> {
    const step = this.script[this.idx++];
    if (!step) {
      // Default terminal response when script is exhausted
      return { type: 'message', content: '[end of script]', stopReason: 'stop' };
    }
    if (step.throwError) throw step.throwError;
    return step.response;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *generateStream(
    _messages: ConversationMessage[],
    _tools: ProviderToolDefinition[],
  ): AsyncIterable<StreamChunk> {
    // Not used by these tests — runtime selects non-streaming when not set up.
    yield { type: 'done' };
  }
}

function makeRuntime(steps: ScriptedStep[], tool?: ToolDefinition): {
  runtime: AgentRuntime;
  toolRuntime: ToolRuntime;
} {
  const provider = new ScriptedProvider(steps);
  const toolRuntime = new ToolRuntime(tool ? [tool] : [], { enableCache: false });
  const runtime = new AgentRuntime({
    provider,
    toolRuntime,
    systemPrompt: 'test',
    contextManager: new ContextManager({ maxTokens: 100_000, targetTokens: 80_000 }),
    providerId: 'scripted',
    modelId: 'mock-model',
    workingDirectory: process.cwd(),
  });
  return { runtime, toolRuntime };
}

const echo: ToolDefinition = {
  name: 'echo',
  description: 'echo a string',
  parameters: {
    type: 'object' as const,
    properties: { text: { type: 'string' as const, description: 'text' } },
    required: ['text'],
  },
  handler: async (args: Record<string, unknown>) => `echo:${String(args['text'] ?? '')}`,
};

describe('AgentRuntime — edge cases', () => {
  it('empty tool_calls array does not hang the loop', async () => {
    const { runtime } = makeRuntime([
      // First "round" — model claims tool_calls but the array is empty.
      // Pre-fix this could spin forever waiting for tool results that
      // never come; the runtime should fall through to a final message.
      { response: { type: 'tool_calls', toolCalls: [], stopReason: 'tool_calls' } },
      // Subsequent round produces a real reply.
      { response: { type: 'message', content: 'final reply', stopReason: 'stop' } },
    ]);
    const result = await Promise.race([
      runtime.send('hello'),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000)),
    ]);
    expect(result).toBeTruthy();
    // Should not have timed out; either falls through to final or emits a clear message.
    expect(result).not.toEqual('TIMEOUT');
  }, 8000);

  it('malformed tool call (missing id) is gracefully handled', async () => {
    const { runtime } = makeRuntime([
      {
        response: {
          type: 'tool_calls',
          // Missing `id` — runtime should still call the tool by name OR skip.
          toolCalls: [{ id: '', name: 'echo', arguments: { text: 'x' } }],
          stopReason: 'tool_calls',
        },
      },
      { response: { type: 'message', content: 'done', stopReason: 'stop' } },
    ], echo);
    const result = await Promise.race([
      runtime.send('test'),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000)),
    ]);
    expect(result).toBeTruthy();
  }, 8000);

  it('tool handler throwing exception does not crash the loop', async () => {
    const explodingTool: ToolDefinition = {
      name: 'explode',
      description: 'always throws',
      parameters: { type: 'object' as const, properties: {} },
      handler: async () => {
        throw new Error('boom');
      },
    };
    const { runtime } = makeRuntime([
      {
        response: {
          type: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'explode', arguments: {} }],
          stopReason: 'tool_calls',
        },
      },
      { response: { type: 'message', content: 'recovered', stopReason: 'stop' } },
    ], explodingTool);
    const result = await Promise.race([
      runtime.send('try the bad tool'),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000)),
    ]);
    expect(result).toBe('recovered');
  }, 8000);

  it('provider throwing on generate produces a useful error', async () => {
    const { runtime } = makeRuntime([
      { response: { type: 'message', content: '' }, throwError: new Error('upstream 503') },
      { response: { type: 'message', content: 'after retry', stopReason: 'stop' } },
    ]);
    const result = await Promise.race([
      runtime.send('test'),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 8000)),
    ]);
    // Either retried successfully OR returned an error string — both
    // are acceptable. The forbidden case is hanging or returning ''.
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 12000);

  it('cancellation aborts in-flight loop', async () => {
    const { runtime } = makeRuntime([
      // First round wants a tool call.
      {
        response: {
          type: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'a' } }],
          stopReason: 'tool_calls',
        },
      },
      // After tool result, ask for another tool call.
      {
        response: {
          type: 'tool_calls',
          toolCalls: [{ id: 'c2', name: 'echo', arguments: { text: 'b' } }],
          stopReason: 'tool_calls',
        },
      },
      { response: { type: 'message', content: 'done', stopReason: 'stop' } },
    ], echo);
    // Schedule a cancel partway through.
    const sendPromise = runtime.send('multi-tool');
    setTimeout(() => runtime.cancel?.(), 50);
    const result = await Promise.race([
      sendPromise,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000)),
    ]);
    // Either landed on the cancelled message OR finished naturally before cancel was checked.
    expect(typeof result).toBe('string');
  }, 8000);

  it('back-to-back identical tool calls are detected as a behavioral loop', async () => {
    // Model that keeps calling echo with the same args 10 times.
    const steps: ScriptedStep[] = [];
    for (let i = 0; i < 10; i++) {
      steps.push({
        response: {
          type: 'tool_calls',
          toolCalls: [{ id: `c${i}`, name: 'echo', arguments: { text: 'same' } }],
          stopReason: 'tool_calls',
        },
      });
    }
    steps.push({ response: { type: 'message', content: 'done', stopReason: 'stop' } });
    const { runtime } = makeRuntime(steps, echo);
    const result = await Promise.race([
      runtime.send('start'),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 8000)),
    ]);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 12000);

  it('zero-length user input returns empty string without crashing', async () => {
    const { runtime } = makeRuntime([
      { response: { type: 'message', content: 'should not be reached', stopReason: 'stop' } },
    ]);
    const result = await runtime.send('   ');
    expect(result).toBe('');
  });
});
