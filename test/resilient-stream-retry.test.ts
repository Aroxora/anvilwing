/**
 * ResilientProvider.generateStream must NOT retry after it has already emitted a
 * chunk (discovery sweep). The old retry loop re-ran provider.generateStream()
 * from chunk 0 on a mid-stream transient error, re-yielding everything already
 * sent — silent content duplication. The class's own comment says retry is only
 * safe before the stream starts; a `yieldedAny` latch now enforces that.
 *
 * Real artifact: the REAL ResilientProvider wraps an inner provider test-double
 * (the DEPENDENCY, not the unit under test) that fails on its first call.
 *  - mid-stream failure → content emitted once + the error surfaces (fail-before:
 *    it was doubled and the retry swallowed the error).
 *  - pre-start failure → still retried and recovered (no regression).
 */

import { ResilientProvider } from '../src/providers/resilientProvider';
import type { LLMProvider, ProviderId, StreamChunk, ProviderResponse } from '../src/core/types';

class FlakyStreamProvider implements LLMProvider {
  readonly id = 'anvilwing' as ProviderId;
  readonly model = 'test-model';
  calls = 0;
  constructor(private mode: 'mid-stream' | 'pre-start') {}
  async generate(): Promise<ProviderResponse> { throw new Error('generate not used'); }
  async *generateStream(): AsyncIterableIterator<StreamChunk> {
    this.calls++;
    if (this.mode === 'mid-stream') {
      yield { type: 'content', content: 'Hello ' };
      yield { type: 'content', content: 'world' };
      if (this.calls === 1) throw new Error('econnreset'); // transient, AFTER emitting
    } else {
      if (this.calls === 1) throw new Error('econnreset'); // transient, BEFORE emitting
      yield { type: 'content', content: 'OK' };
    }
  }
}

const fastConfig = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, enableCircuitBreaker: false };

async function collect(p: ResilientProvider): Promise<{ text: string; threw: boolean }> {
  const chunks: string[] = [];
  let threw = false;
  try {
    for await (const c of p.generateStream([], [])) {
      if (c.type === 'content' && typeof c.content === 'string') chunks.push(c.content);
    }
  } catch { threw = true; }
  return { text: chunks.join(''), threw };
}

describe('ResilientProvider.generateStream mid-stream retry safety', () => {
  test('a transient failure AFTER the first chunk does not re-emit (no duplication)', async () => {
    const inner = new FlakyStreamProvider('mid-stream');
    const { text, threw } = await collect(new ResilientProvider(inner, fastConfig));
    expect(text).toBe('Hello world'); // once — not "Hello worldHello world"
    expect(inner.calls).toBe(1); // no mid-stream re-run
    expect(threw).toBe(true); // the transient error surfaced instead of being silently retried
  });

  test('a transient failure BEFORE any chunk is still retried and recovers', async () => {
    const inner = new FlakyStreamProvider('pre-start');
    const { text, threw } = await collect(new ResilientProvider(inner, fastConfig));
    expect(text).toBe('OK'); // recovered on the retry
    expect(inner.calls).toBe(2); // retried exactly once
    expect(threw).toBe(false);
  });
});
