/**
 * A mid-stream transient error must NOT retry the streaming generation: the
 * agent wraps its own retry loop around the (already-resilient) provider, and
 * re-running the stream re-emits from chunk 0 — duplicating the content the user
 * already saw. The retry is now gated on `!hasStreamedToUser`. A transient error
 * BEFORE any content still retries (nothing was shown, no dup).
 *
 * Drives the REAL AgentRuntime streaming path with scripted providers.
 */
import { describe, expect, test } from '@jest/globals';
import { AgentRuntime } from '../../src/core/agent.js';
import { ToolRuntime } from '../../src/core/toolRuntime.js';
import { ContextManager } from '../../src/core/contextManager.js';
import type {
  LLMProvider, ConversationMessage, ProviderResponse, ProviderToolDefinition, StreamChunk,
} from '../../src/core/types.js';

function makeRuntime(provider: LLMProvider, onStreamChunk: (c: string, t?: string) => void, onRetrying: () => void): AgentRuntime {
  return new AgentRuntime({
    provider,
    toolRuntime: new ToolRuntime([], { enableCache: false }),
    systemPrompt: 'test',
    contextManager: new ContextManager({ maxTokens: 100_000, targetTokens: 80_000 }),
    providerId: 'scripted',
    modelId: 'mock-model',
    workingDirectory: process.cwd(),
    callbacks: { onStreamChunk, onRetrying },
  } as never);
}

class StreamsThenFails implements LLMProvider {
  readonly id = 'scripted' as const;
  readonly model = 'mock-model';
  calls = 0;
  async generate(): Promise<ProviderResponse> { return { type: 'message', content: '', stopReason: 'stop' }; }
  async *generateStream(_m: ConversationMessage[], _t: ProviderToolDefinition[]): AsyncIterable<StreamChunk> {
    this.calls++;
    yield { type: 'content', content: 'Hello partial answer' } as StreamChunk;
    throw new Error('socket hang up'); // transient, AFTER content was streamed
  }
}

class FailsThenStreams implements LLMProvider {
  readonly id = 'scripted' as const;
  readonly model = 'mock-model';
  calls = 0;
  async generate(): Promise<ProviderResponse> { return { type: 'message', content: '', stopReason: 'stop' }; }
  async *generateStream(_m: ConversationMessage[], _t: ProviderToolDefinition[]): AsyncIterable<StreamChunk> {
    this.calls++;
    if (this.calls === 1) throw new Error('ECONNRESET socket'); // transient, BEFORE any content
    yield { type: 'content', content: 'recovered answer' } as StreamChunk;
    yield { type: 'done' } as StreamChunk;
  }
}

describe('streaming transient retry is gated on whether content was shown', () => {
  test('a transient error AFTER streaming content does NOT retry (no duplicate)', async () => {
    const provider = new StreamsThenFails();
    const chunks: string[] = [];
    let retried = 0;
    const r = makeRuntime(provider, (c, t) => { if (t !== 'reasoning') chunks.push(c); }, () => { retried++; });
    await expect(r.send('hi', true)).rejects.toBeDefined();
    expect(provider.calls).toBe(1);     // not re-run → no duplicate stream
    expect(retried).toBe(0);
    expect(chunks.filter((c) => c.includes('Hello partial')).length).toBe(1); // emitted exactly once
  });

  test('a transient error BEFORE any content still retries (nothing shown to duplicate)', async () => {
    const provider = new FailsThenStreams();
    const chunks: string[] = [];
    const r = makeRuntime(provider, (c, t) => { if (t !== 'reasoning') chunks.push(c); }, () => {});
    const out = await r.send('hi', true);
    expect(provider.calls).toBe(2);     // retried after the pre-content failure
    expect(out).toContain('recovered answer');
  });
});
