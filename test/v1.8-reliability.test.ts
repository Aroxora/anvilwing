/**
 * Long-horizon reliability batch — anvilwing-usage findings #5/#6/#7 from the
 * 2026-06-12 design audit. Each is a pure efficiency/reliability win for
 * multi-hour autonomous runs.
 *
 *  #5  Every replayed assistant message duplicated its full content into
 *      reasoning_content — ~2× the assistant-text bytes on EVERY request,
 *      compounding across a long session (probed: not rejected, just waste).
 *  #6  The anvilwing factory stacked inner maxRetries:3 under the resilience
 *      wrapper's 5 → up to 4×6=24 re-sends of a near-1M-token prompt on a
 *      persistently-transient failure, inner retries bypassing the rate limiter.
 *  #7  No inter-chunk stall watchdog: a silently dead SSE froze the turn for
 *      up to the 24h API timeout.
 *
 * Real artifact: the REAL OpenAIChatCompletionsProvider (real OpenAI SDK, real
 * HTTP, real SSE) against a local node:http server.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OpenAIChatCompletionsProvider } from '../src/providers/openaiChatCompletionsProvider';
import type { ConversationMessage } from '../src/core/types';

const REPO = resolve(__dirname, '..');
const PROVIDER_SRC = readFileSync(resolve(REPO, 'src/providers/openaiChatCompletionsProvider.ts'), 'utf8');
const PLUGIN_SRC = readFileSync(resolve(REPO, 'src/plugins/providers/anvilwing/index.ts'), 'utf8');
const AGENT_SRC = readFileSync(resolve(REPO, 'src/core/agent.ts'), 'utf8');

type Body = { messages?: Array<Record<string, unknown>> };

function startServer(): Promise<{ url: string; bodies: Body[]; close: () => Promise<void> }> {
  const bodies: Body[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion', created: 1, model: 'anvilwing',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }));
    });
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      res({ url: `http://127.0.0.1:${port}`, bodies, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe('#5 — replayed assistant turns carry no reasoning_content echo', () => {
  test('the wire body has NO reasoning_content on the assistant message', async () => {
    const srv = await startServer();
    try {
      const provider = new OpenAIChatCompletionsProvider({
        apiKey: 'sk-test-reliability-00000000',
        model: 'anvilwing',
        baseURL: srv.url,
        providerId: 'anvilwing',
      });
      const history: ConversationMessage[] = [
        { role: 'user', content: 'say A' },
        { role: 'assistant', content: 'A' },
        { role: 'user', content: 'now B' },
      ];
      await provider.generate(history, []);
      const assistant = srv.bodies[0]!.messages!.find((m) => m['role'] === 'assistant')!;
      expect(assistant).toBeDefined();
      // Fail-before: reasoning_content === 'A' (a duplicate of content).
      expect(assistant['reasoning_content']).toBeUndefined();
      expect(assistant['content']).toBe('A');
    } finally {
      await srv.close();
    }
  });

  test('source: the reasoning_content injection and its dead gate are gone', () => {
    expect(PROVIDER_SRC).not.toMatch(/assistantMessage\.reasoning_content = message\.content/);
    expect(PROVIDER_SRC).not.toMatch(/function supportsReasoningContent/);
  });
});

describe('#6 — the resilience wrapper is the single retry authority', () => {
  test('the anvilwing factory passes maxRetries:0 to the inner provider', () => {
    expect(PLUGIN_SRC).toMatch(/ZERO inner retries/);
    expect(PLUGIN_SRC).toMatch(/maxRetries: 0,/);
    // The resilience wrapper still owns retries (5).
    expect(PLUGIN_SRC).toMatch(/maxRetries: 5,/);
  });
});

describe('#7 — inter-chunk stall watchdog', () => {
  test('the streaming loop races iterator.next() against an inactivity timer', () => {
    expect(AGENT_SRC).toMatch(/nextWithWatchdog/);
    expect(AGENT_SRC).toMatch(/STREAM_STALL_MS/);
    expect(AGENT_SRC).toMatch(/Promise\.race\(\[iterator\.next\(\), watchdog\]\)\.finally\(\(\) => clearTimeout\(timer\)\)/);
  });

  test('the stall error message is timeout-classified (retryable) and the timer is unref\'d', () => {
    expect(AGENT_SRC).toMatch(/inter-chunk timeout/);
    expect(AGENT_SRC).toMatch(/timer\.unref === 'function'\) timer\.unref\(\)/);
  });

  test('a stalled stream closes and rethrows rather than hanging', () => {
    expect(AGENT_SRC).toMatch(/catch \(stallError\) \{[\s\S]{0,200}await closeStream\(\);[\s\S]{0,80}throw stallError/);
  });

  test('default window is 10 minutes, override via ANVILWING_STREAM_STALL_MS', () => {
    expect(AGENT_SRC).toMatch(/ANVILWING_STREAM_STALL_MS/);
    expect(AGENT_SRC).toMatch(/10 \* 60 \* 1000/);
  });
});
