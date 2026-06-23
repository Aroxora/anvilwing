/**
 * Adversarial auto-correction.
 *
 * The always-on adversarial reviewer (agent.ts maybeAdversarialReview) was
 * advisory-only: it refuted a draft, appended a "⚠ Adversarial review:" caveat,
 * and returned — the critic spoke and was ignored. This closes the loop: a
 * FAILED review is signalled to the shell, whose auto-continue loop re-runs the
 * FULL tool-executing agent with a correction prompt (so it edits + re-verifies,
 * not just re-describes), bounded by the turn governor + a per-request cap so it
 * can't loop forever.
 *
 * Pure → unit-testable.
 */

export const MAX_ADVERSARIAL_CORRECTIONS = 2;

/**
 * Build the correction prompt from reviewer findings. Prefixed IMPORTANT: so the
 * auto-continue loop treats it as a continuation (not a fresh user request that
 * would reset the governor), and it instructs the agent to FIX + re-verify
 * rather than restate the problem.
 */
export function buildAdversarialCorrectionPrompt(findings: string): string {
  const f = (findings ?? '').trim();
  return `IMPORTANT: Do NOT create docs/markdown. An adversarial review of your last answer found problems:\n${f}\n\nFix them now — edit the actual file(s), then re-run the relevant test/build/command to confirm. Do not just describe the fix or restate the issue; make the change and verify it.`;
}
