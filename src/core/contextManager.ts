/**
 * ContextManager - Manages conversation context to prevent token limit leaks
 *
 * Responsibilities:
 * - Truncate tool outputs intelligently
 * - Prune old conversation history with LLM summarization
 * - Track and estimate token usage
 * - Keep conversation within budget based on model context windows
 * - Proactively shrink context before hitting limits
 */

import type { ConversationMessage } from './types.js';
import { calculateContextThresholds } from './contextWindow.js';

/**
 * Callback for LLM-based summarization of conversation history
 * Takes messages to summarize and returns a concise summary string
 */
export type SummarizationCallback = (
  messages: ConversationMessage[]
) => Promise<string>;



/**
 * Summarization prompt template
 */
export const SUMMARIZATION_PROMPT = `Create a compact but reliable summary of the earlier conversation.

Keep:
- Decisions, preferences, and open questions
- File paths, function/class names, APIs, and error messages with fixes
- What was completed vs. still pending (tests, TODOs)

Format:
## Key Context
- ...
## Work Completed
- ...
## Open Items
- ...

Conversation:
{conversation}`;

export interface ContextManagerConfig {
  maxTokens: number; // Maximum tokens allowed in conversation
  targetTokens: number; // Target to stay under (70% of max - triggers pruning)
  warningTokens?: number; // Show warning threshold (60% of max)
  criticalTokens?: number; // Critical warning threshold (85% of max)
  maxToolOutputLength: number; // Max characters for tool outputs
  preserveRecentMessages: number; // Number of recent exchanges to always keep
  estimatedCharsPerToken: number; // Rough estimation (usually ~4 for English)
  useLLMSummarization?: boolean; // Whether to use LLM-based summarization (default: true if callback provided)
  summarizationCallback?: SummarizationCallback; // Optional LLM summarization callback
  model?: string; // Current model name for context window lookup
}

export interface TruncationResult {
  content: string;
  wasTruncated: boolean;
  originalLength: number;
  truncatedLength: number;
}

export class ContextManager {
  private config: ContextManagerConfig;

  private sessionStartTime: number = Date.now();
  private toolCallHistory: string[] = [];

  constructor(config: Partial<ContextManagerConfig> = {}) {
    this.config = {
      // CONSERVATIVE fallbacks for bare construction (tests, ad-hoc wiring) —
      // deliberately small so an unknown model can never overflow. Production
      // always sizes from the model via createDefaultContextManager(), which
      // derives from the MODEL_CONTEXT_WINDOWS table (anvilwing: 2^20).
      // Do NOT read these numbers as the product model's window.
      maxTokens: 130000,
      targetTokens: 100000,
      maxToolOutputLength: 10000,
      preserveRecentMessages: 10,
      estimatedCharsPerToken: 4,
      ...config,
    };
  }

  /**
   * Record a tool call for context-aware summarization
   */
  recordToolCall(toolName: string): void {
    this.toolCallHistory.push(toolName);
    // Keep only recent history
    if (this.toolCallHistory.length > 50) {
      this.toolCallHistory.shift();
    }
  }

  /**
   * Truncate tool output intelligently using the smart summarizer
   */
  truncateToolOutput(output: string, toolName: string, _args?: Record<string, unknown>): TruncationResult {
    const originalLength = output.length;

    // First check if we even need to truncate
    if (originalLength <= this.config.maxToolOutputLength) {
      return {
        content: output,
        wasTruncated: false,
        originalLength,
        truncatedLength: originalLength,
      };
    }

    // Intelligent truncation based on tool type
    const truncated = this.intelligentTruncate(output, toolName);
    const truncatedLength = truncated.length;

    return {
      content: truncated,
      wasTruncated: true,
      originalLength,
      truncatedLength,
    };
  }

