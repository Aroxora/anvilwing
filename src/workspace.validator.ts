/**
 * Workspace Context Validator - Enforces strict safety limits
 *
 * CRITICAL: Prevents context explosion by validating all workspace context
 * before it's sent to the LLM. Multiple safety layers ensure we never
 * exceed token limits.
 */

import { ContextOverflowError, ResourceLimitError } from './core/errors/errorTypes.js';
import { logDebug } from './utils/debugLogger.js';

// ABSOLUTE MAXIMUM LIMITS - Never exceed these under any circumstances
const ABSOLUTE_MAX_CHARS = 5000;        // ~1,250 tokens (4 chars per token)
const ABSOLUTE_MAX_LINES = 100;         // Maximum lines in any context
const ABSOLUTE_MAX_FILE_ENTRIES = 50;   // Maximum files in tree
const ABSOLUTE_MAX_DOC_CHARS = 300;     // Maximum chars per priority doc
const WARNING_THRESHOLD = 0.7;          // Warn at 70% of max

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: ContextStats;
}

export interface ContextStats {
  totalChars: number;
  totalLines: number;
  estimatedTokens: number;
  fileEntries: number;
  docChars: number;
}

export interface WorkspaceContextSafe {
  content: string;
  stats: ContextStats;
}

/**
 * Estimate token count (rough: 1 token ≈ 4 characters)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Validate workspace context options BEFORE building context
 */
export function validateWorkspaceOptions(options: {
  treeDepth?: number;
  maxEntries?: number;
  docExcerptLimit?: number;
}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate tree depth
  if (options.treeDepth !== undefined) {
    if (options.treeDepth < 0) {
      errors.push('treeDepth cannot be negative');
    }
    if (options.treeDepth > 2) {
      errors.push(`treeDepth ${options.treeDepth} exceeds maximum of 2`);
    }
    if (options.treeDepth > 1) {
      warnings.push('treeDepth > 1 can significantly increase context size');
    }
  }

  // Validate max entries
  if (options.maxEntries !== undefined) {
    if (options.maxEntries < 0) {
      errors.push('maxEntries cannot be negative');
    }
    if (options.maxEntries > ABSOLUTE_MAX_FILE_ENTRIES) {
      errors.push(`maxEntries ${options.maxEntries} exceeds maximum of ${ABSOLUTE_MAX_FILE_ENTRIES}`);
    }
    if (options.maxEntries > 40) {
      warnings.push('maxEntries > 40 may use significant context');
    }
  }

  // Validate doc excerpt limit
  if (options.docExcerptLimit !== undefined) {
    if (options.docExcerptLimit < 0) {
      errors.push('docExcerptLimit cannot be negative');
    }
    if (options.docExcerptLimit > ABSOLUTE_MAX_DOC_CHARS) {
      errors.push(`docExcerptLimit ${options.docExcerptLimit} exceeds maximum of ${ABSOLUTE_MAX_DOC_CHARS}`);
    }
    if (options.docExcerptLimit > 250) {
      warnings.push('docExcerptLimit > 250 may use significant context');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      totalChars: 0,
      totalLines: 0,
      estimatedTokens: 0,
      fileEntries: options.maxEntries ?? 0,
      docChars: options.docExcerptLimit ?? 0,
    },
  };
}

/**
 * Validate workspace context AFTER building - CRITICAL SAFETY CHECK
 * This is the final line of defense against context explosion
 */
