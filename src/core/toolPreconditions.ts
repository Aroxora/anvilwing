import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize as normalizePath, resolve as resolvePath } from 'node:path';
import { analyzeBashFlow } from './bashCommandGuidance.js';

/**
 * Pre-flight validation patterns for AI flow design.
 * Catches common tool usage failures before execution and provides actionable guidance.
 */
export interface PreflightWarning {
  readonly code: string;
  readonly message: string;
  readonly severity: 'critical' | 'warning' | 'info';
  readonly suggestion: string;
}

export const EDIT_WITHOUT_READ = 'EDIT_WITHOUT_READ';

type ToolHistoryCall = {
  toolName: string;
  args: Record<string, unknown>;
  timestamp?: number;
};

/**
 * Validate tool preconditions before execution to prevent common AI flow failures.
 *
 * This function implements the critical AI flow design principle: validate before execute.
 * It catches common patterns that lead to tool failures and provides actionable guidance.
 *
 * @param toolName - Name of the tool being called
 * @param args - Tool arguments
 * @returns Array of pre-flight warnings (empty if all validations pass)
 */
export function validateToolPreconditions(
  toolName: string,
  args: Record<string, unknown>
): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];
  const toolLower = toolName.toLowerCase();

  // -------------------------------------------------------------------------
  // Edit Tool Validation - Critical for AI software engineering flow
  // -------------------------------------------------------------------------
  if (toolLower === 'edit') {
    const oldString = args['old_string'] as string | undefined;
    const newString = args['new_string'] as string | undefined;
    const filePath = args['file_path'] as string | undefined;

    if (!oldString) {
      // Empty old_string = new file creation - validate path structure
      if (filePath && !isAbsolute(filePath)) {
        warnings.push({
          code: 'EDIT_RELATIVE_PATH',
          message: 'Edit file_path should be absolute path for new file creation',
          severity: 'warning',
          suggestion: 'Use absolute path (e.g. /foo/bar or C:\\foo\\bar) for file creation',
        });
      }
    } else {
      // PATTERN 1: Placeholder patterns - AI is guessing content (but NOT "TODO" which is legitimate code)
      const placeholderPatterns = ['[content]', '[code]', '/* ... */', '// ...'];
      // Only flag "..." if it's standalone, not as part of spread operator or ellipsis in comments
      const hasStandalonePlaceholder = placeholderPatterns.some((p) => oldString.includes(p)) ||
        /(?<!\.)\.\.\.(?!\.)/.test(oldString); // Matches ... but not .... or .....
      if (hasStandalonePlaceholder) {
        warnings.push({
          code: 'EDIT_PLACEHOLDER',
          message: 'Placeholder patterns detected - HALLUCINATION ALERT',
          severity: 'critical',
          suggestion:
            'AI is guessing content instead of reading actual file. ALWAYS use Read tool to get exact file content including whitespace.',
        });
      }

      // PATTERN 2: Tab vs space mismatch (legitimate concern)
      if (oldString && newString) {
        const oldHasTabs = oldString.includes('\t');
        const newHasTabs = newString.includes('\t');
        if (oldHasTabs && !newHasTabs) {
          warnings.push({
            code: 'EDIT_WHITESPACE_MISMATCH',
            message: 'old_string uses tabs, new_string uses spaces',
            severity: 'warning',
            suggestion: 'Whitespace type mismatch may cause Edit to fail.',
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Search Operations Validation - Only flag truly problematic patterns
  // -------------------------------------------------------------------------
  if (toolLower === 'grep' || toolLower === 'glob' || toolLower.includes('search')) {
    const patternArg = args['pattern'];
    const pattern = typeof patternArg === 'string' ? patternArg.trim() : '';
    const isGrepTool = toolLower.includes('grep');

    if (pattern) {
      // Only warn on truly broad patterns that would match everything
      if (isBroadBasePattern(pattern)) {
        warnings.push({
          code: 'SEARCH_BROAD_PATTERN',
          message: `Pattern '${pattern}' is too broad and may return thousands of files`,
          severity: 'critical',
          suggestion: "Use targeted patterns like '**/*.ts' or 'src/**/*.js'.",
        });
      }

      // For grep: only warn on patterns that literally match everything
      if (isGrepTool && isVeryBroadRegex(pattern)) {
        const hasFileFilters = typeof args['glob'] === 'string' || typeof args['type'] === 'string';
        if (!hasFileFilters) {
          warnings.push({
            code: 'SEARCH_CONTEXT_OVERFLOW_RISK',
            message: `Regex pattern '${pattern}' matches everything`,
            severity: 'warning',
            suggestion: 'Use a more specific pattern or add a glob/type filter.',
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Bash Command Efficiency
  // -------------------------------------------------------------------------
  if (toolLower === 'bash' || toolLower === 'execute_bash') {
    const command = String(args['command'] || '');
    const flowWarnings = analyzeBashFlow(command);

    for (const flow of flowWarnings) {
      warnings.push({
        code: flow.code,
        message: flow.message,
        severity: flow.severity === 'critical' ? 'critical' : flow.severity === 'info' ? 'info' : 'warning',
        suggestion: flow.suggestion ?? flow.message,
      });
    }
  }

  return warnings;
}

/**
 * Enhanced AI flow validation for TypeScript software engineering
 * Provides comprehensive validation of AI tool usage patterns
 */
export function validateAIFlowPatterns(
  toolName: string,
  args: Record<string, unknown>,
  toolHistory: readonly ToolHistoryCall[]
): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];
  const toolLower = toolName.toLowerCase();

  // Pattern: Edit without prior Read - Critical for hallucination reduction
  if (toolLower === 'edit') {
    const targetPath = normalizeFilePath(args['file_path']);
    const isNewFileCreation = isNewFileEdit(args['old_string']);
    const hasRecentRead = hasMatchingRead(toolHistory, targetPath);

    if (!isNewFileCreation && !hasRecentRead) {
      warnings.push({
        code: EDIT_WITHOUT_READ,
        message: 'Edit attempted without prior file read - HIGH HALLUCINATION RISK',
        severity: 'critical',
        suggestion: 'ALWAYS use Read tool first to get exact text including whitespace and indentation. Never guess file content.',
      });
    }
  }

  // Pattern: Multiple validation runs
  if (toolLower === 'run_repo_checks' || toolLower === 'run_tests' || toolLower === 'run_build') {
    const now = Date.now();
    const recencyWindowMs = 15 * 60 * 1000; // Only warn when validations are clustered
    const recentValidations = toolHistory
      .filter((call) =>
        call.toolName.toLowerCase().includes('run_') ||
        call.toolName.toLowerCase().includes('test') ||
        call.toolName.toLowerCase().includes('build')
      )
      .filter((call) => {
        if (typeof call.timestamp !== 'number') {
          return true;
        }
        return now - call.timestamp <= recencyWindowMs;
      });

    if (recentValidations.length > 0) {
      warnings.push({
        code: 'DEFERRED_VALIDATION_REMINDER',
        message: 'Validation already ran recently; batch edits and run one final pass at the end.',
        severity: 'info',
        suggestion: 'Finish implementation work first, then run a single build/test/check step to validate.',
      });
    }
  }

  // Pattern: Excessive git status calls (actually wasteful)
  // Note: Multiple git operations in sequence (add, commit, push) is fine - don't warn on that
  if (toolLower.includes('git')) {
    const command = String(args['command'] || '');
    if (command.includes('git status')) {
      const recentStatusCalls = toolHistory.filter(
        (call) => {
          const cmd = String(call.args['command'] || '');
          return cmd.includes('git status');
        }
      );
      // Only warn if there are 3+ status calls - 2 is normal (before and after operations)
      if (recentStatusCalls.length >= 3) {
        warnings.push({
          code: 'GIT_REDUNDANT_STATUS',
          message: 'Multiple git status calls detected',
          severity: 'info',
          suggestion: 'One git status call is usually sufficient.',
        });
      }
    }
  }

  return warnings;
}

function isBroadBasePattern(pattern: string): boolean {
  // Only the truly universal patterns that match everything
  return pattern === '.' || pattern === '*' || pattern === '**' || pattern === '**/*';
}

function isVeryBroadRegex(pattern: string): boolean {
  const normalized = pattern.trim();
  return normalized === '.*' || normalized === '.+' || normalized === '.';
}

function hasMatchingRead(
  toolHistory: readonly ToolHistoryCall[],
  targetPath: string | null
): boolean {
  if (!targetPath) return false;

  return toolHistory.some((call) => {
    const callLower = call.toolName.toLowerCase();
    if (!callLower.includes('read')) {
      return false;
    }

    const readPath = normalizeFilePath(call.args['path'] ?? call.args['file_path']);
    return Boolean(readPath && readPath === targetPath);
  });
}

function isNewFileEdit(oldString: unknown): boolean {
  return typeof oldString === 'string' && oldString.length === 0;
}

function normalizeFilePath(pathValue: unknown): string | null {
  if (typeof pathValue !== 'string') {
    return null;
  }

  const trimmed = pathValue.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const normalized = normalizePath(trimmed);
    const absolutePath = isAbsolute(normalized) ? normalized : resolvePath(process.cwd(), normalized);

    // Resolve symlinks on the deepest existing directory to avoid /var vs /private/var mismatches
    let currentDir = dirname(absolutePath);
    let suffix = basename(absolutePath);

    // Loop until we find an existing ancestor or hit the filesystem root.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (existsSync(currentDir)) {
        try {
          const realDir = realpathSync(currentDir);
          return normalizePath(join(realDir, suffix));
        } catch {
          // If realpath fails, fall through to the default normalization
          break;
        }
      }

      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }

      suffix = join(basename(currentDir), suffix);
      currentDir = parentDir;
    }

    return normalizePath(absolutePath);
  } catch {
    return trimmed;
  }
}
