import { describe, expect, it } from '@jest/globals';

/**
 * Test the message sanitization logic that prevents orphaned tool messages.
 * This replicates the sanitizeMessageSequence function logic for testing.
 */

interface TestMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; name: string }[];
  toolCallId?: string;
}

function sanitizeMessageSequence(messages: TestMessage[]): TestMessage[] {
  const sanitized: TestMessage[] = [];
  const pendingToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      for (const tc of message.toolCalls) {
        if (tc.id) pendingToolCallIds.add(tc.id);
      }
      sanitized.push(message);
    } else if (message.role === 'tool') {
      const toolCallId = message.toolCallId;
      if (toolCallId && pendingToolCallIds.has(toolCallId)) {
        pendingToolCallIds.delete(toolCallId);
        sanitized.push(message);
      }
      // Orphaned tool messages are silently skipped
    } else {
      if (message.role === 'user') {
        pendingToolCallIds.clear();
      }
      sanitized.push(message);
    }
  }

  return sanitized;
}

describe('Message Sanitization - Orphaned Tool Messages', () => {
  it('preserves valid tool message sequences', () => {
    const messages: TestMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file' }] },
      { role: 'tool', content: 'file contents', toolCallId: 'call_1' },
      { role: 'assistant', content: 'Done' },
    ];

    const sanitized = sanitizeMessageSequence(messages);
    expect(sanitized).toHaveLength(4);
    expect(sanitized.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('removes orphaned tool messages without preceding tool_calls', () => {
    const messages: TestMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'tool', content: 'orphaned result', toolCallId: 'call_orphan' }, // No preceding assistant with tool_calls
      { role: 'assistant', content: 'Response' },
    ];

    const sanitized = sanitizeMessageSequence(messages);
    expect(sanitized).toHaveLength(2);
    expect(sanitized.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(sanitized.find(m => m.role === 'tool')).toBeUndefined();
  });

  it('removes tool messages with mismatched IDs', () => {
    const messages: TestMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file' }] },
      { role: 'tool', content: 'wrong id', toolCallId: 'call_DIFFERENT' }, // Wrong ID
      { role: 'tool', content: 'correct', toolCallId: 'call_1' }, // Correct ID
    ];

    const sanitized = sanitizeMessageSequence(messages);
    expect(sanitized).toHaveLength(3);
    expect(sanitized[2]?.content).toBe('correct');
  });

  it('handles multiple tool calls and responses', () => {
    const messages: TestMessage[] = [
      { role: 'user', content: 'Run two commands' },
      { role: 'assistant', content: '', toolCalls: [
        { id: 'call_1', name: 'cmd1' },
        { id: 'call_2', name: 'cmd2' },
      ]},
      { role: 'tool', content: 'result 1', toolCallId: 'call_1' },
      { role: 'tool', content: 'result 2', toolCallId: 'call_2' },
      { role: 'assistant', content: 'Both done' },
    ];

    const sanitized = sanitizeMessageSequence(messages);
    expect(sanitized).toHaveLength(5);
  });

  it('clears pending tool calls on new user message', () => {
    const messages: TestMessage[] = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'search' }] },
      // Missing tool response - context was compacted
      { role: 'user', content: 'New question' }, // New turn clears pending
      { role: 'tool', content: 'orphaned from old turn', toolCallId: 'call_1' }, // Should be skipped
      { role: 'assistant', content: 'Answer' },
    ];

    const sanitized = sanitizeMessageSequence(messages);
    expect(sanitized).toHaveLength(4);
    expect(sanitized.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('handles empty messages array', () => {
    const sanitized = sanitizeMessageSequence([]);
    expect(sanitized).toHaveLength(0);
  });

  it('preserves system messages', () => {
    const messages: TestMessage[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];

    const sanitized = sanitizeMessageSequence(messages);
    expect(sanitized).toHaveLength(3);
    expect(sanitized[0]?.role).toBe('system');
  });

  it('handles context compaction scenario - tool message after compaction', () => {
    // Simulates what happens after context compaction removes the assistant message
    // but leaves the tool response
    const messages: TestMessage[] = [
      { role: 'system', content: 'Context summary...' },
      { role: 'tool', content: 'Result from compacted turn', toolCallId: 'old_call' },
      { role: 'user', content: 'Continue' },
      { role: 'assistant', content: 'OK' },
    ];

    const sanitized = sanitizeMessageSequence(messages);
    expect(sanitized).toHaveLength(3);
    expect(sanitized.find(m => m.role === 'tool')).toBeUndefined();
  });
});
