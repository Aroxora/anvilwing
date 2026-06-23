/**
 * Ensures final assistant responses include a "Next steps" section.
 * Returns both the full output and any appended text so callers can stream just the delta.
 */
export interface FinalResponseFormat {
  output: string;
  appended: string | null;
}

const NEXT_STEPS_HEADING = /(^|\n)\s*next steps?\s*:/i;

export function ensureNextSteps(content: string, _context?: string): FinalResponseFormat {
  const normalized = content?.trimEnd() ?? '';
  if (!normalized) {
    return { output: '', appended: null };
  }

  // If content already has next steps, return as-is (no duplicates)
  if (NEXT_STEPS_HEADING.test(normalized)) {
    return { output: normalized, appended: null };
  }

  // Don't auto-append next steps - let the AI generate contextually appropriate ones
  return { output: normalized, appended: null };
}
