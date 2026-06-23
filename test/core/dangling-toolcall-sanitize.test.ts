/**
 * Long-horizon hard-failure guard (the reverse direction).
 *
 * sanitizeMessageSequence() is the LAST line of defense before a request is
 * mapped to OpenAI/Anvilwing params. It already drops orphaned `tool` messages
 * (a tool reply whose tool_call was pruned away). But the API rejects the
 * MIRROR-IMAGE defect just as hard:
 *
 *   "An assistant message with 'tool_calls' must be followed by tool messages
 *    responding to each 'tool_call_id'."
 *
 * That state is reachable in normal use: a parallel tool call where one tool is
 * interrupted (Esc) or crashes before recording its result, or a session
 * snapshotted mid-tool-execution and resumed. If the dangling tool_call reaches
 * the provider, the NEXT request 400s and the long run dies and cannot recover
 * (every retry resends the same dangling call).
 *
 * These tests drive the REAL exported sanitizer (not a mirror) and assert the
 * full bidirectional pairing invariant holds on its output.
 */

import { describe, expect, test } from '@jest/globals';
import { sanitizeMessageSequence } from '../../src/providers/openaiChatCompletionsProvider.js';
import type { ConversationMessage } from '../../src/core/contextManager.js';

type Msg = ConversationMessage & {
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>;
};

/** The exact invariant the Anvilwing/OpenAI API enforces, asserted over a list. */
function assertValidForApi(messages: Msg[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const want = new Set(m.toolCalls.map((c) => c.id));
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === 'tool') {
        want.delete(messages[j]!.toolCallId ?? '');
        j++;
      }
      if (want.size > 0) {
        throw new Error(`assistant @${i} has tool_calls with no result: ${[...want].join(',')} — API would 400`);
      }
    }
    if (m.role === 'tool') {
      let j = i - 1;
      while (j >= 0 && messages[j]!.role === 'tool') j--;
      const anchor = j >= 0 ? messages[j]! : null;
      const ok = Boolean(anchor && anchor.role === 'assistant' && (anchor.toolCalls ?? []).some((c) => c.id === m.toolCallId));
      if (!ok) throw new Error(`orphaned tool @${i} (id=${m.toolCallId}) — API would 400`);
    }
  }
}

describe('sanitizeMessageSequence — dangling assistant tool_calls (the interrupt/crash case)', () => {
  test('a parallel call where ONE result is missing is repaired (was shipped dangling → 400)', () => {
    const history: Msg[] = [
      { role: 'user', content: 'do two things' },
      {
        role: 'assistant', content: 'on it',
        toolCalls: [
          { id: 'a', name: 'Read', arguments: { path: 'x' } },
          { id: 'b', name: 'Bash', arguments: { command: 'sleep' } }, // interrupted before result
        ],
      },
      { role: 'tool', content: 'file body', toolCallId: 'a' },
      // no tool result for 'b'
      { role: 'user', content: 'next' },
    ];
    const out = sanitizeMessageSequence(history) as Msg[];
    assertValidForApi(out); // fails before the fix: 'b' dangles
    // the assistant + its real result survive; the missing one is backfilled, not dropped
    expect(out.find((m) => m.role === 'tool' && m.toolCallId === 'a')).toBeTruthy();
    expect(out.find((m) => m.role === 'tool' && m.toolCallId === 'b')).toBeTruthy();
  });

  test('an assistant whose tool_call has NO results at all (trailing interrupted turn) is repaired', () => {
    const history: Msg[] = [
      { role: 'user', content: 'grep the repo' },
      { role: 'assistant', content: 'searching', toolCalls: [{ id: 't1', name: 'Grep', arguments: { pattern: 'x' } }] },
      // run was cancelled right here — no tool result, no further messages
    ];
    const out = sanitizeMessageSequence(history) as Msg[];
    assertValidForApi(out);
  });

  test('still drops orphaned tool messages (the original direction is unbroken)', () => {
    const history: Msg[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'orphan', toolCallId: 'gone' }, // no preceding tool_calls
      { role: 'assistant', content: 'hello' },
    ];
    const out = sanitizeMessageSequence(history) as Msg[];
    assertValidForApi(out);
    expect(out.find((m) => m.role === 'tool')).toBeUndefined();
  });

  test('valid sequences pass through untouched (no spurious backfill)', () => {
    const history: Msg[] = [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', arguments: {} }] },
      { role: 'tool', content: 'contents', toolCallId: 'c1' },
      { role: 'assistant', content: 'done' },
    ];
    const out = sanitizeMessageSequence(history) as Msg[];
    assertValidForApi(out);
    expect(out).toHaveLength(4);
  });

  test('source guard: the real sanitizer backfills missing results, not just drops orphans', () => {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'providers', 'openaiChatCompletionsProvider.ts'), 'utf8');
    // both directions must be present in the real function
    expect(src).toMatch(/Skipping orphaned tool message/); // orphan-tool direction
    expect(src).toMatch(/No result|Interrupted|backfill/i); // dangling-assistant direction
  });
});
