/**
 * Comprehensive Error Classification System
 *
 * Provides structured error handling with:
 * - Error categorization (dangerous, blocked, invalid, etc.)
 * - Severity levels (critical, error, warning, info)
 * - Auto-fixing suggestions
 * - Recovery strategies
 */

export enum ErrorSeverity {
  CRITICAL = 'critical',  // System-level failure, cannot continue
  ERROR = 'error',        // Operation failed, but system stable
  WARNING = 'warning',    // Risky but allowed
  INFO = 'info',          // Informational only
}

export enum ErrorCategory {
  DANGEROUS = 'dangerous',      // Operation could harm system
  BLOCKED = 'blocked',          // Explicitly forbidden by policy
  INVALID = 'invalid',          // Malformed input/arguments
  PERMISSION = 'permission',    // Authorization issue
  RESOURCE = 'resource',        // Resource limit exceeded
  NETWORK = 'network',          // Network/connectivity issue
  TIMEOUT = 'timeout',          // Operation timed out
  VALIDATION = 'validation',    // Schema/type validation failed
  CONTEXT_OVERFLOW = 'context_overflow', // Token/context limit exceeded
  NOT_FOUND = 'not_found',      // Resource doesn't exist
  UNKNOWN = 'unknown',          // Unclassified error
}

// Enhanced discriminated union for error suggestions
export type ErrorSuggestion =
  | {
      readonly action: string;
      readonly example?: string;
      readonly autoFixable: true;
      readonly autoFix: () => unknown;
    }
  | {
      readonly action: string;
      readonly example?: string;
      readonly autoFixable: false;
    };

// Enhanced discriminated union for structured error details
export type StructuredErrorDetails = {
  readonly severity: ErrorSeverity;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly originalInput?: string;
  readonly suggestions: readonly ErrorSuggestion[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
  readonly recoverable: boolean;
};

/**
 * Base class for all structured errors
 */
export abstract class StructuredError extends Error {
  public readonly severity: ErrorSeverity;
  public readonly category: ErrorCategory;
  public readonly suggestions: ErrorSuggestion[];
  public readonly originalInput?: string;
  public readonly metadata?: Record<string, unknown>;
  public readonly timestamp: string;
  public readonly recoverable: boolean;

  constructor(details: StructuredErrorDetails) {
    super(details.message);
    this.name = this.constructor.name;
    this.severity = details.severity;
    this.category = details.category;
    this.suggestions = [...details.suggestions]; // Copy to mutable array
    this.originalInput = details.originalInput;
    this.metadata = details.metadata;
    this.timestamp = details.timestamp;
    this.recoverable = details.recoverable;

    // Maintain proper stack trace
    Error.captureStackTrace(this, this.constructor);
  }

  /**
 * Format error for display with suggestions
 */
  toDisplayString(): string {
    const parts: string[] = [
      `[${this.severity.toUpperCase()}] ${this.message}`,
    ];

    if (this.originalInput) {
      parts.push(`  Input: ${this.originalInput}`);
    }

    if (this.suggestions.length > 0) {
      parts.push('\nSuggestions:');
      for (const suggestion of this.suggestions) {
        parts.push(`  • ${suggestion.action}`);
        if (suggestion.example) {
          parts.push(`    Example: ${suggestion.example}`);
        }
        if (suggestion.autoFixable) {
          parts.push(`    [Auto-fixable]`);
        }
      }
    }

    return parts.join('\n');
  }

  /**
 * Convert to JSON for logging/telemetry
 */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      severity: this.severity,
      category: this.category,
      message: this.message,
      originalInput: this.originalInput,
      suggestions: this.suggestions.map(s => ({
        action: s.action,
        example: s.example,
        autoFixable: s.autoFixable,
      })),
      metadata: this.metadata,
      timestamp: this.timestamp,
      recoverable: this.recoverable,
      stack: this.stack,
    };
  }

  /**
 * Try to auto-fix the error if possible
 */
  tryAutoFix(): { fixed: boolean; result?: any } {
    for (const suggestion of this.suggestions) {
      if (suggestion.autoFixable && suggestion.autoFix) {
        try {
          const result = suggestion.autoFix();
          return { fixed: true, result };
        } catch {
          // Continue to next suggestion
        }
      }
    }
    return { fixed: false };
  }
}

