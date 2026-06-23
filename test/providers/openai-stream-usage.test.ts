/**
 * Live token metering needs an exact usage chunk from streaming requests, but
 * the streaming request builder never sent `stream_options: {include_usage:
 * true}` — so OpenAI-compatible streams (Anvilwing included) never returned
 * usage and the spinner's `↑ N tokens` had nothing exact to snap to. A second
 * latent bug: with include_usage, OpenAI delivers usage on a trailing chunk
 * whose `choices` is EMPTY, which the old loop skipped via `if (!choice)
 * continue` before ever reaching the usage emitter.
 *
 * Real artifact: the REAL OpenAIChatCompletionsProvider (real OpenAI SDK, real
 * HTTP, real SSE parsing) pointed at a local node:http server — the server is
 * the dependency, not the unit under test. It behaves like a real
 * OpenAI-compatible endpoint: it only emits a usage chunk when the request
 * body actually asked for it, so the usage assertions fail without the fix.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OpenAIChatCompletionsProvider } from '../../src/providers/openaiChatCompletionsProvider';
import type { StreamChunk } from '../../src/core/types';

const PROVIDER_SRC = readFileSync(
  resolve(__dirname, '..', '..', 'src', 'providers', 'openaiChatCompletionsProvider.ts'),
  'utf8',
);

type Body = {
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  model?: string;
};

const USAGE = { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 };

function chunk(extra: object): object {
  return { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'test-model', ...extra };
}

/**
 * Streams SSE like a real OpenAI-compatible endpoint: content delta, finish
 * chunk, then — ONLY when the request asked for include_usage — the shape's
 * usage chunk ('trailing' = OpenAI empty-choices chunk, 'on-finish' =
 * Anvilwing usage riding the finish chunk).
 */
async function startServer(shape: 'trailing' | 'on-finish'): Promise<{
  url: string;
  requests: Body[];
  close: () => Promise<void>;
}> {
  const requests: Body[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw) as Body;
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const wantsUsage = body.stream_options?.include_usage === true;
      const events: object[] = [
        chunk({ choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] }),
      ];
      if (shape === 'on-finish') {
        events.push(chunk({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          ...(wantsUsage ? { usage: USAGE } : {}),
        }));
      } else {
        events.push(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
        if (wantsUsage) {
          events.push(chunk({ choices: [], usage: USAGE }));
        }
      }
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function streamOnce(baseURL: string): Promise<StreamChunk[]> {
  const provider = new OpenAIChatCompletionsProvider({
    apiKey: 'sk-test-1234567890',
    model: 'test-model',
    baseURL,
    maxRetries: 0,
  });
  const chunks: StreamChunk[] = [];
  for await (const c of provider.generateStream([{ role: 'user', content: 'hi' }], [])) {
    chunks.push(c);
  }
  return chunks;
}

describe('streaming requests opt in to usage reporting', () => {
  test('the request body the server receives carries stream_options.include_usage === true', async () => {
    const srv = await startServer('trailing');
    try {
      await streamOnce(srv.url);
      expect(srv.requests).toHaveLength(1);
      expect(srv.requests[0].stream).toBe(true);
      // Fail-before: the old builder sent no stream_options at all.
      expect(srv.requests[0].stream_options).toEqual({ include_usage: true });
    } finally {
      await srv.close();
    }
  });

  test('a trailing usage chunk with EMPTY choices (OpenAI shape) yields exactly one usage event with exact counts', async () => {
    const srv = await startServer('trailing');
    try {
      const chunks = await streamOnce(srv.url);
      expect(chunks.filter((c) => c.type === 'content').map((c) => c.content).join('')).toBe('Hello');
      const usageEvents = chunks.filter((c) => c.type === 'usage');
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0].usage).toEqual({ inputTokens: 7, outputTokens: 5, totalTokens: 12 });
    } finally {
      await srv.close();
    }
  });

  test('usage riding the finish chunk (Anvilwing shape) yields exactly one usage event — no double emit', async () => {
    const srv = await startServer('on-finish');
    try {
      const chunks = await streamOnce(srv.url);
      const usageEvents = chunks.filter((c) => c.type === 'usage');
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0].usage).toEqual({ inputTokens: 7, outputTokens: 5, totalTokens: 12 });
      expect(chunks.some((c) => c.type === 'done')).toBe(true);
    } finally {
      await srv.close();
    }
  });
});

describe('source guards (refactor tripwires)', () => {
  test('the streaming request builder keeps stream_options.include_usage', () => {
    expect(PROVIDER_SRC).toMatch(/stream_options:\s*\{\s*include_usage:\s*true\s*\}/);
  });

  test('usage emission runs before the empty-choices guard', () => {
    const usageEmit = PROVIDER_SRC.indexOf("'usage' in chunk && chunk.usage");
    const choicesGuard = PROVIDER_SRC.indexOf('if (!choice) continue;');
    expect(usageEmit).toBeGreaterThan(-1);
    expect(choicesGuard).toBeGreaterThan(-1);
    expect(usageEmit).toBeLessThan(choicesGuard);
  });
});
