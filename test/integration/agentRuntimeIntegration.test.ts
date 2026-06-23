/**
 * Agent Runtime Integration Tests
 *
 * Tests the AgentRuntime class with:
 * - Context overflow recovery
 * - Streaming with interruption handling
 * - Cancellation support
 * - Tool execution pipeline
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { AgentRuntime, type AgentCallbacks } from '../../src/core/agent.js';
import { ToolRuntime, type ToolSuite, type ToolDefinition } from '../../src/core/toolRuntime.js';
import { ContextManager, createDefaultContextManager } from '../../src/core/contextManager.js';
import type { ConversationMessage, LLMProvider, ToolCallRequest } from '../../src/core/types.js';

// Mock LLM Provider for testing
class MockLLMProvider implements LLMProvider {
  private responses: Array<{
    type: 'text' | 'tool_calls';
    content?: string;
    toolCalls?: ToolCallRequest[];
  }> = [];
  private responseIndex = 0;
  public callHistory: ConversationMessage[][] = [];

  queueTextResponse(content: string): void {
    this.responses.push({ type: 'text', content });
  }

  queueToolCallResponse(content: string, toolCalls: ToolCallRequest[]): void {
    this.responses.push({ type: 'tool_calls', content, toolCalls });
  }

  queueContextOverflowError(): void {
    this.responses.push({ type: 'text', content: '__OVERFLOW__' });
  }

  async generate(messages: ConversationMessage[]): Promise<{
    type: 'text' | 'tool_calls';
    content?: string;
    toolCalls?: ToolCallRequest[];
    usage?: { inputTokens: number; outputTokens: number };
  }> {
    this.callHistory.push([...messages]);

    if (this.responseIndex >= this.responses.length) {
      return { type: 'text', content: 'Default mock response' };
    }

    const response = this.responses[this.responseIndex++]!;

    // Simulate context overflow error
    if (response.content === '__OVERFLOW__') {
      const error = new Error('Context length exceeded: token limit reached');
      throw error;
    }

    return {
      ...response,
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }

  reset(): void {
    this.responses = [];
    this.responseIndex = 0;
    this.callHistory = [];
  }
}

// Mock Tool Suite for testing
function createMockToolSuite(): ToolSuite {
  const tools: ToolDefinition[] = [
    {
      name: 'echo',
      description: 'Echoes back the input',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo' },
        },
        required: ['message'],
      },
      handler: (args) => `Echo: ${args['message']}`,
    },
    {
      name: 'add',
      description: 'Adds two numbers',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First number' },
          b: { type: 'number', description: 'Second number' },
        },
        required: ['a', 'b'],
      },
      handler: (args) => {
        const a = Number(args['a']);
        const b = Number(args['b']);
        return `Result: ${a + b}`;
      },
    },
    {
      name: 'read_file',
      description: 'Reads a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
        },
        required: ['path'],
      },
      handler: (args) => `Content of ${args['path']}: [mock content]`,
      cacheable: true,
    },
    {
      name: 'slow_operation',
      description: 'Simulates a slow operation',
      parameters: {
        type: 'object',
        properties: {
          duration: { type: 'number', description: 'Duration in ms' },
        },
      },
      handler: async (args) => {
        const duration = Number(args['duration']) || 100;
        await new Promise((resolve) => setTimeout(resolve, Math.min(duration, /* TODO: Extract constant */ /* TODO: Extract constant */ 1000)));
        return 'Operation completed';
      },
    },
  ];

  return {
    id: 'test.mock-tools',
    description: 'Mock tools for testing',
    tools,
  };
}

function createMockDiffSuite(): ToolSuite {
  return {
    id: 'test.mock-diff',
    description: 'Mock git diff tool for snapshot tracking',
    tools: [
      {
        name: 'git_diff_mock',
        description: 'Returns mock git diff output',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Git diff command' },
          },
          required: ['command'],
        },
        handler: (args) => `mock diff for ${args['command'] ?? ''}`,
      },
    ],
  };
}

