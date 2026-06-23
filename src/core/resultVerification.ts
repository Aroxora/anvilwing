/**
 * Result Verification — canonical home for verifiedSuccess, verifiedFailure,
 * analyzeOutput, OutputPatterns, etc. (Defined here, not re-exported; the
 * orchestrationCapability module the old header named no longer exists.)
 */

// ANSI color codes for enhanced terminal output
const ANSI_RESET = '\x1b[0m';
const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_BLUE = '\x1b[34m';
const ANSI_MAGENTA = '\x1b[35m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_DIM = '\x1b[2m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RED_BOLD = '\x1b[1;31m';
const ANSI_GREEN_BOLD = '\x1b[1;32m';
const ANSI_YELLOW_BOLD = '\x1b[1;33m';

export type VerificationStatus =
  | 'VERIFIED_SUCCESS'
  | 'VERIFIED_FAILURE'
  | 'UNVERIFIED'
  | 'PARTIAL_SUCCESS'
  | 'REQUIRES_USER_ACTION';

export interface VerifiedResult {
  status: VerificationStatus;
  summary: string;
  details: string;
  verificationChecks?: VerificationCheck[];
  suggestedActions?: string[];
  verifiedAt: string;
  durationMs?: number;
}

export interface VerificationCheck {
  check: string;
  passed: boolean;
  details?: string;
}

export const OutputPatterns = {
  git: {
    success: [/\[.+\s+\w+\]/, /pushed/i, /merged/i, /On branch/i, /nothing to commit/i, /Already up to date/i],
    failure: [/fatal:/i, /error:/i, /conflict/i, /rejected/i, /CONFLICT/, /Aborting/i],
  },
  npm: {
    success: [/npm notice/i, /\+ .+@\d+\.\d+\.\d+/, /published/i],
    failure: [/npm ERR!/i, /ERESOLVE/i, /E404/i, /EINTEGRITY/i],
  },
  command: {
    success: [/^(success|completed|done|finished)/im, /successfully/i],
    failure: [/^error/im, /^fatal/im, /failed/i, /command not found/i, /permission denied/i, /ENOENT/i, /EACCES/i],
  },
};

function formatVerifiedResult(result: VerifiedResult): string {
  if (result.status === 'VERIFIED_SUCCESS') return result.details || result.summary;
  const lines: string[] = [];
  switch (result.status) {
    case 'VERIFIED_FAILURE': lines.push(`${ANSI_RED_BOLD}═══ FAILED ═══${ANSI_RESET}`); break;
    case 'UNVERIFIED': lines.push(`${ANSI_YELLOW_BOLD}═══ UNVERIFIED ═══${ANSI_RESET}`); break;
    case 'PARTIAL_SUCCESS': lines.push(`${ANSI_YELLOW_BOLD}═══ PARTIAL SUCCESS ═══${ANSI_RESET}`); break;
    case 'REQUIRES_USER_ACTION': lines.push(`${ANSI_CYAN}═══ ACTION REQUIRED ═══${ANSI_RESET}`); break;
  }
  lines.push('', result.summary, '');
  if (result.verificationChecks) {
    const failedChecks = result.verificationChecks.filter(c => !c.passed);
    if (failedChecks.length > 0) {
      lines.push('Failed checks:');
      for (const check of failedChecks) {
        lines.push(`  ${ANSI_RED}✗${ANSI_RESET} ${check.check}${check.details ? `: ${check.details}` : ''}`);
      }
      lines.push('');
    }
  }
  if (result.details) lines.push(result.details, '');
  if (result.suggestedActions?.length) {
    lines.push('Suggested actions:');
    for (const action of result.suggestedActions) lines.push(`  ${ANSI_GREEN}→${ANSI_RESET} ${action}`);
  }
  return lines.join('\n');
}

export function verifiedSuccess(
  summary: string,
  details: string,
  checks?: VerificationCheck[],
  durationMs?: number
): string {
  return formatVerifiedResult({
    status: 'VERIFIED_SUCCESS',
    summary,
    details,
    verificationChecks: checks,
    verifiedAt: new Date().toISOString(),
    durationMs,
  });
}

export function verifiedFailure(
  summary: string,
  details: string,
  suggestedActions?: string[],
  checks?: VerificationCheck[],
  durationMs?: number
): string {
  return formatVerifiedResult({
    status: 'VERIFIED_FAILURE',
    summary,
    details,
    verificationChecks: checks,
    suggestedActions,
    verifiedAt: new Date().toISOString(),
    durationMs,
  });
}

export function analyzeOutput(
  output: string,
  patterns: { success: RegExp[]; failure: RegExp[] },
  exitCode?: number
): { isSuccess: boolean; isFailure: boolean; matchedPattern?: string; confidence: 'high' | 'medium' | 'low' } {
  const normalizedOutput = output.normalize('NFC');
  for (const pattern of patterns.failure) {
    if (pattern.test(normalizedOutput)) return { isSuccess: false, isFailure: true, matchedPattern: pattern.source, confidence: 'high' };
  }
  for (const pattern of patterns.success) {
    if (pattern.test(normalizedOutput)) return { isSuccess: true, isFailure: false, matchedPattern: pattern.source, confidence: 'high' };
  }
  if (exitCode !== undefined) {
    if (exitCode !== 0) return { isSuccess: false, isFailure: true, confidence: 'high' };
    return { isSuccess: false, isFailure: false, confidence: 'low' };
  }
  return { isSuccess: false, isFailure: false, confidence: 'low' };
}

export function createCommandCheck(
  checkName: string,
  exitCode: number,
  output: string,
  expectedPatterns?: RegExp[]
): VerificationCheck {
  let passed = exitCode === 0;
  let details = exitCode === 0 ? 'Exit code 0' : `Exit code ${exitCode}`;
  if (expectedPatterns && passed) {
    const foundPattern = expectedPatterns.some((p) => p.test(output));
    if (!foundPattern) {
      passed = false;
      details = 'Exit code 0 but expected output pattern not found';
    }
  }
  return { check: checkName, passed, details };
}

export function safeTruncate(content: string, maxLength: number, _label: string = 'Content'): string {
  if (content.length <= maxLength) return content;
  const hiddenChars = content.length - maxLength;
  return `${content.slice(0, maxLength)}\n\n[... ${hiddenChars} characters truncated]`;
}