  /**
   * Intelligent truncation based on tool type
   */
  private intelligentTruncate(output: string, toolName: string): string {
    const maxLength = this.config.maxToolOutputLength;

    // For file reads, show beginning and end. read_files concatenates several
    // files in order, so head-only truncation drops the LAST files the agent
    // explicitly asked for — head+tail keeps the later ones visible too.
    if (toolName === 'Read' || toolName === 'read_file' || toolName === 'read_files') {
      return this.truncateFileOutput(output, maxLength);
    }

    // For search results, keep first N results
    if (toolName === 'Grep' || toolName === 'grep_search' || toolName === 'Glob') {
      return this.truncateSearchOutput(output, maxLength);
    }

    // For bash/command output, keep end (usually most relevant). BashOutput
    // (polling a background shell) is command output too — its tail holds the
    // recent line that matters (compile error, crash, "ready on :3000", exit
    // status); head-only truncation would show stale startup noise and drop it.
    if (toolName === 'Bash' || toolName === 'bash' || toolName === 'execute_bash' || toolName === 'BashOutput') {
      return this.truncateBashOutput(output, maxLength);
    }

    // Default: show beginning with truncation notice
    return this.truncateDefault(output, maxLength);
  }

  private truncateFileOutput(output: string, maxLength: number): string {
    const lines = output.split('\n');
    // keepLines is a ~100-chars/line estimate; head+tail would meet or overlap
    // (duplicating lines, negative "truncated" count) once lines.length is at or
    // below 2× the budget, so fall back to a char-bounded cut there and for small
    // files.
    const keepLines = Math.floor(maxLength / 100); // Rough estimate
    if (lines.length <= 100 || lines.length <= keepLines * 2) {
      return this.truncateDefault(output, maxLength);
    }

    // Show first and last keepLines lines.
    const headLines = lines.slice(0, keepLines);
    const tailLines = lines.slice(-keepLines);

    const truncatedCount = lines.length - (keepLines * 2);

    const result = [
      ...headLines,
      `\n... [${truncatedCount} lines truncated for context management] ...\n`,
      ...tailLines,
    ].join('\n');
    // The ~100-chars/line estimate undercounts long lines, so the head+tail can
    // still blow past maxLength (maxToolOutputLength). Enforce the documented
    // char bound rather than overflow it.
    return result.length <= maxLength ? result : this.truncateDefault(output, maxLength);
  }

  private truncateSearchOutput(output: string, maxLength: number): string {
    const lines = output.split('\n');
    const keepLines = Math.floor(maxLength / 80); // Rough average line length

    if (lines.length <= keepLines) {
      // Few lines but possibly very long ones — the caller already decided this
      // overflows the cap, so enforce the char bound instead of returning it whole.
      return output.length <= maxLength ? output : this.truncateDefault(output, maxLength);
    }

    const truncatedCount = lines.length - keepLines;
    const result = [
      ...lines.slice(0, keepLines),
      `\n... [${truncatedCount} more results truncated for context management] ...`,
    ].join('\n');
    // The /80-chars estimate undercounts long lines; guarantee the char bound.
    return result.length <= maxLength ? result : this.truncateDefault(output, maxLength);
  }

  private truncateBashOutput(output: string, maxLength: number): string {
    if (output.length <= maxLength) {
      return output;
    }

    // For command output, the end is usually most important (errors, final status)
    const keepChars = Math.floor(maxLength * 0.8); // 80% at end
    const prefixChars = maxLength - keepChars - 100; // Small prefix

    const prefix = output.slice(0, prefixChars);
    const suffix = output.slice(-keepChars);
    const truncatedChars = output.length - prefixChars - keepChars;

    return `${prefix}\n\n... [${truncatedChars} characters truncated for context management] ...\n\n${suffix}`;
  }

  private truncateDefault(output: string, maxLength: number): string {
    if (output.length <= maxLength) {
      return output;
    }

    const truncatedChars = output.length - maxLength + 100; // Account for notice
    return `${output.slice(0, maxLength - 100)}\n\n... [${truncatedChars} characters truncated for context management] ...`;
  }

