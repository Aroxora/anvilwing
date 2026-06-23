/**
 * Transcript copy for parallel sub-agents (Claude Code's Task tool parity).
 * Pure + emoji-free except the ✓/✗ status glyphs already used elsewhere in
 * the shell (UX §9 bans chrome emoji, not status checkmarks).
 */

export interface SubAgentResult {
  description: string;
  success: boolean;
  elapsedMs: number;
}

/** Start line, rendered with the ⏺ action bullet by the shell. */
export function formatSubAgentStart(description: string): string {
  return `Task(${description})`;
}

/** Dim completion line: "✓ Task(label) · 1.2s". */
export function formatSubAgentComplete(r: SubAgentResult): string {
  const tag = r.success ? '✓' : '✗';
  const secs = (Math.max(0, r.elapsedMs) / 1000).toFixed(1);
  return `${tag} Task(${r.description}) · ${secs}s`;
}
