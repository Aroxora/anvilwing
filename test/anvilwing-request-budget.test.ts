/**
 * anvilwing request budget — fail-before/pass-after net for the
 * 2026-06-12 design audit's top findings:
 *
 *  1. Every main-agent request capped output at max_tokens=4096 against a
 *     384k-output model (the profile sets no maxTokens, the plugin spread
 *     dropped undefined, the provider defaulted 4096) — and a probe proved
 *     thinking tokens COUNT INSIDE max_tokens, so one long thought starved
 *     the whole visible reply.
 *  2. finish_reason==='length' was swallowed: generate() never read it and
 *     the stream yielded a bare done — a truncated turn persisted as
 *     complete.
 *  3. REQUEST_CHAR_LIMIT=800k chars silently capped the 1M-token window at
 *     ~228k tokens, and the trim notice was unshift()ed to index 0, shifting
 *     the whole prompt prefix (prefix-cache destruction).
 *
 * Real artifact: the REAL plugin factory chain (registerAnvilwingProviderPlugin
 * → createProvider → resilience wrapper → OpenAIChatCompletionsProvider →
 * real OpenAI SDK → real HTTP) pointed at a local node:http server that
 * captures the exact wire body. No mock stands in for the unit under test.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OpenAIChatCompletionsProvider } from '../src/providers/openaiChatCompletionsProvider';
import { registerAnvilwingProviderPlugin } from '../src/plugins/providers/anvilwing/index';
import { createProvider } from '../src/providers/providerFactory';
import type { ConversationMessage } from '../src/core/types';

const REPO = resolve(__dirname, '..');
const PROVIDER_SRC = readFileSync(resolve(REPO, 'src/providers/openaiChatCompletionsProvider.ts'), 'utf8');
const PLUGIN_SRC = readFileSync(resolve(REPO, 'src/plugins/providers/anvilwing/index.ts'), 'utf8');

type CapturedBody = {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  thinking?: { type: string; budget_tokens: number };
  messages?: Array<{ role: string; content: string }>;
};

function startCaptureServer(finishReason: 'stop' | 'length'): Promise<{
  url: string;
  bodies: CapturedBody[];
  close: () => Promise<void>;
}> {
  const bodies: CapturedBody[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as CapturedBody);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion', created: 1, model: 'anvilwing',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: finishReason }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }));
    });
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      res({
        url: `http://127.0.0.1:${port}`,
        bodies,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('anvilwing factory requests the model\'s full budget (audit #1/#3/#4)', () => {
  const OLD_ENV = { key: process.env['ANVILWING_API_KEY'], url: process.env['ANVILWING_BASE_URL'] };
  afterEach(() => {
    if (OLD_ENV.key === undefined) delete process.env['ANVILWING_API_KEY']; else process.env['ANVILWING_API_KEY'] = OLD_ENV.key;
    if (OLD_ENV.url === undefined) delete process.env['ANVILWING_BASE_URL']; else process.env['ANVILWING_BASE_URL'] = OLD_ENV.url;
  });

  test('wire body: max_tokens=384000, temperature=0, thinking budget tracks max_tokens', async () => {
    const srv = await startCaptureServer('stop');
    process.env['ANVILWING_API_KEY'] = 'sk-test-budget-net-000000';
    process.env['ANVILWING_BASE_URL'] = srv.url;
    try {
      registerAnvilwingProviderPlugin();
      const provider = createProvider({ provider: 'anvilwing', model: 'anvilwing' });
      await provider.generate(
        [{ role: 'user', content: 'hi' }] as ConversationMessage[],
        [],
      );
      const body = srv.bodies[0]!;
      // Fail-before: 4096 (provider default — profile sets none, spread dropped it).
      expect(body.max_tokens).toBe(384_000);
      // Fail-before: undefined (server default temperature applied).
      expect(body.temperature).toBe(0);
      // Fail-before: hardcoded 32768 regardless of max_tokens.
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 384_000 - 65_536 });
    } finally {
      await srv.close();
    }
  });
});

describe('finish_reason length is surfaced, not swallowed (audit #1b)', () => {
  test('generate() maps finish_reason="length" to stopReason "max_tokens"', async () => {
    const srv = await startCaptureServer('length');
    try {
      const provider = new OpenAIChatCompletionsProvider({
        apiKey: 'sk-test-budget-net-000000',
        model: 'anvilwing',
        baseURL: srv.url,
        providerId: 'anvilwing',
        maxTokens: 16,
      });
      const res = await provider.generate([{ role: 'user', content: 'hi' }] as ConversationMessage[], []);
      // Fail-before: stopReason undefined — the cutoff was invisible.
      expect(res.stopReason).toBe('max_tokens');
    } finally {
      await srv.close();
    }
  });

  test('source: the stream done chunk carries stopReason on length-finish', () => {
    expect(PROVIDER_SRC).toMatch(
      /choice\.finish_reason === 'length'\s*\n\s*\? \{ type: 'done', stopReason: 'max_tokens' \}/,
    );
  });
});

describe('request char cap is window-sized and prefix-cache safe (audit #2)', () => {
  test('custom requestCharLimit trims oldest-first and inserts the notice AFTER the system block', async () => {
    const srv = await startCaptureServer('stop');
    try {
      const provider = new OpenAIChatCompletionsProvider({
        apiKey: 'sk-test-budget-net-000000',
        model: 'anvilwing',
        baseURL: srv.url,
        providerId: 'anvilwing',
        requestCharLimit: 2_000,
      });
      const filler = 'x'.repeat(400);
      const messages: ConversationMessage[] = [
        { role: 'system', content: 'SYSTEM PROMPT (stable prefix)' },
        ...Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `${i}:${filler}` })),
      ];
      await provider.generate(messages, []);
      const sent = srv.bodies[0]!.messages!;
      // The REAL system prompt keeps index 0 — the trim notice must NOT
      // shift the cached prefix.
      expect(sent[0]!.content).toBe('SYSTEM PROMPT (stable prefix)');
      expect(sent[1]!.content).toContain('[Context trimmed');
      // Oldest user messages dropped, newest kept.
      const userBodies = sent.filter((m) => m.role === 'user').map((m) => m.content[0]);
      expect(userBodies).not.toContain('0');
      expect(userBodies[userBodies.length - 1]).toBe('9');
    } finally {
      await srv.close();
    }
  });

  test('source: anvilwing plugin derives the cap from the model window', () => {
    expect(PLUGIN_SRC).toMatch(/requestCharLimit: Math\.floor\(windowInfo\.contextWindow \* 3\.5\)/);
    expect(PLUGIN_SRC).toMatch(/maxTokens: typeof config\.maxTokens === 'number' \? config\.maxTokens : 384_000/);
    expect(PLUGIN_SRC).toMatch(/temperature: typeof config\.temperature === 'number' \? config\.temperature : 0/);
  });

  test('source: thinking budget is sized from max_tokens (thinking counts INSIDE max_tokens)', () => {
    expect(PROVIDER_SRC).toMatch(/THINKING_OUTPUT_RESERVE = 65_536/);
    expect(PROVIDER_SRC).toMatch(/Math\.max\(1024, Math\.min\(383_999, cap - THINKING_OUTPUT_RESERVE\)\)/);
    expect(PROVIDER_SRC).not.toMatch(/budget_tokens: 32768/);
  });
});
