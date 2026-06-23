/**
 * Model Context Window Management
 *
 * Maps models to their context window sizes and provides utilities
 * for dynamic context limit configuration.
 */

interface ModelContextEntry {
  pattern: RegExp;
  contextWindow: number;
  targetTokens: number;  // Safe threshold (70% of context)
}

// Single-model product: deepseek-v4-pro only. The table has exactly one entry;
// any other string falls through to the conservative default below (which the
// product never reaches, since the model is hard-locked in config.ts).
//
// deepseek-v4 window = 1,048,576 tokens (2^20); max output 384,000 tokens.
const MODEL_CONTEXT_WINDOWS: ModelContextEntry[] = [
  { pattern: /^deepseek-v4/i, contextWindow: 1_048_576, targetTokens: 629_145 },
];

// Default fallback values
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_TARGET_TOKENS = 90_000;

export interface ModelContextInfo {
  model: string;
  contextWindow: number;
  targetTokens: number;
  isDefault: boolean;
}

/**
 * Get context window information for a model.
 */
export function getModelContextInfo(model: string | null | undefined): ModelContextInfo {
  if (!model) {
    return {
      model: 'unknown',
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      targetTokens: DEFAULT_TARGET_TOKENS,
      isDefault: true,
    };
  }

  const normalized = model.trim();

  for (const entry of MODEL_CONTEXT_WINDOWS) {
    if (entry.pattern.test(normalized)) {
      return {
        model,
        contextWindow: entry.contextWindow,
        targetTokens: entry.targetTokens,
        isDefault: false,
      };
    }
  }

  return {
    model,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    targetTokens: DEFAULT_TARGET_TOKENS,
    isDefault: true,
  };
}

/**
 * Returns the approximate context window (in tokens) for the provided model id.
 * Falls back to null when the model is unknown so callers can handle gracefully.
 */
export function getContextWindowTokens(model: string | null | undefined): number | null {
  if (!model) {
    return null;
  }

  const info = getModelContextInfo(model);
  return info.isDefault ? null : info.contextWindow;
}

/**
 * Get safe target token count for a model.
 * This is the threshold at which context pruning should begin.
 */
export function getSafeTargetTokens(model: string | null | undefined): number {
  const info = getModelContextInfo(model);
  return info.targetTokens;
}

/**
 * Calculate all context management thresholds for a model.
 *
 * Thresholds are set conservatively to prevent context overflow errors:
 * - targetTokens: Start proactive pruning at 60% to leave ample room
 * - warningTokens: Show warning at 50% so user is aware
 * - criticalTokens: Aggressive pruning at 75%
 * - safetyBuffer: Reserve 5% for API overhead and response tokens
 */
export function calculateContextThresholds(model: string | null | undefined): {
  maxTokens: number;
  targetTokens: number;
  warningTokens: number;
  criticalTokens: number;
} {
  const info = getModelContextInfo(model);
  const contextWindow = info.contextWindow;

  // Apply 5% safety buffer to account for API overhead
  const effectiveMax = Math.floor(contextWindow * 0.95);

  return {
    maxTokens: effectiveMax,
    targetTokens: Math.floor(contextWindow * 0.60),  // Start pruning at 60% (more aggressive)
    warningTokens: Math.floor(contextWindow * 0.50),  // Warn at 50%
    criticalTokens: Math.floor(contextWindow * 0.75),  // Critical at 75%
  };
}
