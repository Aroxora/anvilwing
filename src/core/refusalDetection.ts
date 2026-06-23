/**
 * Heuristic: did the model return a safety/policy refusal?
 *
 * Used by the interactive shell to short-circuit the auto-continue
 * loop — a "no, I won't do that" response is the terminal turn rather
 * than a stop the auto-continue logic should bulldoze through with
 * another "continue" prompt. Extracted to a free function so it's
 * unit-testable without standing up the whole shell.
 *
 * Looks at the first ~1KB of the buffered response — refusals lead
 * with the decline, so a substring scan is enough and keeps the cost
 * trivial.
 */
const DECLINE_PHRASES: readonly string[] = [
  "i can't help",
  'i cannot help',
  "i won't help",
  'i will not help',
  "i can't assist",
  'i cannot assist',
  "i won't assist",
  "i'm not going to help",
  'i am not going to help',
  "i'm not able to help",
  'i am not able to help',
  "i'm unable to help",
  "i'm not going to continue",
  "i've declined",
  'i have declined',
  'i decline',
  'i must decline',
  'i need to decline',
  "i'm declining",
  "i'm not comfortable",
  'against my guidelines',
  'against my values',
  'violates my',
];

export function isSafetyRefusal(text: string | null | undefined): boolean {
  if (!text) return false;
  const head = text.slice(0, 1024).toLowerCase();
  if (!head.trim()) return false;
  for (const phrase of DECLINE_PHRASES) {
    if (head.includes(phrase)) return true;
  }
  return false;
}