  /**
   * Estimate tokens in a message
   */
  estimateTokens(message: ConversationMessage): number {
    let charCount = 0;

    if (message.content) {
      charCount += message.content.length;
    }

    if (message.role === 'assistant' && message.toolCalls) {
      // Tool calls add overhead
      for (const call of message.toolCalls) {
        charCount += call.name.length;
        charCount += JSON.stringify(call.arguments).length;
      }
    }

    return Math.ceil(charCount / this.config.estimatedCharsPerToken);
  }


  /**
   * Estimate total tokens in conversation
   */
  estimateTotalTokens(messages: ConversationMessage[]): number {
    return messages.reduce((sum, msg) => sum + this.estimateTokens(msg), 0);
  }

  /**
   * Intra-turn reduction for the tool-heavy single-turn case. Normal pruning
   * keeps whole turns and counts only USER turns, so one request with many tool
   * rounds (one user message, dozens of assistant+tool messages) prunes nothing
   * and can overflow. This shrinks the OLDEST verbose tool-result bodies to a
   * placeholder — never dropping a message (tool_call/result pairing stays
   * intact), never touching the user task, assistant reasoning, or the most
   * recent few messages. Returns the new list and how many bodies were truncated.
   */
  private reduceOversizedHistory(messages: ConversationMessage[]): {
    messages: ConversationMessage[];
    truncated: number;
  } {
    const KEEP_INTACT = 6; // leave the most recent messages untouched
    const MIN_TRUNCATABLE = 400; // only shrink substantial bodies (chars)
    const PLACEHOLDER = '[older tool output truncated to fit the context budget]';

    const out = messages.map((m) => ({ ...m }));
    let total = this.estimateTotalTokens(out);
    let truncated = 0;

    // Collapse an oversized tool RESULT at index i (they hold the bulk — file
    // reads, command output — and are safe to drop; user/assistant text stays).
    const tryTruncate = (i: number): void => {
      const m = out[i];
      if (!m || m.role !== 'tool' || !m.content) return;
      if (m.content.length < MIN_TRUNCATABLE || m.content === PLACEHOLDER) return;
      const before = this.estimateTokens(m);
      m.content = PLACEHOLDER;
      total -= before - this.estimateTokens(m);
      truncated++;
    };

    // Pass 1: oldest-first, leaving the most recent KEEP_INTACT messages intact.
    const editableUpTo = Math.max(0, out.length - KEEP_INTACT);
    for (let i = 0; i < editableUpTo && total >= this.config.targetTokens; i++) {
      tryTruncate(i);
    }

    // Pass 2 (last resort): still over budget because a giant tool output sits
    // inside the protected tail (e.g. a single `[user, assistant, tool(HUGE)]`
    // turn). Collapse those too, oldest-first — but never the very last message.
    for (let i = editableUpTo; i < out.length - 1 && total >= this.config.targetTokens; i++) {
      tryTruncate(i);
    }

    return { messages: out, truncated };
  }