export function validateWorkspaceContext(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Count basic metrics
  const totalChars = content.length;
  const lines = content.split('\n');
  const totalLines = lines.length;
  const estimatedTokens = estimateTokens(content);

  // Count file entries (lines that look like file paths)
  const fileEntries = lines.filter(line =>
    line.trim() && !line.startsWith('---') && !line.startsWith('cwd:')
  ).length;

  // Count chars in priority docs section
  const docMatch = content.match(/--- .* ---[\s\S]*?(?=\n\n|$)/g);
  const docChars = docMatch ? docMatch.join('').length : 0;

  const stats: ContextStats = {
    totalChars,
    totalLines,
    estimatedTokens,
    fileEntries,
    docChars,
  };

  // CRITICAL: Check absolute maximum character limit
  if (totalChars > ABSOLUTE_MAX_CHARS) {
    const error = new ContextOverflowError(totalChars, ABSOLUTE_MAX_CHARS, 'chars', true);
    errors.push(
      `Context exceeds ABSOLUTE maximum: ${error.message}`
    );
  }

  // CRITICAL: Check absolute maximum line limit
  if (totalLines > ABSOLUTE_MAX_LINES) {
    const error = new ContextOverflowError(totalLines, ABSOLUTE_MAX_LINES, 'lines', true);
    errors.push(
      `Context exceeds ABSOLUTE maximum: ${error.message}`
    );
  }

  // CRITICAL: Check absolute maximum file entries
  if (fileEntries > ABSOLUTE_MAX_FILE_ENTRIES) {
    const error = new ResourceLimitError('file entries', fileEntries, ABSOLUTE_MAX_FILE_ENTRIES, false);
    errors.push(
      `Context exceeds ABSOLUTE maximum: ${error.message}`
    );
  }

  // WARNING: Approaching limits
  if (totalChars > ABSOLUTE_MAX_CHARS * WARNING_THRESHOLD) {
    warnings.push(
      `Context size ${totalChars} chars is ${Math.round(totalChars / ABSOLUTE_MAX_CHARS * 100)}% of maximum. ` +
      `Consider reducing treeDepth, maxEntries, or docExcerptLimit.`
    );
  }

  if (estimatedTokens > 1000) {
    warnings.push(
      `Estimated ${estimatedTokens} tokens in workspace context. This is high and may impact performance.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats,
  };
}

/**
 * Safe truncation - if content exceeds limits, truncate intelligently
 */
export function truncateWorkspaceContext(content: string): WorkspaceContextSafe {
  const validation = validateWorkspaceContext(content);

  // If valid, return as-is
  if (validation.valid) {
    return {
      content,
      stats: validation.stats,
    };
  }

  // CRITICAL: Content exceeds limits, must truncate
  const lines = content.split('\n');
  const truncatedLines: string[] = [];
  let charCount = 0;

  // Keep up to absolute maximums
  for (const line of lines) {
    if (truncatedLines.length >= ABSOLUTE_MAX_LINES) {
      break;
    }
    if (charCount + line.length > ABSOLUTE_MAX_CHARS) {
      break;
    }

    truncatedLines.push(line);
    charCount += line.length + 1; // +1 for newline
  }

  // Add truncation notice
  if (truncatedLines.length < lines.length) {
    truncatedLines.push('');
    truncatedLines.push('[Workspace context truncated to prevent context overflow]');
    truncatedLines.push(`[Showing ${truncatedLines.length} of ${lines.length} lines]`);
  }

  const truncatedContent = truncatedLines.join('\n');
  const stats = validateWorkspaceContext(truncatedContent).stats;

  return {
    content: truncatedContent,
    stats,
  };
}

/**
 * Validate and enforce limits in a single call - RECOMMENDED USAGE
 */
export function safeWorkspaceContext(
  content: string | null,
  options?: { truncate?: boolean; throwOnError?: boolean }
): WorkspaceContextSafe {
  const { truncate = true, throwOnError = false } = options ?? {};

  if (!content) {
    return {
      content: '',
      stats: {
        totalChars: 0,
        totalLines: 0,
        estimatedTokens: 0,
        fileEntries: 0,
        docChars: 0,
      },
    };
  }

  const validation = validateWorkspaceContext(content);

  // Log warnings to debug
  if (validation.warnings.length > 0) {
    logDebug('[Workspace Context Validator] Warnings:');
    for (const warning of validation.warnings) {
      logDebug(`  - ${warning}`);
    }
  }

  // Handle errors
  if (!validation.valid) {
    logDebug('[Workspace Context Validator] CRITICAL ERRORS:');
    for (const error of validation.errors) {
      logDebug(`  - ${error}`);
    }

    if (throwOnError) {
      throw new Error(
        `Workspace context validation failed:\n${validation.errors.join('\n')}`
      );
    }

    if (truncate) {
      logDebug('[Workspace Context Validator] Auto-truncating to safe limits...');
      return truncateWorkspaceContext(content);
    }
  }

  return {
    content,
    stats: validation.stats,
  };
}
