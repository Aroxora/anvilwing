import { describe, expect, test, afterEach, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Mock modules that rely on import.meta or heavy runtime wiring
jest.mock('../../src/runtime/node.js', () => ({
  createNodeRuntime: jest.fn(() => {
    throw new Error('createNodeRuntime should not be called in unit tests');
  }),
}));

jest.mock('../../src/config.js', () => ({
  resolveProfileConfig: jest.fn(() => ({
    provider: 'test-provider',
    model: 'test-model',
    temperature: 0,
    maxTokens: 128,
    systemPrompt: 'sys',
  })),
}));

import { AgentController } from '../../src/runtime/agentController.js';
import type { AgentSession } from '../../src/runtime/agentSession.js';

function makeFakeSession(sendImpl: (message: string, allowTools: boolean) => Promise<void>): AgentSession {
  return {
    profileConfig: {
      provider: 'test-provider',
      model: 'test-model',
      temperature: 0,
      maxTokens: 128,
      systemPrompt: 'sys',
    },
    createAgent: (_selection, callbacks) => {
      let history: any[] = [];
      return {
        send: sendImpl,
        loadHistory: (h: any[]) => {
          history = h;
        },
        getHistory: () => history,
        onToolCall: callbacks?.onToolCall,
      } as any;
    },
  } as unknown as AgentSession;
}

afterEach(() => {
  delete process.env.ANVILWING_AGENT_RUN_TIMEOUT_MS;
});

describe('AgentController cancellation and timeout (core-first)', () => {
  test('cancel stops an in-flight run and fails the stream', async () => {
    let resolveSend: (() => void) | null = null;
    const sendImpl = () =>
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      });

    const controller = new AgentController({
      runtime: { session: makeFakeSession(sendImpl) } as any,
      sinkRef: { current: null },
    });

    const iterator = controller.send('hello');
    const first = await iterator.next();
    expect(first.value?.type).toBe('message.start');

    controller.cancel('stop now');
    await expect(iterator.next()).rejects.toThrow(/stop now/i);

    resolveSend?.();
  });

  test('times out when run exceeds configured limit', async () => {
    process.env.ANVILWING_AGENT_RUN_TIMEOUT_MS = '10';
    const sendImpl = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

    const controller = new AgentController({
      runtime: { session: makeFakeSession(sendImpl) } as any,
      sinkRef: { current: null },
    });

    const iterator = controller.send('hello');
    const first = await iterator.next();
    expect(first.value?.type).toBe('message.start');

    await expect(iterator.next()).rejects.toThrow(/timed out/i);
  });

  // Regression: the controller used to call `(this.agent as any)?.cancel?.()`,
  // but the agent is an AgentRuntime whose only cancellation API is
  // `requestCancellation()` — so cancel/timeout silently no-op'd and the
  // underlying run kept going (zombie run mutating shared history). These tests
  // assert the agent is ACTUALLY told to cancel, not just that the stream fails.
  function makeRecordingSession(
    sendImpl: () => Promise<void>,
    record: { cancelled: number },
  ): AgentSession {
    return {
      profileConfig: {
        provider: 'test-provider', model: 'test-model', temperature: 0, maxTokens: 128, systemPrompt: 'sys',
      },
      createAgent: () => {
        let history: any[] = [];
        return {
          send: sendImpl,
          loadHistory: (h: any[]) => { history = h; },
          getHistory: () => history,
          requestCancellation: () => { record.cancelled += 1; },
        } as any;
      },
    } as unknown as AgentSession;
  }

  test('cancel() actually invokes the agent\'s requestCancellation()', async () => {
    const record = { cancelled: 0 };
    let resolveSend: (() => void) | null = null;
    const sendImpl = () => new Promise<void>((resolve) => { resolveSend = resolve; });

    const controller = new AgentController({
      runtime: { session: makeRecordingSession(sendImpl, record) } as any,
      sinkRef: { current: null },
    });

    const iterator = controller.send('hello');
    await iterator.next();
    controller.cancel('stop now');

    expect(record.cancelled).toBe(1);
    await expect(iterator.next()).rejects.toThrow(/stop now/i);
    resolveSend?.();
  });

  test('run-timeout actually invokes the agent\'s requestCancellation()', async () => {
    process.env.ANVILWING_AGENT_RUN_TIMEOUT_MS = '10';
    const record = { cancelled: 0 };
    const sendImpl = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

    const controller = new AgentController({
      runtime: { session: makeRecordingSession(sendImpl, record) } as any,
      sinkRef: { current: null },
    });

    const iterator = controller.send('hello');
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow(/timed out/i);

    expect(record.cancelled).toBe(1);
  });

  test('source: controller wires requestCancellation, not the dead as-any cancel', () => {
    const src = readFileSync(resolve(__dirname, '../../src/runtime/agentController.ts'), 'utf8');
    expect(src).toMatch(/this\.agent\?\.requestCancellation\(\)/);
    expect(src).not.toMatch(/as any\)\?\.cancel\?\./);
  });
});