/**
 * Dangerous operation error - operation could harm the system
 */
export class DangerousOperationError extends StructuredError {
  constructor(
    operation: string,
    reason: string,
    safeAlternative?: string
  ) {
    const suggestions: ErrorSuggestion[] = [];

    if (safeAlternative) {
      suggestions.push({
        action: `Use safer alternative: ${safeAlternative}`,
        example: safeAlternative,
        autoFixable: true,
        autoFix: () => safeAlternative,
      });
    } else {
      suggestions.push({
        action: 'Review operation for safety before retrying',
        autoFixable: false,
      });
    }

    super({
      severity: ErrorSeverity.CRITICAL,
      category: ErrorCategory.DANGEROUS,
      message: `Dangerous operation blocked: ${operation}. Reason: ${reason}`,
      originalInput: operation,
      suggestions,
      recoverable: safeAlternative !== undefined,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Blocked operation error - explicitly forbidden by policy
 */
export class BlockedOperationError extends StructuredError {
  constructor(
    operation: string,
    policy: string,
    allowedAlternatives?: string[]
  ) {
    const suggestions: ErrorSuggestion[] = [];

    if (allowedAlternatives && allowedAlternatives.length > 0) {
      for (const alt of allowedAlternatives) {
        suggestions.push({
          action: `Try allowed alternative: ${alt}`,
          example: alt,
          autoFixable: true,
          autoFix: () => alt,
        });
      }
    } else {
      suggestions.push({
        action: 'This operation is not permitted by policy',
        autoFixable: false,
      });
    }

    super({
      severity: ErrorSeverity.ERROR,
      category: ErrorCategory.BLOCKED,
      message: `Operation blocked by policy "${policy}": ${operation}`,
      originalInput: operation,
      suggestions,
      recoverable: allowedAlternatives !== undefined && allowedAlternatives.length > 0,
      timestamp: new Date().toISOString(),
      metadata: { policy, allowedAlternatives },
    });
  }
}

/**
 * Context overflow error - token/character limits exceeded
 */
export class ContextOverflowError extends StructuredError {
  constructor(
    actual: number,
    limit: number,
    unit: 'tokens' | 'chars' | 'lines' = 'tokens',
    truncatable: boolean = true
  ) {
    const percentage = limit > 0 ? Math.round((actual / limit) * 100) : 0;
    const suggestions: ErrorSuggestion[] = [];

    if (truncatable) {
      suggestions.push({
        action: `Auto-truncate to ${limit} ${unit}`,
        example: `Content will be reduced from ${actual} to ${limit} ${unit}`,
        autoFixable: true,
        autoFix: () => ({ truncate: true, limit }),
      });
    }

    suggestions.push({
      action: `Reduce scope to use less than ${limit} ${unit}`,
      autoFixable: false,
    });

    super({
      severity: ErrorSeverity.CRITICAL,
      category: ErrorCategory.CONTEXT_OVERFLOW,
      message: `Context overflow: ${actual} ${unit} exceeds limit of ${limit} ${unit} (${percentage}%)`,
      suggestions,
      recoverable: truncatable,
      timestamp: new Date().toISOString(),
      metadata: { actual, limit, unit, percentage },
    });
  }
}

/**
 * Resource error - limits exceeded
 */
export class ResourceLimitError extends StructuredError {
  constructor(
    resource: string,
    actual: number,
    limit: number,
    reducible: boolean = true
  ) {
    const suggestions: ErrorSuggestion[] = [];

    if (reducible) {
      const safeValue = Math.floor(limit * 0.8); // 80% of limit
      suggestions.push({
        action: `Reduce ${resource} to ${safeValue} (80% of limit)`,
        example: `Set ${resource}=${safeValue}`,
        autoFixable: true,
        autoFix: () => safeValue,
      });
    }

    super({
      severity: ErrorSeverity.ERROR,
      category: ErrorCategory.RESOURCE,
      message: `Resource limit exceeded: ${resource} is ${actual}, maximum is ${limit}`,
      suggestions,
      recoverable: reducible,
      timestamp: new Date().toISOString(),
      metadata: { resource, actual, limit },
    });
  }
}

/**
 * Validation error - input/schema validation failed
 */
export class ValidationError extends StructuredError {
  constructor(field: string, code: string, message: string) {
    super({
      severity: ErrorSeverity.ERROR,
      category: ErrorCategory.VALIDATION,
      message: `Validation failed for ${field}: ${code}. ${message}`,
      originalInput: code,
      suggestions: [
        {
          action: `Fix the field "${field}" to satisfy validation`,
          example: `${field}: <provide valid value>`,
          autoFixable: false,
        },
      ],
      recoverable: false,
      timestamp: new Date().toISOString(),
      metadata: { field, code },
    });
  }
}

/**
 * Format any error as a structured error
 */
export function toStructuredError(error: unknown): StructuredError {
  // Already structured
  if (error instanceof StructuredError) {
    return error;
  }

  // Convert standard errors
  const message = error instanceof Error ? error.message : String(error);

  // Detect error category from message
  const category = detectErrorCategory(message);
  const severity = detectErrorSeverity(category);

  class GenericStructuredError extends StructuredError {}

  return new GenericStructuredError({
    severity,
    category,
    message,
    suggestions: [],
    recoverable: false,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Detect error category from error message
 */
function detectErrorCategory(message: string): ErrorCategory {
  const lower = message.toLowerCase();

  if (lower.includes('dangerous') || lower.includes('unsafe') || lower.includes('harmful')) {
    return ErrorCategory.DANGEROUS;
  }
  if (lower.includes('blocked') || lower.includes('forbidden') || lower.includes('not allowed')) {
    return ErrorCategory.BLOCKED;
  }
  if (lower.includes('invalid') || lower.includes('malformed')) {
    return ErrorCategory.INVALID;
  }
  if (lower.includes('permission') || lower.includes('unauthorized') || lower.includes('access denied')) {
    return ErrorCategory.PERMISSION;
  }
  if (lower.includes('limit') || lower.includes('exceeded') || lower.includes('too large')) {
    return ErrorCategory.RESOURCE;
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return ErrorCategory.TIMEOUT;
  }
  if (lower.includes('network') || lower.includes('connection')) {
    return ErrorCategory.NETWORK;
  }
  if (lower.includes('validation') || lower.includes('schema')) {
    return ErrorCategory.VALIDATION;
  }
  if (lower.includes('context') || lower.includes('token') || lower.includes('overflow')) {
    return ErrorCategory.CONTEXT_OVERFLOW;
  }
  if (lower.includes('not found') || lower.includes('does not exist')) {
    return ErrorCategory.NOT_FOUND;
  }

  return ErrorCategory.UNKNOWN;
}

/**
 * Determine severity from category
 */
function detectErrorSeverity(category: ErrorCategory): ErrorSeverity {
  switch (category) {
    case ErrorCategory.DANGEROUS:
    case ErrorCategory.CONTEXT_OVERFLOW:
      return ErrorSeverity.CRITICAL;

    case ErrorCategory.BLOCKED:
    case ErrorCategory.PERMISSION:
    case ErrorCategory.VALIDATION:
    case ErrorCategory.INVALID:
    case ErrorCategory.RESOURCE:
      return ErrorSeverity.ERROR;

    case ErrorCategory.TIMEOUT:
    case ErrorCategory.NETWORK:
    case ErrorCategory.NOT_FOUND:
      return ErrorSeverity.WARNING;

    default:
      return ErrorSeverity.ERROR;
  }
}
