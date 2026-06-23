/**
 * v1.5 hardening — two bugs in agent.ts streaming path.
 *
 * Issue A: isTransientError() was missing streaming-specific network patterns
 * ('premature close', 'premature end', 'unexpected end', 'aborted',
 * 'fetcherror', 'invalid response body'). A mid-stream connection drop from
 * undici/node-fetch would propagate uncaught instead of triggering the
 * existing 3-attempt retry logic.
 *
 * Issue B: when processConversationStreaming() hit the 120k-char safety guard,
 * it appended a truncation notice to fullContent but never emitted it via
 * onStreamChunk. The interactiveShell message.complete handler suppresses
 * re-rendering when currentResponseBuffer is already populated (wasStreamed
 * path), so users saw responses silently cut off with no explanation.
 *
 * Fix A: add the streaming patterns to networkPatterns in isTransientError().
 * Fix B: emit the notice via this.callbacks.onStreamChunk?.(notice, 'content')
 *        immediately after setting truncatedResponse=true.
 *
 * Per CLAUDE.md contract: behavioural assertion + source assertion for each fix.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentRuntime } from '../src/core/agent.js';
import { ToolRuntime } from '../src/core/toolRuntime.js';
import type {
  LLMProvider,
  ConversationMessage,
  ProviderToolDefinition,
  StreamChunk,
  ProviderResponse,
} from '../src/core/types.js';
import { ContextManager } from '../src/core/contextManager.js';

const agentSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/core/agent.ts'),
  'utf8',
);
// isTransientError's networkPatterns moved verbatim to the canonical error
// module (audit Rank 5 Phase 2); the source guards below follow it there.
const classificationSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/core/errorClassification.ts'),
  'utf8',
);

// ─── Shared helpers ──────────────────────────────────────────────────────────

function makeRuntime(
  provider: LLMProvider,
  callbacks: ConstructorParameters<typeof AgentRuntime>[0]['callbacks'] = {},
): AgentRuntime {
  return new AgentRuntime({
    provider,
    toolRuntime: new ToolRuntime([], { enableCache: false }),
    systemPrompt: 'test',
    contextManager: new ContextManager({ maxTokens: 100_000, targetTokens: 80_000 }),
    providerId: provider.id as string,
    modelId: provider.model as string,
    workingDirectory: process.cwd(),
    callbacks,
  });
}

// ─── Issue A: streaming transient-error retry ─────────────────────────────

class StreamingRetryProvider implements LLMProvider {
  readonly id = 'scripted-streaming' as const;
  readonly model = 'mock-model';
  private callCount = 0;

  constructor(
    private readonly firstCallError: Error | null,
    private readonly successContent: string,
  ) {}

  async generate(_msgs: ConversationMessage[], _tools: ProviderToolDefinition[]): Promise<ProviderResponse> {
    return { type: 'message', content: this.successContent, stopReason: 'stop' };
  }

  async *generateStream(
    _msgs: ConversationMessage[],
    _tools: ProviderToolDefinition[],
  ): AsyncIterable<StreamChunk> {
    const call = ++this.callCount;
    if (call === 1 && this.firstCallError) {
      throw this.firstCallError;
    }
    yield { type: 'content', content: this.successContent };
    yield { type: 'done' };
  }
}

describe('Issue A — streaming transient-error retry (#stream-transient)', () => {
  const STREAMING_ERRORS = [
    'premature close',
    'premature end of file',
    'unexpected end of JSON input',
    'aborted',
    'FetchError: request to',
    'invalid response body',
  ];

  test.each(STREAMING_ERRORS)(
    'retries on "%s" and returns success',
    async (errorMessage) => {
      const provider = new StreamingRetryProvider(
        new Error(errorMessage),
        'success after retry',
      );
      const runtime = makeRuntime(provider);

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const result = await Promise.race([
        runtime.send('hello', true),
        new Promise<string>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('TIMEOUT')), 10_000);
        }),
      ]).finally(() => {
        if (timeoutId !== null) clearTimeout(timeoutId);
      });

      expect(result).toContain('success after retry');
    },
    15_000,
  );

  test('source: premature close in networkPatterns', () => {
    expect(classificationSrc).toMatch(/premature close/);
  });

  test('source: premature end in networkPatterns', () => {
    expect(classificationSrc).toMatch(/premature end/);
  });

  test('source: unexpected end in networkPatterns', () => {
    expect(classificationSrc).toMatch(/unexpected end/);
  });

  test('source: aborted in networkPatterns', () => {
    expect(classificationSrc).toMatch(/'aborted'/);
  });

  test('source: fetcherror in networkPatterns', () => {
    expect(classificationSrc).toMatch(/fetcherror/i);
  });

  test('source: invalid response body in networkPatterns', () => {
    expect(classificationSrc).toMatch(/invalid response body/);
  });
});

// ─── Issue B: stream truncation notice via onStreamChunk ──────────────────

class OverflowStreamingProvider implements LLMProvider {
  readonly id = 'overflow-streaming' as const;
  readonly model = 'mock-overflow';

  async generate(): Promise<never> {
    throw new Error('non-streaming generate not used');
  }

  async *generateStream(
    _msgs: ConversationMessage[],
    _tools: ProviderToolDefinition[],
  ): AsyncIterable<StreamChunk> {
    // The runaway guard is sized to the model's REAL max output (384k tokens
    // ≈ 1.5M chars), so a runaway must exceed 1.6M chars in ONE response:
    // 165 × 10_000 = 1 650 000 chars.
    const CHUNK = 'x'.repeat(10_000);
    for (let i = 0; i < 165; i++) {
      yield { type: 'content', content: CHUNK };
    }
    yield { type: 'done' };
  }
}

describe('Issue B — stream truncation notice via onStreamChunk (#stream-truncation)', () => {
  test('onStreamChunk receives the truncation notice when a response exceeds the runaway limit', async () => {
    const streamChunks: string[] = [];
    const runtime = makeRuntime(new OverflowStreamingProvider(), {
      onStreamChunk: (chunk) => { streamChunks.push(chunk); },
    });

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      runtime.send('generate lots', true),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('TIMEOUT')), 15_000);
      }),
    ]).finally(() => {
      if (timeoutId !== null) clearTimeout(timeoutId);
    });

    const combined = streamChunks.join('');
    expect(combined).toMatch(/Response truncated/);
    expect(combined).toMatch(/runaway-output safety limit/);
  }, 20_000);

  test('a legitimately long response (300k chars — well over the OLD 120k cap) is NOT truncated', async () => {
    // Fail-before: the old 120k-char cap truncated this and dropped content.
    class LongLegitProvider implements LLMProvider {
      readonly id = 'long-legit' as const;
      readonly model = 'mock-long';
      async generate(): Promise<never> { throw new Error('unused'); }
      async *generateStream(): AsyncIterable<StreamChunk> {
        const CHUNK = 'y'.repeat(10_000);
        for (let i = 0; i < 30; i++) yield { type: 'content', content: CHUNK };
        yield { type: 'done' };
      }
    }
    const streamChunks: string[] = [];
    const runtime = makeRuntime(new LongLegitProvider() as unknown as LLMProvider, {
      onStreamChunk: (chunk) => { streamChunks.push(chunk); },
    });
    const out = await runtime.send('long answer', true);
    expect(streamChunks.join('')).not.toMatch(/Response truncated/);
    expect(out.length).toBeGreaterThanOrEqual(300_000); // full content kept, head intact
  }, 20_000);

  test('source: onStreamChunk called inside the truncatedResponse block', () => {
    // Fails before the fix (no onStreamChunk call in the block);
    // passes after (the notice is emitted so the UI sees it).
    expect(agentSrc).toMatch(
      /if \(truncatedResponse\)[\s\S]{0,800}onStreamChunk\?\.\(notice/,
    );
  });
});