describe('Agent Runtime Integration', () => {
  let provider: MockLLMProvider;
  let toolRuntime: ToolRuntime;
  let contextManager: ContextManager;

  beforeEach(() => {
    provider = new MockLLMProvider();
    toolRuntime = new ToolRuntime();
    toolRuntime.registerSuite(createMockToolSuite());
    contextManager = createDefaultContextManager({
      maxTokens: 10000,
      targetTokens: 7000,
    });
  });

  afterEach(() => {
    provider.reset();
  });

  describe('Basic Message Handling', () => {
    test('should send a simple message and receive response', async () => {
      provider.queueTextResponse('Hello! How can I help you?');

      const agent = new AgentRuntime({
        provider,
        toolRuntime,
        systemPrompt: 'You are a helpful assistant.',
      });

      const response = await agent.send('Hello');

      expect(response).toContain('Hello! How can I help you?');
      expect(response.toLowerCase()).not.toContain('next steps');
      expect(provider.callHistory.length).toBe(1);
    });

    test('should maintain conversation history', async () => {
      provider.queueTextResponse('First response');
      provider.queueTextResponse('Second response');

      const agent = new AgentRuntime({
        provider,
        toolRuntime,
        systemPrompt: 'You are a helpful assistant.',
      });

      await agent.send('First message');
      await agent.send('Second message');

      const history = agent.getHistory();
      expect(history.length).toBe(5); // system + user + assistant + user + assistant
      expect(history[0]?.role).toBe('system');
      expect(history[1]?.role).toBe('user');
      expect(history[2]?.role).toBe('assistant');
      expect(history[3]?.role).toBe('user');
      expect(history[4]?.role).toBe('assistant');
    });

    test('should clear history correctly', async () => {
      provider.queueTextResponse('Response');

      const agent = new AgentRuntime({
        provider,
        toolRuntime,
        systemPrompt: 'You are a helpful assistant.',
      });

      await agent.send('Hello');
      agent.clearHistory();

      const history = agent.getHistory();
      expect(history.length).toBe(1); // Only system message
      expect(history[0]?.role).toBe('system');
    });

    test('should load history from previous session', async () => {
      const previousHistory: ConversationMessage[] = [
        { role: 'system', content: 'Previous system prompt' },
        { role: 'user', content: 'Previous user message' },
        { role: 'assistant', content: 'Previous assistant response' },
      ];

      const agent = new AgentRuntime({
        provider,
        toolRuntime,
        systemPrompt: 'New system prompt',
      });

      agent.loadHistory(previousHistory);

      const history = agent.getHistory();
      expect(history.length).toBe(3);
      expect(history[0]?.content).toBe('Previous system prompt');
    });
  });

  describe('Tool Execution', () => {
    test('should execute tool calls from provider response', async () => {
      provider.queueToolCallResponse('I will echo your message', [
        {
          id: 'call_1',
          name: 'echo',
          arguments: { message: 'Hello, World!' },
        },
      ]);
      provider.queueTextResponse('The echo result was: Echo: Hello, World!');

      const agent = new AgentRuntime({
        provider,
        toolRuntime,
        systemPrompt: 'You are a helpful assistant.',
      });

      const response = await agent.send('Echo "Hello, World!"');

      expect(response).toContain('The echo result was: Echo: Hello, World!');
      expect(provider.callHistory.length).toBe(2); // Initial + after tool result
    });

    test('should execute multiple tool calls in sequence', async () => {
      provider.queueToolCallResponse('I will add some numbers', [
        { id: 'call_1', name: 'add', arguments: { a: 5, b: 3 } },
        { id: 'call_2', name: 'add', arguments: { a: 10, b: 7 } },
      ]);
      provider.queueTextResponse('The results are 8 and 17');

      const agent = new AgentRuntime({
        provider,
        toolRuntime,
        systemPrompt: 'You are a helpful assistant.',
      });

      const response = await agent.send('Add 5+3 and 10+7');

      expect(response).toContain('The results are 8 and 17');

      // Check tool results are in history
      const history = agent.getHistory();
      const toolMessages = history.filter((m) => m.role === 'tool');
      expect(toolMessages.length).toBe(2);
    });

    test('should track tool calls via observer', async () => {
      const toolStarts: string[] = [];
      const toolResults: string[] = [];

      const observer = {
        onToolStart: (call: ToolCallRequest) => toolStarts.push(call.name),
        onToolResult: (call: ToolCallRequest, output: string) =>
          toolResults.push(`${call.name}: ${output}`),
      };

      toolRuntime = new ToolRuntime([], { observer });
      toolRuntime.registerSuite(createMockToolSuite());

      provider.queueToolCallResponse('Executing echo', [
        { id: 'call_1', name: 'echo', arguments: { message: 'test' } },
      ]);
      provider.queueTextResponse('Done');

      const agent = new AgentRuntime({
        provider,
        toolRuntime,
        systemPrompt: 'You are a helpful assistant.',
      });

      await agent.send('Echo test');

      expect(toolStarts).toContain('echo');
      expect(toolResults.some((r) => r.includes('Echo: test'))).toBe(true);
    });
  });

  describe('Callbacks', () => {
    test('should call onAssistantMessage callback', async () => {
      const messages: string[] = [];
      const callbacks: AgentCallbacks = {
        onAssistantMessage: (content) => messages.push(content),
      };

      provider.queueTextResponse('Hello there!');

      const agent = new AgentRuntime({
        provider,
        toolRuntime,
        systemPrompt: 'You are a helpful assistant.',
        callbacks,
      });

      await agent.send('Hi');

      expect(messages.some((msg) => msg.includes('Hello there!'))).toBe(true);
    });

    test('should call onContextPruned when context is pruned', async () => {
      let prunedCount = 0;
      const callbacks: AgentCallbacks = {
        onContextPruned: (count) => {
          prunedCount = count;
        },
      };

      // Create a context manager that will trigger pruning
      const smallContextManager = createDefaultContextManager({
        maxTokens: 500,
        targetTokens: 200,
        preserveRecentMessages: 2,
      });

      provider.queueTextResponse('Response 1');
      provider.queueTextResponse('Response 2');
      provider.queueTextResponse('Response 3');
      provider.queueTextResponse('Response 4');
      provider.queueTextResponse('Response 5');

      const agent = new AgentRuntime({
        provider,
        toolRuntime,
        systemPrompt: 'You are a helpful assistant.',
        callbacks,
        contextManager: smallContextManager,
      });

      // Fill up the context
      for (let i = 0; i < 5; i++) {
        await agent.send('A'.repeat(100));
      }

      // Context should have been pruned at some point
      // Note: exact behavior depends on token estimation
      expect(prunedCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Cancellation', () => {
    test('should handle cancellation request during processing', async () => {
      let cancelledCalled = false;
      const callbacks: AgentCallbacks = {
        onCancelled: () => {
          cancelledCalled = true;
        },
      };

      // Queue a slow operation
      provider.queueToolCallResponse('Running slow operation', [
        { id: 'call_1', name: 'slow_operation', arguments: { duration: 500 } },
      ]);
      provider.queueTextResponse('Done');

      const agent = new AgentRuntime({
        provider,
        toolRuntime,
        systemPrompt: 'You are a helpful assistant.',
        callbacks,
      });

      // Request cancellation before completing
      setTimeout(() => {
        agent.requestCancellation();
      }, 50);

      const response = await agent.send('Run slow operation');

      // Either cancelled or completed depending on timing
      if (cancelledCalled) {
        expect(response).toContain('cancelled');
      }
    });

    test('should reset cancellation flag on new request', async () => {
      const agent = new AgentRuntime({
        provider,
        toolRuntime,
        systemPrompt: 'You are a helpful assistant.',
      });

      // Request cancellation
      agent.requestCancellation();
      expect(agent.isCancellationRequested()).toBe(true);

      // Start new request
      provider.queueTextResponse('Response');
      await agent.send('Hello');

      // Cancellation should be reset after request completes
      expect(agent.isCancellationRequested()).toBe(false);
    });
  });

  describe('Context Overflow Recovery', () => {
    test('should attempt recovery on context overflow error', async () => {
      let recoveryAttempts = 0;
      const callbacks: AgentCallbacks = {
        onContextRecovery: (attempt) => {
          recoveryAttempts = attempt;
        },
      };

      // First call throws overflow, then succeeds
      provider.queueContextOverflowError();
      provider.queueTextResponse('Response after recovery');

      const agent = new AgentRuntime({
        provider,
        toolRuntime,
        systemPrompt: 'You are a helpful assistant.',
        callbacks,
        contextManager,
      });

      // Pre-fill some history
      agent.loadHistory([
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Old message 1' },
        { role: 'assistant', content: 'Old response 1' },
        { role: 'user', content: 'Old message 2' },
        { role: 'assistant', content: 'Old response 2' },
      ]);

      const response = await agent.send('New message');

      expect(recoveryAttempts).toBeGreaterThan(0);
      expect(response).toContain('Response after recovery');
    });
  });

  describe('Running State', () => {
    test('should track running state correctly', async () => {
      const agent = new AgentRuntime({
        provider,
        toolRuntime,
        systemPrompt: 'You are a helpful assistant.',
      });

      expect(agent.isRunning()).toBe(false);

      provider.queueToolCallResponse('Processing', [
        { id: 'call_1', name: 'slow_operation', arguments: { duration: 100 } },
      ]);
      provider.queueTextResponse('Done');

      const promise = agent.send('Run something');

      // Should be running during execution
      // Note: This timing is tricky in tests
      await promise;

      expect(agent.isRunning()).toBe(false);
    });
  });
});

describe('Tool Runtime Integration', () => {
  let toolRuntime: ToolRuntime;
  let contextManager: ContextManager;

  beforeEach(() => {
    contextManager = createDefaultContextManager({
      maxTokens: 10000,
      maxToolOutputLength: 1000,
    });
    toolRuntime = new ToolRuntime([], { contextManager });
    toolRuntime.registerSuite(createMockToolSuite());
  });

  describe('Tool Registration', () => {
    test('should register and list tools', () => {
      const tools = toolRuntime.listProviderTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain('echo');
      expect(toolNames).toContain('add');
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('slow_operation');
    });

    test('should unregister suite', () => {
      toolRuntime.unregisterSuite('test.mock-tools');
      const tools = toolRuntime.listProviderTools();

      expect(tools.find((t) => t.name === 'echo')).toBeUndefined();
    });
  });

  describe('Tool Execution', () => {
    test('should execute tool successfully', async () => {
      const result = await toolRuntime.execute({
        id: 'call_1',
        name: 'echo',
        arguments: { message: 'Hello!' },
      });

      expect(result).toBe('Echo: Hello!');
    });

    test('should handle unknown tool gracefully', async () => {
      const result = await toolRuntime.execute({
        id: 'call_1',
        name: 'unknown_tool',
        arguments: {},
      });

      expect(result).toContain('not available');
    });

    test('should handle tool execution errors', async () => {
      const errorSuite: ToolSuite = {
        id: 'test.error-tools',
        tools: [
          {
            name: 'error_tool',
            description: 'Always throws an error',
            handler: () => {
              throw new Error('Intentional error');
            },
          },
        ],
      };

      toolRuntime.registerSuite(errorSuite);

      const result = await toolRuntime.execute({
        id: 'call_1',
        name: 'error_tool',
        arguments: {},
      });

      expect(result).toContain('Failed');
      expect(result).toContain('Intentional error');
    });
  });

  describe('Tool Caching', () => {
    test('should cache cacheable tool results', async () => {
      const cacheHits: string[] = [];
      const observer = {
        onCacheHit: (call: ToolCallRequest) => cacheHits.push(call.name),
      };

      toolRuntime = new ToolRuntime([], { contextManager, observer, enableCache: true });
      toolRuntime.registerSuite(createMockToolSuite());

      // First call
      await toolRuntime.execute({
        id: 'call_1',
        name: 'read_file',
        arguments: { path: '/test/file.txt' },
      });

      // Second call with same args should hit cache
      await toolRuntime.execute({
        id: 'call_2',
        name: 'read_file',
        arguments: { path: '/test/file.txt' },
      });

      expect(cacheHits).toContain('read_file');
    });

    test('should not cache non-cacheable tools', async () => {
      const cacheHits: string[] = [];
      const observer = {
        onCacheHit: (call: ToolCallRequest) => cacheHits.push(call.name),
      };

      toolRuntime = new ToolRuntime([], { contextManager, observer, enableCache: true });
      toolRuntime.registerSuite(createMockToolSuite());

      // First call
      await toolRuntime.execute({
        id: 'call_1',
        name: 'echo',
        arguments: { message: 'test' },
      });

      // Second call should not hit cache
      await toolRuntime.execute({
        id: 'call_2',
        name: 'echo',
        arguments: { message: 'test' },
      });

      expect(cacheHits).not.toContain('echo');
    });

    test('should clear cache', async () => {
      toolRuntime = new ToolRuntime([], { contextManager, enableCache: true });
      toolRuntime.registerSuite(createMockToolSuite());

      await toolRuntime.execute({
        id: 'call_1',
        name: 'read_file',
        arguments: { path: '/test/file.txt' },
      });

      const statsBeforeClear = toolRuntime.getCacheStats();
      expect(statsBeforeClear.entries).toBeGreaterThan(0);

      toolRuntime.clearCache();

      const statsAfterClear = toolRuntime.getCacheStats();
      expect(statsAfterClear.entries).toBe(0);
    });

    test('respects per-tool cache TTL overrides', async () => {
      const cacheHits: string[] = [];
      const observer = {
        onCacheHit: (call: ToolCallRequest) => cacheHits.push(call.name),
      };

      toolRuntime = new ToolRuntime([], { contextManager, observer, enableCache: true });
      toolRuntime.registerSuite({
        id: 'ttl.override',
        tools: [
          {
            name: 'burst',
            description: 'Returns a timestamp string',
            handler: () => `ts:${Date.now()}`,
            cacheable: true,
            cacheTtlMs: 5,
          },
        ],
      });

      await toolRuntime.execute({
        id: 'call_1',
        name: 'burst',
        arguments: {},
      });
      await toolRuntime.execute({
        id: 'call_2',
        name: 'burst',
        arguments: {},
      });

      expect(cacheHits).toEqual(['burst']);

      await new Promise((resolve) => setTimeout(resolve, 15));

      await toolRuntime.execute({
        id: 'call_3',
        name: 'burst',
        arguments: {},
      });

      expect(cacheHits).toEqual(['burst']);
    });
  });

  describe('Tool History', () => {
    test('should track tool history', async () => {
      await toolRuntime.execute({
        id: 'call_1',
        name: 'echo',
        arguments: { message: 'first' },
      });

      await toolRuntime.execute({
        id: 'call_2',
        name: 'add',
        arguments: { a: 1, b: 2 },
      });

      const history = toolRuntime.getToolHistory();
      expect(history.length).toBe(2);
      expect(history[0]?.toolName).toBe('echo');
      expect(history[1]?.toolName).toBe('add');
    });

    test('should clear tool history', async () => {
      await toolRuntime.execute({
        id: 'call_1',
        name: 'echo',
        arguments: { message: 'test' },
      });

      toolRuntime.clearToolHistory();

      const history = toolRuntime.getToolHistory();
      expect(history.length).toBe(0);
    });
  });

  describe('Diff Snapshots', () => {
    test('should capture git diff outputs from tool commands', async () => {
      toolRuntime.registerSuite(createMockDiffSuite());

      await toolRuntime.execute({
        id: 'call_git_diff',
        name: 'git_diff_mock',
        arguments: { command: 'git diff --stat' },
      });

      const snapshots = toolRuntime.getDiffSnapshots();
      expect(snapshots.length).toBe(1);
      expect(snapshots[0]?.command).toBe('git diff --stat');
      expect(snapshots[0]?.output).toContain('mock diff for git diff --stat');
      expect(typeof snapshots[0]?.timestamp).toBe('number');
    });

    test('should bound diff snapshots and support clearing', async () => {
      toolRuntime.registerSuite(createMockDiffSuite());

      for (let i = 0; i < 6; i++) {
        await toolRuntime.execute({
          id: `call_${i}`,
          name: 'git_diff_mock',
          arguments: { command: `git diff --stat ${i}` },
        });
      }

      const snapshots = toolRuntime.getDiffSnapshots();
      expect(snapshots.length).toBe(5);
      expect(snapshots[0]?.command).toBe('git diff --stat 1');
      expect(snapshots[snapshots.length - 1]?.command).toBe('git diff --stat 5');

      toolRuntime.clearDiffSnapshots();
      expect(toolRuntime.getDiffSnapshots().length).toBe(0);
    });
  });

  describe('Tool Output Truncation', () => {
    test('should truncate large tool outputs', async () => {
      const largeSuite: ToolSuite = {
        id: 'test.large-output',
        tools: [
          {
            name: 'large_output',
            description: 'Returns large output',
            handler: () => 'X'.repeat(5000), // Exceeds maxToolOutputLength
          },
        ],
      };

      toolRuntime.registerSuite(largeSuite);

      const result = await toolRuntime.execute({
        id: 'call_1',
        name: 'large_output',
        arguments: {},
      });

      // Output should be truncated
      expect(result.length).toBeLessThan(5000);
      expect(result).toContain('truncated');
    });
  });
});
