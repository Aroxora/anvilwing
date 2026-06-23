/**
 * Centralized guidance for bash command flows.
 * Keeps publish/git heuristics in one place so bash tooling stays concise.
 */

export type BashFlowSeverity = 'info' | 'warning' | 'critical';

export interface BashFlowWarning {
  readonly code: string;
  readonly message: string;
  readonly suggestion?: string;
  readonly severity?: BashFlowSeverity;
}

/**
 * Analyze a bash command for common workflow gaps (publish, git efficiency).
 */
export function analyzeBashFlow(command: string): BashFlowWarning[] {
  const warnings: BashFlowWarning[] = [];
  const normalized = command.toLowerCase();

  if (!normalized.trim()) {
    return warnings;
  }

  // Git efficiency: avoid repeated status calls in a single command chain.
  const gitStatusMatches = normalized.match(/git status/g);
  if (gitStatusMatches && gitStatusMatches.length > 1) {
    warnings.push({
      code: 'GIT_REDUNDANT_STATUS',
      message: 'Multiple git status calls detected in one command',
      suggestion: 'Combine git operations: git add -A && git commit -m "msg" && git push',
      severity: 'info',
    });
  }

  // python -c with a compound statement after a `;`, or nested double-quotes
  // inside a double-quoted body, is the exact failure seen in the wild:
  //   python3 -c "import json; d=json.load(...); for m in d['x']: print(d["k"])"
  // The `for`/`if`/`def`/… can't follow `;` in a -c simple-statement list
  // (SyntaxError), and the inner `"` closes the shell quote early. A single
  // compound (python3 -c "for i in range(3): print(i)") is fine and must NOT
  // trip — that's why this keys on a compound AFTER a semicolon, not anywhere.
  if (/\bpython3?\s+-c\b/.test(command)) {
    const compoundAfterSemicolon = /;\s*(for|while|if|elif|else|try|except|finally|with|def|class|async)\b/.test(command);
    const nestedDoubleQuote = /-c\s+"[^"]*"[^"]*"/.test(command);
    if (compoundAfterSemicolon || nestedDoubleQuote) {
      warnings.push({
        code: 'PYTHON_INLINE_MULTISTATEMENT',
        message: 'python -c with a loop/def after `;` or nested double-quotes fails (SyntaxError / broken shell quoting)',
        suggestion: "Use a quoted-delimiter heredoc so loops and inner quotes work as-is: python3 - <<'PY' / …multi-line script… / PY  (or write a temp .py file and run it).",
        severity: 'warning',
      });
    }
  }

  // Publish flow completeness for npm-style commands.
  if (normalized.includes('npm publish')) {
    const hasVersionStep = /\b(?:npm|pnpm|yarn)\s+version\b/.test(normalized);
    const hasBuildOrTests = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(build|test|lint|prepare)\b/.test(normalized);
    const hasGitPush = /\bgit\s+push\b/.test(normalized);

    if (!(hasVersionStep && hasBuildOrTests && hasGitPush)) {
      warnings.push({
        code: 'NPM_INCOMPLETE_WORKFLOW',
        message: 'npm publish detected without a complete release flow',
        suggestion: 'Include version bump, build/tests, and git push or use npm_publish to automate the full release',
        severity: 'warning',
      });
    }
  }

  return warnings;
}