  /**
   * Prune old messages when approaching limit
   *
   * Synchronously removes old messages to stay within budget.
   * If LLM summarization is available and enabled, this method will be async.
   */
  pruneMessages(messages: ConversationMessage[]): {
    pruned: ConversationMessage[];
    removed: number;
  } {
    const totalTokens = this.estimateTotalTokens(messages);

    // Only prune if we're above target
    if (totalTokens < this.config.targetTokens) {
      return { pruned: messages, removed: 0 };
    }

    // Always keep system message (first)
    const firstMessage = messages[0];
    const systemMessage = firstMessage?.role === 'system' ? firstMessage : null;
    const conversationMessages = systemMessage ? messages.slice(1) : messages;

    // Group messages into "turns" to maintain tool call/result pairing
    // A turn is: [user] or [assistant + all its tool results]
    const turns: ConversationMessage[][] = [];
    let currentTurn: ConversationMessage[] = [];

    for (const msg of conversationMessages) {
      if (msg.role === 'user') {
        if (currentTurn.length > 0) {
          turns.push(currentTurn);
        }
        currentTurn = [msg];
      } else if (msg.role === 'assistant') {
        if (currentTurn.length > 0) {
          turns.push(currentTurn);
        }
        currentTurn = [msg];
      } else if (msg.role === 'tool') {
        // Tool results belong with the current assistant turn
        currentTurn.push(msg);
      } else if (msg.role === 'system') {
        // Mid-conversation system messages — a PRIOR compaction summary, a
        // recovery note — must not be silently dropped (the grouping used to
        // have no `system` branch). Attach to the current turn so they travel
        // with it: kept if recent, folded into the next summary if old. The
        // leading base system prompt is handled separately above.
        currentTurn.push(msg);
      }
    }
    if (currentTurn.length > 0) {
      turns.push(currentTurn);
    }

    // Keep recent turns: AT LEAST preserveRecentMessages user exchanges, AND
    // keep extending while the kept set fits a token budget (half the prune
    // target). A fixed 5-exchange keep was tuned for a 131k window — at the
    // real 1M window one compaction could destroy ~595k tokens of history
    // while keeping only 5 small messages. Budget-based retention keeps what
    // the window exists to hold; whatever exceeds the budget still prunes.
    const keepTokenBudget = Math.floor(this.config.targetTokens * 0.5);
    const recentTurns: ConversationMessage[][] = [];
    let exchangeCount = 0;
    let keptTokens = 0;

    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (!turn || turn.length === 0) continue;

      recentTurns.unshift(turn);
      keptTokens += turn.reduce((sum, m) => sum + this.estimateTokens(m), 0);

      // Count user messages as exchanges
      if (turn[0]?.role === 'user') {
        exchangeCount++;
        if (exchangeCount >= this.config.preserveRecentMessages && keptTokens >= keepTokenBudget) {
          break;
        }
      }
    }

