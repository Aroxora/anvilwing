/**
 * Unified Error Handling System
 *
 * This module consolidates all error-related exports into a single entry point.
 * Use this module for all error handling needs instead of importing from
 * individual files.
 *
 * Architecture:
 * - errorTypes.ts: Base classes and structured error types
 * - apiKeyErrors.ts: API key and authentication errors
 * - networkErrors.ts: Network connectivity errors
 * - safetyValidator.ts: Input validation and safety checks
 *
 * Usage:
 * ```typescript
 * import {
 *   StructuredError,
 *   ErrorSeverity,
 *   ErrorCategory,
 *   DangerousOperationError,
 *   detectApiKeyError,
 *   detectNetworkError,
 * } from '../core/errors/index.js';
 * ```
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Error Types and Base Classes
// ═══════════════════════════════════════════════════════════════════════════════

export {
  // Enums
  ErrorSeverity,
  ErrorCategory,

  // Types
  type ErrorSuggestion,
  type StructuredErrorDetails,

  // Base class
  StructuredError,

  // Specific error classes
  DangerousOperationError,
  BlockedOperationError,
  ContextOverflowError,
  ResourceLimitError,
  ValidationError,

  // Factory functions
  toStructuredError,
} from './errorTypes.js';

// ═══════════════════════════════════════════════════════════════════════════════
// API Key Errors
// ═══════════════════════════════════════════════════════════════════════════════

export {
  type ApiKeyErrorType,
  type ApiKeyErrorInfo,
  detectApiKeyError,
} from './apiKeyErrors.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Network Errors
// ═══════════════════════════════════════════════════════════════════════════════

export {
  type NetworkErrorInfo,
  detectNetworkError,
} from './networkErrors.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Safety Validator
// ═══════════════════════════════════════════════════════════════════════════════

export * from './safetyValidator.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Legacy Re-exports (from ../errors.ts)
// ═══════════════════════════════════════════════════════════════════════════════

export {
  type ErrorContextValue,
  type ErrorContext,
  buildError,
} from '../errors.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

import {
  StructuredError as StructuredErrorClass,
  type StructuredErrorDetails as StructuredErrorDetailsType,
} from './errorTypes.js';
import { detectApiKeyError as detectApiKeyErrorFn } from './apiKeyErrors.js';
import { detectNetworkError as detectNetworkErrorFn } from './networkErrors.js';

/**
 * Detect and classify any error into a structured format
 */
export function detectError(error: unknown, provider?: string): {
  type: 'api_key' | 'network' | 'structured' | 'unknown';
  info: unknown;
} {
  // Check for API key errors first
  const apiKeyError = detectApiKeyErrorFn(error, provider as Parameters<typeof detectApiKeyErrorFn>[1]);
  if (apiKeyError) {
    return { type: 'api_key', info: apiKeyError };
  }

  // Check for network errors
  const networkError = detectNetworkErrorFn(error);
  if (networkError) {
    return { type: 'network', info: networkError };
  }

  // Check if it's already a structured error
  if (error instanceof StructuredErrorClass) {
    return { type: 'structured', info: error };
  }

  // Unknown error
  return {
    type: 'unknown',
    info: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  };
}

/**
 * Check if an error is recoverable
 */
export function isRecoverableError(error: unknown): boolean {
  // Structured errors have a recoverable flag
  if (error instanceof StructuredErrorClass) {
    return error.recoverable;
  }

  // Network errors are generally retryable
  const networkError = detectNetworkErrorFn(error);
  if (networkError) {
    return networkError.retryable;
  }

  return false;
}

/**
 * Get a user-friendly error message
 */
export function getUserFriendlyMessage(error: unknown): string {
  // Structured errors have their own display format
  if (error instanceof StructuredErrorClass) {
    return error.toDisplayString();
  }

  // API key errors
  const apiKeyError = detectApiKeyErrorFn(error);
  if (apiKeyError) {
    if (apiKeyError.type === 'missing') {
      return `Missing API key for ${apiKeyError.provider || 'provider'}. Please configure your API key.`;
    }
    return `Invalid API key for ${apiKeyError.provider || 'provider'}. Please check your API key configuration.`;
  }

  // Network errors
  const networkError = detectNetworkErrorFn(error);
  if (networkError) {
    return `Network error: ${networkError.message}. Please check your internet connection and try again.`;
  }

  // Default
  return error instanceof Error ? error.message : String(error);
}

/**
 * Format error for logging (includes full details)
 */
export function formatForLogging(error: unknown, context?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const parts: string[] = [`[${timestamp}]`];

  if (error instanceof StructuredErrorClass) {
    parts.push(`[${error.severity.toUpperCase()}]`);
    parts.push(`[${error.category}]`);
    parts.push(error.message);
    if (error.metadata) {
      parts.push(`Metadata: ${JSON.stringify(error.metadata)}`);
    }
  } else if (error instanceof Error) {
    parts.push(`[ERROR]`);
    parts.push(error.message);
    if (error.stack) {
      parts.push(`Stack: ${error.stack}`);
    }
  } else {
    parts.push(`[ERROR]`);
    parts.push(String(error));
  }

  if (context) {
    parts.push(`Context: ${JSON.stringify(context)}`);
  }

  return parts.join(' ');
}
