/**
 * Shared constants used across the orchestration stack.
 */
export const TASK_FULLY_COMPLETE = 'TASK_FULLY_COMPLETE';

/**
 * NO SIMULATIONS POLICY
 *
 * This system executes REAL operations only. Simulations, mocks, fake data,
 * and hypothetical scenarios are strictly forbidden in production output.
 *
 * Forbidden patterns:
 * - "simulated", "simulation", "hypothetical", "theoretical"
 * - "fake", "mock", "dummy", "pretend", "imaginary"
 * - "would be", "could be", "might be" (speculative results)
 * - Creating fictional reports, summaries, or deliverables
 * - Generating random/synthetic data disguised as real results
 */
export const NO_SIMULATIONS_POLICY = `STRICT NO-SIMULATION POLICY:
- Execute REAL operations only - NO simulations, NO mocks, NO fake data
- Never create fictional reports, summaries, or deliverables
- Never generate "simulated" results or hypothetical outcomes
- If a task cannot be executed for real, report inability clearly
- All outputs must be genuine results from actual execution
- Forbidden words in deliverables: "simulated", "hypothetical", "theoretical", "mock", "fake"
`;

/**
 * Patterns that indicate simulation/fake content in output
 */
export const SIMULATION_PATTERNS = [
  /\bsimulat(?:ed?|ion|ing)\b/i,
  /\bhypothetical\b/i,
  /\btheoretical(?:ly)?\b/i,
  /\bfake\s+(?:data|report|result|output)/i,
  /\bmock(?:ed|ing)?\s+(?:data|report|result|output)/i,
  /\bdummy\s+(?:data|report|result|output)/i,
  /\bpretend(?:ed|ing)?\b/i,
  /\bimaginary\b/i,
  /\bfictional\b/i,
  /\bfor\s+(?:demonstration|demo)\s+purposes?\s+only/i,
  /\bnot\s+(?:a\s+)?real\b/i,
  /\bwould\s+(?:have\s+)?be(?:en)?\s+(?:the\s+)?result/i,
];

/**
 * Check if content contains simulation indicators
 */
export function containsSimulationIndicators(content: string): boolean {
  return SIMULATION_PATTERNS.some(pattern => pattern.test(content));
}

/**
 * Extract simulation indicator matches from content
 */
export function findSimulationIndicators(content: string): string[] {
  const matches: string[] = [];
  for (const pattern of SIMULATION_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      matches.push(match[0]);
    }
  }
  return matches;
}
