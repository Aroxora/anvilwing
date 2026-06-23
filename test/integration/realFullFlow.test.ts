/**
 * Real full-flow integration test.
 *
 * Uses the shared full-flow runner to drive the CLI with long-form,
 * human-style prompts and asserts that real provider usage and validated
 * completions occur. Only runs when RUN_REAL_LLM_TESTS=1 and a provider
 * key are present to avoid accidental live calls.
 */

import { describe, test, jest } from '@jest/globals';

const hasProviderKey =
  Boolean(process.env.ANTHROPIC_API_KEY) ||
  Boolean(process.env.OPENAI_API_KEY) ||
  Boolean(process.env.GOOGLE_GENAI_API_KEY);

const realTestsEnabled = process.env.RUN_REAL_LLM_TESTS === '1' && hasProviderKey;

function parsePrompts(defaultPrompts: string[]): string[] {
  if (process.env.PROMPTS) {
    try {
      const parsed = JSON.parse(process.env.PROMPTS);
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
        return parsed.map((p) => p.trim()).filter(Boolean);
      }
    } catch {
      // fall back to default prompts
    }
  }
  return defaultPrompts;
}

describe('real full-flow CLI run', () => {
  (realTestsEnabled ? test : test.skip)('completes long-form prompts end-to-end with validation', async () => {
    jest.setTimeout(300_000); // allow up to 5 minutes for live provider

    const { DEFAULT_PROMPTS, runFullFlow, validateFullFlow } = await import('../../scripts/full-flow-runner.js');
    const prompts = parsePrompts(DEFAULT_PROMPTS);

    const result = await runFullFlow({
      prompts,
      profile: process.env.PROFILE?.trim() || 'anvilwing-code',
      provider: process.env.PROVIDER?.trim(),
      model: process.env.MODEL?.trim(),
      sessionId: `real-flow-${Date.now()}`,
      requireReal: true,
    });

    const summary = validateFullFlow(result, {
      minMessageChars: 120,
      requireUsage: true,
      rejectSimulation: true,
      minEvents: 2,
      requireRunCount: true,
    });

    expect(summary.completedRuns).toBe(prompts.length);
    expect(summary.runsWithUsage).toBeGreaterThanOrEqual(prompts.length);
    expect(summary.session).toBeTruthy();
    expect(result.runs).toHaveLength(prompts.length);
    for (const run of result.runs) {
      expect(run.eventsSeen).toBeGreaterThanOrEqual(2);
    }
  });
});
