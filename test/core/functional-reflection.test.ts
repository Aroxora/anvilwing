/**
 * "Obstacles as signal" baked into FUNCTIONAL code, not just the prompt: when
 * the agent loop sees N consecutive tool failures, trackToolResult injects a
 * reframe that steers the model to a DIFFERENT approach (the failure is signal
 * that the approach is wrong), proactively, without the user asking. This is the
 * functional counterpart to the system-prompt disposition.
 *
 * trackToolResult/isToolOutputFailure are private; AgentRuntime is importable,
 * so drive the real methods directly (same pattern as behavioralLoop.test.ts).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentRuntime } from '../../src/core/agent.js';
import { ToolRuntime } from '../../src/core/toolRuntime.js';
import { ContextManager } from '../../src/core/contextManager.js';
import type {
  LLMProvider, ConversationMessage, ProviderResponse, ProviderToolDefinition, StreamChunk,
} from '../../src/core/types.js';

const agentSrc = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'agent.ts'), 'utf8');

class IdleProvider implements LLMProvider {
  readonly id = 'scripted' as const;
  readonly model = 'mock-model';
  async generate(_m: ConversationMessage[], _t: ProviderToolDefinition[]): Promise<ProviderResponse> {
    return { type: 'message', content: 'unused', stopReason: 'stop' };
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *generateStream(_m: ConversationMessage[], _t: ProviderToolDefinition[]): AsyncIterable<StreamChunk> {
    yield { type: 'done' };
  }
}

function makeRuntime(): AgentRuntime {
  return new AgentRuntime({
    provider: new IdleProvider(),
    toolRuntime: new ToolRuntime([], { enableCache: false }),
    systemPrompt: 'test',
    contextManager: new ContextManager({ maxTokens: 100_000, targetTokens: 80_000 }),
    providerId: 'scripted',
    modelId: 'mock-model',
    workingDirectory: process.cwd(),
  });
}

type Internals = { trackToolResult(output: string): string | null };
const internals = (r: AgentRuntime) => r as unknown as Internals;

describe('functional reflection on a stuck path', () => {
  it('stays quiet for the first two failures, reframes on the third', () => {
    const r = internals(makeRuntime());
    const fail = 'Error: no such file or directory';
    expect(r.trackToolResult(fail)).toBeNull();          // 1
    expect(r.trackToolResult(fail)).toBeNull();          // 2
    const msg = r.trackToolResult(fail);                 // 3 → reframe
    expect(msg).toMatch(/treat that as signal/i);
    expect(msg).toMatch(/different approach/i);
    // It reframes (approach is wrong), it does NOT just say "try again".
    expect(msg).not.toMatch(/\btry again\b/i);
  });

  it('a success between failures resets the streak (no premature reframe)', () => {
    const r = internals(makeRuntime());
    const fail = 'command failed with exit code 1';
    expect(r.trackToolResult(fail)).toBeNull();          // 1
    expect(r.trackToolResult('ok, wrote 3 lines')).toBeNull(); // success → reset
    expect(r.trackToolResult(fail)).toBeNull();          // 1 again, not 2
    expect(r.trackToolResult(fail)).toBeNull();          // 2
  });

  it('source: the reflection is in the failure path, not just the prompt', () => {
    expect(agentSrc).toMatch(/treat that as signal, not noise/);
    expect(agentSrc).toMatch(/the approach itself is likely wrong/);
  });
});
