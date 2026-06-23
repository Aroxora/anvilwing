/**
 * Context-usage math for the /context view and the "% context left" chrome
 * indicator. Pure + deterministic so it's testable without a model round-trip.
 *
 * `usedTokens` prefers the provider's REAL last-request input-token count
 * (exactly what occupies the context window); when that's unavailable (no turn
 * yet) it falls back to a char/4 estimate over the message array — flagged via
 * `estimated` so the UI can hedge ("~"). Token breakdown by category is always
 * estimated (the provider only reports a single input total).
 */

import type { ConversationMessage } from './types.js';

const CHARS_PER_TOKEN = 4;

export interface ContextUsage {
  windowTokens: number;
  usedTokens: number;
  freeTokens: number;
  percentUsed: number;
  percentLeft: number;
  systemTokens: number;
  conversationTokens: number;
  messageCount: number;
  /** true when usedTokens is a char/4 estimate (no real input-token count yet) */
  estimated: boolean;
}

export function estimateMessageTokens(message: ConversationMessage): number {
  let chars = 0;
  if (message.content) {
    chars += message.content.length;
  }
  if (message.role === 'assistant' && message.toolCalls) {
    for (const call of message.toolCalls) {
      chars += call.name.length;
      chars += JSON.stringify(call.arguments ?? {}).length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function computeContextUsage(
  messages: ConversationMessage[],
  windowTokens: number,
  actualInputTokens?: number | null,
): ContextUsage {
  const list = Array.isArray(messages) ? messages : [];
  const window = windowTokens > 0 ? windowTokens : 1;

  let systemTokens = 0;
  let conversationTokens = 0;
  let messageCount = 0;
  for (const m of list) {
    const t = estimateMessageTokens(m);
    if (m.role === 'system') {
      systemTokens += t;
    } else {
      conversationTokens += t;
      messageCount += 1;
    }
  }
  const estimatedTotal = systemTokens + conversationTokens;

  const hasReal = typeof actualInputTokens === 'number' && actualInputTokens > 0;
  const usedTokens = Math.min(window, hasReal ? actualInputTokens! : estimatedTotal);
  const freeTokens = Math.max(0, window - usedTokens);
  const percentUsed = Math.min(100, Math.round((usedTokens / window) * 100));

  return {
    windowTokens: window,
    usedTokens,
    freeTokens,
    percentUsed,
    percentLeft: Math.max(0, 100 - percentUsed),
    systemTokens,
    conversationTokens,
    messageCount,
    estimated: !hasReal,
  };
}

/** "131,072" → grouped thousands for display. */
export function formatTokenCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