    // IMPORTANT: Ensure we don't start with orphaned tool messages
    // The first kept turn must start with user or assistant (not tool)
    let startIndex = 0;
    while (startIndex < recentTurns.length) {
      const firstTurn = recentTurns[startIndex];
      if (firstTurn && firstTurn.length > 0 && firstTurn[0]?.role === 'tool') {
        startIndex++;
        continue;
      }
      // Also check for assistant turns with missing tool results
      if (firstTurn && firstTurn[0]?.role === 'assistant') {
        const assistantMsg = firstTurn[0];
        if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
          // PERF: Pre-compute tool call IDs once, use direct Set lookup
          const toolCallIds = assistantMsg.toolCalls.map(tc => tc.id);
          const presentToolResultIds = new Set(
            firstTurn.filter(m => m.role === 'tool').map(m => (m as { toolCallId?: string }).toolCallId)
          );
          // If NOT all tool calls have results, skip this turn
          // PERF: Direct has() calls instead of spread + every()
          let allPresent = true;
          for (const id of toolCallIds) {
            if (!presentToolResultIds.has(id)) {
              allPresent = false;
              break;
            }
          }
          if (!allPresent) {
            startIndex++;
            continue;
          }
        }
      }
      break;
    }

    const validTurns = recentTurns.slice(startIndex);

    // Flatten turns back to messages
    const recentMessages = validTurns.flat();

    // Build pruned message list
    const pruned: ConversationMessage[] = [];
    if (systemMessage) {
      pruned.push(systemMessage);
    }

    // Add a context summary message if we removed messages
    const removedCount = conversationMessages.length - recentMessages.length;
    if (removedCount > 0) {
      // Audit #21: pin the ORIGINAL TASK. Even the no-LLM simple prune must not
      // lose the goal — without this, a long run that pruned past its first
      // message forgets what it was asked to do and drifts. Restate the first
      // user message (the request) when it's about to be pruned away.
      const firstUser = conversationMessages.find((m) => m.role === 'user');
      const firstUserKept = firstUser && recentMessages.includes(firstUser);
      const originalTask = firstUser && !firstUserKept && typeof firstUser.content === 'string'
        ? ` Original request: "${firstUser.content.slice(0, 400)}"`
        : '';
      pruned.push({
        role: 'system',
        content: `[Context Manager: Removed ${removedCount} old messages to stay within token budget. Recent conversation history preserved.]${originalTask}`,
      });
    }

    pruned.push(...recentMessages);

    // Tool-heavy single-turn fallback: if turn-level pruning removed nothing
    // (only one user turn, so the whole conversation is "recent") but we're
    // still over budget, shrink the oldest verbose tool outputs in place.
    if (removedCount === 0 && this.estimateTotalTokens(pruned) >= this.config.targetTokens) {
      const reduced = this.reduceOversizedHistory(pruned);
      if (reduced.truncated > 0) {
        return { pruned: reduced.messages, removed: reduced.truncated };
      }
    }

    return {
      pruned,
      removed: removedCount,
    };
  }

  /**
   * Prune messages with LLM-based summarization
   *
   * This is an async version that uses the LLM to create intelligent summaries
   * instead of just removing old messages. Should be called BEFORE generation.
   */
  async pruneMessagesWithSummary(
    messages: ConversationMessage[],
    options?: { force?: boolean }
  ): Promise<{
    pruned: ConversationMessage[];
    removed: number;
    summarized: boolean;
  }> {
    const totalTokens = this.estimateTotalTokens(messages);

    // Only prune if we're above target
    if (!options?.force && totalTokens < this.config.targetTokens) {
      return { pruned: messages, removed: 0, summarized: false };
    }

    // If no summarization callback or disabled, fall back to simple pruning
    if (!this.config.summarizationCallback || !this.config.useLLMSummarization) {
      const result = this.pruneMessages(messages);
      return { ...result, summarized: false };
    }

    // Partition messages
    const firstMessage = messages[0];
    const systemMessage = firstMessage?.role === 'system' ? firstMessage : null;
    const conversationMessages = systemMessage ? messages.slice(1) : messages;

    // Group messages into "turns" to maintain tool call/result pairing
    const turns: ConversationMessage[][] = [];
    let currentTurn: ConversationMessage[] = [];

    for (const msg of conversationMessages) {
      if (msg.role === 'user') {
        if (currentTurn.length > 0) {
          turns.push(currentTurn);
        }
        currentTurn = [msg];
      } else if (msg.role === 'assistant') {
        if (currentTurn.length > 0) {
          turns.push(currentTurn);
        }
        currentTurn = [msg];
      } else if (msg.role === 'tool') {
        currentTurn.push(msg);
      } else if (msg.role === 'system') {
        // Carry mid-conversation system messages (a prior compaction summary)
        // into a turn so they're folded into the next summary instead of being
        // silently dropped by the grouping.
        currentTurn.push(msg);
      }
    }
    if (currentTurn.length > 0) {
      turns.push(currentTurn);
    }

    // Keep recent turns: at least preserveRecentMessages exchanges AND a
    // token budget (half the prune target) — same budget-based retention as
    // pruneMessages above, so summary-compaction at the 1M window doesn't
    // destroy hundreds of thousands of tokens while keeping 5 small messages.
    const keepTokenBudget = Math.floor(this.config.targetTokens * 0.5);
    const recentTurns: ConversationMessage[][] = [];
    let exchangeCount = 0;
    let keptTokens = 0;

    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (!turn || turn.length === 0) continue;

      recentTurns.unshift(turn);
      keptTokens += turn.reduce((sum, m) => sum + this.estimateTokens(m), 0);

      if (turn[0]?.role === 'user') {
        exchangeCount++;
        if (exchangeCount >= this.config.preserveRecentMessages && keptTokens >= keepTokenBudget) {
          break;
        }
      }
    }

    // Ensure we don't start with orphaned tool messages
    let startIndex = 0;
    while (startIndex < recentTurns.length) {
      const firstTurn = recentTurns[startIndex];
      if (firstTurn && firstTurn.length > 0 && firstTurn[0]?.role === 'tool') {
        startIndex++;
        continue;
      }
      if (firstTurn && firstTurn[0]?.role === 'assistant') {
        const assistantMsg = firstTurn[0];
        if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
          // PERF: Pre-compute tool call IDs once, use direct Set lookup
          const toolCallIds = assistantMsg.toolCalls.map(tc => tc.id);
          const presentToolResultIds = new Set(
            firstTurn.filter(m => m.role === 'tool').map(m => (m as { toolCallId?: string }).toolCallId)
          );
          // PERF: Direct has() calls instead of spread + every()
          let allPresent = true;
          for (const id of toolCallIds) {
            if (!presentToolResultIds.has(id)) {
              allPresent = false;
              break;
            }
          }
          if (!allPresent) {
            startIndex++;
            continue;
          }
        }
      }
      break;
    }

    const validTurns = recentTurns.slice(startIndex);
    const recentMessages = validTurns.flat();

    // Determine which turns to summarize. validTurns starts at
    // (turns.length - keepTurnCount); everything before it must be summarized.
    // The old `- startIndex` here excluded the `startIndex` turns peeled off the
    // front of recentTurns from BOTH sets, silently dropping their content.
    const keepTurnCount = validTurns.length;
    const summarizeTurns = turns.slice(0, turns.length - keepTurnCount);
    const toSummarize = summarizeTurns.flat();

    // If nothing to summarize, return as-is
    if (toSummarize.length === 0) {
      // Nothing spans multiple turns to summarize (e.g. a single tool-heavy
      // turn). If still over budget, shrink the oldest verbose tool outputs in
      // place rather than no-op into an overflow.
      if (this.estimateTotalTokens(messages) >= this.config.targetTokens) {
        const reduced = this.reduceOversizedHistory(messages);
        if (reduced.truncated > 0) {
          return { pruned: reduced.messages, removed: reduced.truncated, summarized: false };
        }
      }
      return { pruned: messages, removed: 0, summarized: false };
    }

    try {
      // Call the LLM to summarize old messages
      const summary = await this.config.summarizationCallback(toSummarize);

      // Build pruned message list with summary
      const pruned: ConversationMessage[] = [];
      if (systemMessage) {
        pruned.push(systemMessage);
      }

      // Pin the ORIGINAL GOAL verbatim. The LLM summary may compress, soften,
      // or drop the precise original request — so on a long task the agent can
      // lose sight of WHAT it was asked to do across compaction. Re-surfacing
      // the first user message verbatim (mirrors the fallback prune path, but
      // with a far larger cap than the old 300/400) keeps the goal exact. Only
      // when it was summarized away (not already in the kept recent messages).
      const firstUser = messages.find((m) => m.role === 'user');
      const goalKept = !!firstUser && recentMessages.includes(firstUser);
      const originalGoal = firstUser && !goalKept && typeof firstUser.content === 'string'
        ? `Original request (the goal — keep working toward THIS, do not lose sight of it):\n"${firstUser.content.slice(0, 2000)}"\n\n`
        : '';

      // Add intelligent summary
      pruned.push({
        role: 'system',
        content: [
          '=== Context Summary (Auto-generated) ===',
          originalGoal + summary.trim(),
          '',
          `[Summarized ${toSummarize.length} earlier messages. Recent ${recentMessages.length} messages preserved below.]`,
        ].join('\n'),
      });

      pruned.push(...recentMessages);

      return {
        pruned,
        removed: toSummarize.length,
        summarized: true,
      };
    } catch (error) {
      // If summarization fails, fall back to simple pruning
      const result = this.pruneMessages(messages);
      return { ...result, summarized: false };
    }
  }

  /**
   * Check if we're approaching the limit
   */
  isApproachingLimit(messages: ConversationMessage[]): boolean {
    const totalTokens = this.estimateTotalTokens(messages);
    return totalTokens >= this.config.targetTokens;
  }

  /**
   * Get warning level for current context usage
   * Returns: null (no warning), 'info' (<70%), 'warning' (70-90%), 'danger' (>90%)
   */
  getWarningLevel(messages: ConversationMessage[]): 'info' | 'warning' | 'danger' | null {
    const totalTokens = this.estimateTotalTokens(messages);
    const percentage = (totalTokens / this.config.maxTokens) * 100;

    if (percentage > 90) {
      return 'danger';
    } else if (percentage > 70) {
      return 'warning';
    } else if (percentage > 50) {
      return 'info';
    }

    return null;
  }

  /**
   * Get a human-readable warning message
   */
  getWarningMessage(messages: ConversationMessage[]): string | null {
    const stats = this.getStats(messages);
    const warningLevel = this.getWarningLevel(messages);

    if (warningLevel === 'danger') {
      return `⚠️ Context usage critical (${stats.percentage}%). Consider starting a new session or the next request may fail.`;
    } else if (warningLevel === 'warning') {
      return `Context usage high (${stats.percentage}%). Automatic cleanup will occur soon.`;
    }

    return null;
  }

  /**
   * Get context stats
   */
  getStats(messages: ConversationMessage[]): {
    totalTokens: number;
    percentage: number;
    isOverLimit: boolean;
    isApproachingLimit: boolean;
  } {
    const totalTokens = this.estimateTotalTokens(messages);
    const percentage = Math.round((totalTokens / this.config.maxTokens) * 100);

    return {
      totalTokens,
      percentage,
      isOverLimit: totalTokens >= this.config.maxTokens,
      isApproachingLimit: totalTokens >= this.config.targetTokens,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ContextManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Create a default context manager instance with model-aware limits
 */
export function createDefaultContextManager(
  overrides?: Partial<ContextManagerConfig>,
  model?: string
): ContextManager {
  // Get model-specific thresholds
  const thresholds = calculateContextThresholds(model);

  return new ContextManager({
    maxTokens: thresholds.maxTokens,
    targetTokens: thresholds.targetTokens,  // Start pruning at 60%
    warningTokens: thresholds.warningTokens,  // Warn at 50%
    criticalTokens: thresholds.criticalTokens,  // Critical at 75%
    // 50k chars ≈ 14k tokens — ~11% of anvilwing's 131k window. The old
    // 5k cap (~1% of the window) cut the MIDDLE out of any file read over ~100
    // lines, so the model edited from incomplete content and looped on
    // "old_string not found" re-reads. Claude Code returns up to 2000 lines per
    // Read and protects the window by pruning OLD turns (targetTokens), not by
    // crippling fresh reads. Truly enormous outputs still get truncated.
    maxToolOutputLength: 50_000,
    preserveRecentMessages: 5, // Keep last 5 exchanges
    estimatedCharsPerToken: 3.5, // More aggressive estimate (accounts for special tokens, JSON overhead)
    useLLMSummarization: true, // Enable LLM summarization by default
    model,
    ...overrides,
  });
}

/**
 * Format conversation messages into readable text for summarization
 */
export function formatMessagesForSummary(messages: ConversationMessage[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push(`USER: ${msg.content}`);
    } else if (msg.role === 'assistant') {
      let content = msg.content || '';
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const toolNames = msg.toolCalls.map(tc => tc.name);
        content += ` [Called tools: ${toolNames.join(', ')}]`;
      }
      lines.push(`ASSISTANT: ${content}`);
    } else if (msg.role === 'tool') {
      // Truncate long tool outputs for summarization
      const output = msg.content.length > 500
        ? `${msg.content.slice(0, 500)  }...`
        : msg.content;
      lines.push(`TOOL (${msg.name}): ${output}`);
    }
    // Skip system messages in summary input
  }

  return lines.join('\n\n');
}

/**
 * Create a summarization callback using the given provider
 */
export function createSummarizationCallback(
  provider: { generate: (messages: ConversationMessage[], tools: unknown[]) => Promise<{ content?: string }> }
): SummarizationCallback {
  return async (messages: ConversationMessage[]): Promise<string> => {
    // Format messages into readable conversation
    const conversationText = formatMessagesForSummary(messages);

    // Create summarization prompt
    const prompt = SUMMARIZATION_PROMPT.replace('{conversation}', conversationText);

    // Call provider to generate summary (no tools needed)
    const response = await provider.generate(
      [{ role: 'user', content: prompt }],
      []
    );

    return response.content || '';
  };
}
