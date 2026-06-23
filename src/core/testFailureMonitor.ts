/**
 * Test Failure Monitor - Real-time monitoring of test output for early abort
 *
 * Detects test failures as they stream and can trigger early abort to allow
 * the AI to pivot and replan instead of waiting for a broken test suite to finish.
 */

export interface TestMonitorConfig {
  /** Number of test failures before triggering early abort (default: 3) */
  failureThreshold: number;
  /** Whether to abort on first compilation error (default: true) */
  abortOnCompileError: boolean;
  /** Minimum time (ms) to wait before considering abort (default: 5000) */
  minRunTime: number;
  /** Maximum consecutive failures before abort (default: 2) */
  maxConsecutiveFailures: number;
}

export interface TestMonitorState {
  failedTests: string[];
  passedTests: number;
  totalTests: number;
  hasCompileError: boolean;
  consecutiveFailures: number;
  shouldAbort: boolean;
  abortReason: string | null;
  suggestions: string[];
}

const DEFAULT_CONFIG: TestMonitorConfig = {
  failureThreshold: 3,
  abortOnCompileError: true,
  minRunTime: 5000,
  maxConsecutiveFailures: 2,
};

// Patterns for detecting various test runner outputs
const TEST_PATTERNS = {
  // Jest patterns
  jestFail: /FAIL\s+(.+\.(?:test|spec)\.[jt]sx?)/,
  jestPass: /PASS\s+(.+\.(?:test|spec)\.[jt]sx?)/,
  jestTestFail: /✕\s+(.+)/,
  jestTestPass: /✓\s+(.+)/,
  jestSummaryFail: /Tests:\s+(\d+)\s+failed/,

  // Vitest patterns
  vitestFail: /❌\s+(.+)/,
  vitestPass: /✓\s+(.+)/,

  // Mocha patterns
  mochaFail: /\d+\)\s+(.+)/,
  mochaPass: /✔\s+(.+)/,

  // Generic test patterns
  genericFail: /(?:FAILED|FAILURE|ERROR)[\s:]+(.+)/i,
  assertionFail: /(?:AssertionError|Expected|assert)/i,

  // Compilation/Build errors (should abort immediately)
  compileError: /(?:SyntaxError|TypeError|ReferenceError|Cannot find module|Module not found|error TS\d+)/i,
  buildFail: /(?:Build failed|Compilation failed|Failed to compile)/i,

  // Test suite crash
  suiteCrash: /(?:Test suite failed to run|Could not find|Cannot read|Unhandled promise rejection)/i,
};

export class TestFailureMonitor {
  private config: TestMonitorConfig;
  private state: TestMonitorState;
  private startTime: number;
  private recentLines: string[] = [];
  private readonly MAX_RECENT_LINES = 50;

  constructor(config: Partial<TestMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.createInitialState();
    this.startTime = Date.now();
  }

  private createInitialState(): TestMonitorState {
    return {
      failedTests: [],
      passedTests: 0,
      totalTests: 0,
      hasCompileError: false,
      consecutiveFailures: 0,
      shouldAbort: false,
      abortReason: null,
      suggestions: [],
    };
  }

  /**
   * Process a line of test output in real-time
   * Returns true if we should abort
   */
  processLine(line: string): boolean {
    // Track recent lines for context
    this.recentLines.push(line);
    if (this.recentLines.length > this.MAX_RECENT_LINES) {
      this.recentLines.shift();
    }

    // Check for compile/build errors first (highest priority)
    if (TEST_PATTERNS.compileError.test(line) || TEST_PATTERNS.buildFail.test(line)) {
      this.state.hasCompileError = true;
      if (this.config.abortOnCompileError) {
        this.state.shouldAbort = true;
        this.state.abortReason = 'Compilation/build error detected';
        this.state.suggestions = [
          'Fix the compilation error before running tests',
          'Check for syntax errors or missing imports',
          'Run the build separately to see full error output',
        ];
        return true;
      }
    }

    // Check for test suite crash
    if (TEST_PATTERNS.suiteCrash.test(line)) {
      this.state.shouldAbort = true;
      this.state.abortReason = 'Test suite crashed before tests could run';
      this.state.suggestions = [
        'Check test configuration and setup files',
        'Verify all test dependencies are installed',
        'Look for initialization errors in beforeAll/beforeEach hooks',
      ];
      return true;
    }

    // Check for test file failures (Jest/Vitest)
    const failMatch = line.match(TEST_PATTERNS.jestFail);
    if (failMatch) {
      const testFile = failMatch[1];
      if (testFile && !this.state.failedTests.includes(testFile)) {
        this.state.failedTests.push(testFile);
        this.state.consecutiveFailures++;
        this.state.totalTests++;
      }
    }

    // Check for individual test failures
    if (TEST_PATTERNS.jestTestFail.test(line) ||
        TEST_PATTERNS.vitestFail.test(line) ||
        TEST_PATTERNS.assertionFail.test(line)) {
      this.state.consecutiveFailures++;
    }

    // Check for passing tests (reset consecutive failures)
    if (TEST_PATTERNS.jestPass.test(line) ||
        TEST_PATTERNS.jestTestPass.test(line) ||
        TEST_PATTERNS.vitestPass.test(line) ||
        TEST_PATTERNS.mochaPass.test(line)) {
      this.state.passedTests++;
      this.state.totalTests++;
      this.state.consecutiveFailures = 0; // Reset on pass
    }

    // Check abort conditions
    return this.checkAbortConditions();
  }

