import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRuntime } from '../src/core/toolRuntime.js';
import type { ToolDefinition } from '../src/core/toolRuntime.js';

describe('test/toolSuites.test.ts', () => {
  it('ToolRuntime validates tool definitions', () => {
    const validTools: ToolDefinition[] = [
      {
        name: 'test_tool',
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string' }
          },
          required: ['input']
        },
        handler: async () => 'test result'
      }
    ];

    const runtime = new ToolRuntime(validTools);
    const providerTools = runtime.listProviderTools();
    assert.equal(providerTools.length, 1);
    const [tool] = providerTools;
    assert.ok(tool);
    assert.equal(tool.name, 'test_tool');
  });

  it('ToolRuntime rejects duplicate tool names', () => {
    const duplicateTools: ToolDefinition[] = [
      {
        name: 'duplicate_tool',
        description: 'First tool',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: async () => 'first'
      },
      {
        name: 'duplicate_tool',
        description: 'Second tool',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: async () => 'second'
      }
    ];

    assert.throws(() => {
      new ToolRuntime(duplicateTools);
    }, /already registered/);
  });

  it('ToolRuntime executes tools correctly', async () => {
    const testTools: ToolDefinition[] = [
      {
        name: 'echo_tool',
        description: 'Echoes input',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string' }
          },
          required: ['message']
        },
        handler: async (args: Record<string, unknown>) => {
          const message = typeof args['message'] === 'string' ? args['message'] : '';
          return `Echo: ${message}`;
        }
      }
    ];

    const runtime = new ToolRuntime(testTools);
    const result = await runtime.execute({
      id: 'call-1',
      name: 'echo_tool',
      arguments: { message: 'hello world' }
    });
    
    assert.equal(result, 'Echo: hello world');
  });

  it('ToolRuntime normalizes tool call arguments from strings and maps', async () => {
    const tools: ToolDefinition[] = [
      {
        name: 'echo_tool',
        description: 'Echoes input',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string' }
          },
          required: ['message']
        },
        handler: async (args: Record<string, unknown>) => {
          const message = typeof args['message'] === 'string' ? args['message'] : '';
          return `Echo: ${message}`;
        }
      }
    ];

    const runtime = new ToolRuntime(tools);

    const stringArgs = JSON.stringify({ message: 'from string' });
    const stringResult = await runtime.execute({
      id: 'call-string',
      name: 'echo_tool',
      arguments: stringArgs as unknown as Record<string, unknown>
    });
    assert.equal(stringResult, 'Echo: from string');

    const mapArgs = new Map<string, unknown>([['message', 'from map']]);
    const mapResult = await runtime.execute({
      id: 'call-map',
      name: 'echo_tool',
      arguments: mapArgs as unknown as Record<string, unknown>
    });
    assert.equal(mapResult, 'Echo: from map');
  });
});