/**
 * Provider-exact usage must reach the UI exactly ONCE per model request.
 *
 * Bug (audit 2026-06): on a streamed run the usage chunk fired
 * `callbacks.onUsage` (usage event #1) and the agent then passed the SAME
 * ProviderUsage object into `emitAssistantMessage({isFinal:true, usage,
 * wasStreamed:true})`, which handleAssistantMessage re-emitted (usage event
 * #2). The shell's TurnTokenMeter.recordExactOutput is additive, so every
 * turn's final request double-counted in the `↑ N tokens` meter and the
 * /usage cumulative accounting. A second inflation: already-streamed tool
 * narration was replayed as one big un-flagged message.delta, so the shell
 * metered the same chars twice.
 *
 * Real artifact: a REAL AgentController wrapping a REAL AgentRuntime, REAL
 * OpenAIChatCompletionsProvider (real SDK, real HTTP, real SSE parsing) and a
 * REAL ToolRuntime whose echo tool actually executes. The only fake is the
 * local node:http endpoint — the dependency, not the unit under test. The
 * jest.mock calls below stub the import.meta-using runtime wiring modules the
 * test never touches (same pattern as agentController.cancel.test.ts).
 */

import { describe, expect, test, beforeAll, jest } from '@jest/globals';

jest.mock('../../src/runtime/node.js', () => ({
  createNodeRuntime: jest.fn(() => {
    throw new Error('createNodeRuntime should not be called in this test');
  }),
}));

jest.mock('../../src/config.js', () => ({
  resolveProfileConfig: jest.fn(() => ({
    provider: 'test-provider',
    model: 'test-model',
    temperature: 0,
    maxTokens: 256,
    systemPrompt: 'sys',
  })),
}));

import http from 'node:http';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { AgentController } from '../../src/runtime/agentController.js';
import type { AgentSession } from '../../src/runtime/agentSession.js';
import { AgentRuntime, type AgentCallbacks } from '../../src/core/agent.js';
import { ToolRuntime, type ToolDefinition } from '../../src/core/toolRuntime.js';
import { OpenAIChatCompletionsProvider } from '../../src/providers/openaiChatCompletionsProvider.js';
import { TurnTokenMeter } from '../../src/core/turnTokenMeter.js';
import type { AgentEventUnion, MessageDeltaEvent, UsageEvent } from '../../src/contracts/v1/agent.js';

const NARRATION = 'Let me check with the echo tool.';
const FINAL_TEXT = 'The echo tool returned the ping correctly.';
const USAGE_1 = { prompt_tokens: 50, completion_tokens: 11, total_tokens: 61 };
const USAGE_2 = { prompt_tokens: 80, completion_tokens: 7, total_tokens: 87 };

function sseChunk(extra: object): string {
  return `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'test-model', ...extra })}\n\n`;
}

/**
 * Behaves like a real Anvilwing-shaped endpoint: request 1 streams narration +
 * a tool call with usage riding the finish chunk; request 2 (after the tool
 * result lands in the conversation) streams the final reply + usage.
 */
async function startServer(): Promise<{ url: string; requestCount: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (requests === 1) {
        res.write(sseChunk({ choices: [{ index: 0, delta: { content: NARRATION.slice(0, 12) }, finish_reason: null }] }));
        res.write(sseChunk({ choices: [{ index: 0, delta: { content: NARRATION.slice(12) }, finish_reason: null }] }));
        res.write(sseChunk({
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"message":"ping"}' } }] },
            finish_reason: null,
          }],
        }));
        res.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: USAGE_1 }));
      } else {
        res.write(sseChunk({ choices: [{ index: 0, delta: { content: FINAL_TEXT }, finish_reason: null }] }));
        res.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: USAGE_2 }));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requestCount: () => requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function makeSession(baseURL: string): AgentSession {
  const echoTool: ToolDefinition = {
    name: 'echo',
    description: 'Echoes back the input',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Message to echo' } },
      required: ['message'],
    },
    handler: (args) => `Echo: ${String(args['message'])}`,
  };
  const profileConfig = {
    provider: 'anvilwing',
    model: 'test-model',
    temperature: 0,
    maxTokens: 256,
    systemPrompt: 'You are a test agent.',
  };
  return {
    profileConfig,
    createAgent: (_selection: unknown, callbacks?: AgentCallbacks) =>
      new AgentRuntime({
        provider: new OpenAIChatCompletionsProvider({
          apiKey: 'sk-test-1234567890',
          model: 'test-model',
          baseURL,
          maxRetries: 0,
        }),
        toolRuntime: new ToolRuntime([echoTool], { workingDir: os.tmpdir(), enableCache: false }),
        systemPrompt: profileConfig.systemPrompt,
        callbacks,
      }),
  } as unknown as AgentSession;
}

jest.setTimeout(30_000);

describe('AgentController event stream on a real streamed tool-loop turn', () => {
  let events: AgentEventUnion[];
  let requestsServed = 0;

  beforeAll(async () => {
    const srv = await startServer();
    try {
      const controller = new AgentController({
        runtime: { session: makeSession(srv.url) } as never,
        sinkRef: { current: null },
      });
      events = [];
      for await (const event of controller.send('use the echo tool on "ping"')) {
        events.push(event);
      }
      requestsServed = srv.requestCount();
    } finally {
      await srv.close();
    }
  });

  test('the turn really spanned two model requests and finished with the final text', () => {
    expect(requestsServed).toBe(2);
    const complete = events.filter((e): e is Extract<AgentEventUnion, { type: 'message.complete' }> => e.type === 'message.complete');
    expect(complete).toHaveLength(1);
    expect(complete[0]!.content).toContain(FINAL_TEXT);
  });

  test('usage is emitted exactly once per request — the final message must not re-emit it', () => {
    const usage = events.filter((e): e is UsageEvent => e.type === 'usage');
    // Fail-before: 3 events (the final request's usage arrived twice).
    expect(usage).toHaveLength(2);
    expect(usage.map((u) => u.outputTokens)).toEqual([USAGE_1.completion_tokens, USAGE_2.completion_tokens]);
  });

  test('the shell-side meter replay rests at the exact completion total, counted once', () => {
    // Replays the events through the REAL TurnTokenMeter exactly as the
    // shell's handlers do (wiring source-asserted in turn-token-meter.test.ts).
    const meter = new TurnTokenMeter();
    for (const e of events) {
      if (e.type === 'message.delta' && !(e as MessageDeltaEvent).synthetic) {
        meter.addStreamedChars((e.content ?? '').length);
      } else if (e.type === 'usage') {
        meter.recordExactOutput(e.outputTokens ?? 0);
      }
    }
    expect(meter.current()).toBe(USAGE_1.completion_tokens + USAGE_2.completion_tokens);
  });

  test('already-streamed narration is NOT replayed as a display delta (no double-render)', () => {
    const deltas = events.filter((e): e is MessageDeltaEvent => e.type === 'message.delta');
    // Fail-before: the FULL narration was re-emitted as a synthetic
    // message.delta after the stream ended, and the shell renders synthetic
    // deltas — so the narration showed twice ("…planI'll start…"). The replay
    // is now dropped at the controller (wasStreamed → no emit).
    expect(deltas.some((d) => d.content === NARRATION)).toBe(false);
    // The live (countable) deltas still contain the narration exactly once.
    const counted = deltas.filter((d) => !d.synthetic).map((d) => d.content).join('');
    expect(counted.split(NARRATION).length - 1).toBe(1);
  });
});