  private checkAbortConditions(): boolean {
    const elapsed = Date.now() - this.startTime;

    // Don't abort too early - let some tests run first
    if (elapsed < this.config.minRunTime) {
      return false;
    }

    // Check failure threshold
    if (this.state.failedTests.length >= this.config.failureThreshold) {
      this.state.shouldAbort = true;
      this.state.abortReason = `${this.state.failedTests.length} test files have failed`;
      this.state.suggestions = this.generateSuggestions();
      return true;
    }

    // Check consecutive failures
    if (this.state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      // Only abort if we've seen some test activity
      if (this.state.totalTests > 0) {
        this.state.shouldAbort = true;
        this.state.abortReason = `${this.state.consecutiveFailures} consecutive test failures detected`;
        this.state.suggestions = this.generateSuggestions();
        return true;
      }
    }

    return false;
  }

  private generateSuggestions(): string[] {
    const suggestions: string[] = [];

    if (this.state.failedTests.length > 0) {
      suggestions.push(`Focus on fixing the first failing test: ${this.state.failedTests[0]}`);
      suggestions.push('Run the specific failing test in isolation to see full output');
    }

    if (this.state.hasCompileError) {
      suggestions.push('Fix compilation errors before running the full test suite');
    }

    if (this.state.consecutiveFailures > 2) {
      suggestions.push('Multiple consecutive failures suggest a common root cause');
      suggestions.push('Check recent changes that might affect multiple tests');
    }

    suggestions.push('Consider running tests incrementally as you fix each issue');

    return suggestions;
  }

  /**
   * Get the current monitoring state
   */
  getState(): TestMonitorState {
    return { ...this.state };
  }

  /**
   * Get recent output lines for context
   */
  getRecentOutput(): string {
    return this.recentLines.join('\n');
  }

  /**
   * Format abort message for AI consumption
   */
  formatAbortMessage(): string {
    if (!this.state.shouldAbort) {
      return '';
    }

    const lines: string[] = [
      '',
      '═══ EARLY ABORT - REPLAN RECOMMENDED ═══',
      '',
      `Reason: ${this.state.abortReason}`,
      '',
      'Test Status:',
      `  • Failed test files: ${this.state.failedTests.length}`,
      `  • Passed tests: ${this.state.passedTests}`,
      `  • Has compile error: ${this.state.hasCompileError ? 'YES' : 'no'}`,
      '',
    ];

    if (this.state.failedTests.length > 0) {
      lines.push('Failed test files:');
      for (const test of this.state.failedTests.slice(0, 5)) {
        lines.push(`  ✗ ${test}`);
      }
      if (this.state.failedTests.length > 5) {
        lines.push(`  ... and ${this.state.failedTests.length - 5} more`);
      }
      lines.push('');
    }

    lines.push('Suggested Actions:');
    for (const suggestion of this.state.suggestions) {
      lines.push(`  → ${suggestion}`);
    }
    lines.push('');
    lines.push('The test run was aborted early to save time. Please replan your approach.');

    return lines.join('\n');
  }

  /**
   * Reset the monitor for a new test run
   */
  reset(): void {
    this.state = this.createInitialState();
    this.startTime = Date.now();
    this.recentLines = [];
  }
}

/**
 * Detect if a command is likely a test command
 */
export function isTestCommand(command: string): boolean {
  const cmd = command.toLowerCase();
  return (
    cmd.includes('npm test') ||
    cmd.includes('npm run test') ||
    cmd.includes('yarn test') ||
    cmd.includes('pnpm test') ||
    cmd.includes('jest') ||
    cmd.includes('vitest') ||
    cmd.includes('mocha') ||
    cmd.includes('ava') ||
    cmd.includes('tap') ||
    cmd.includes('pytest') ||
    cmd.includes('go test') ||
    cmd.includes('cargo test') ||
    cmd.includes('rspec') ||
    /\btest\b/.test(cmd)
  );
}

/**
 * Create a test monitor with sensible defaults based on command
 */
export function createTestMonitor(command: string): TestFailureMonitor | null {
  if (!isTestCommand(command)) {
    return null;
  }

  // Adjust config based on command type
  const config: Partial<TestMonitorConfig> = {};

  // For watch mode, be more lenient
  if (command.includes('--watch') || command.includes('-w')) {
    config.failureThreshold = 5;
    config.minRunTime = 10000;
  }

  // For CI-like commands, be more aggressive about early abort
  if (command.includes('--ci') || command.includes('--coverage')) {
    config.failureThreshold = 2;
    config.minRunTime = 3000;
  }

  return new TestFailureMonitor(config);
}
