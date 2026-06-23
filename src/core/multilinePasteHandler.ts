/**
 * Handles multi-line paste detection and summarization
 * Provides graceful handling of large text blocks pasted into chat
 */

export interface PasteSummary {
  isMultiline: boolean;
  lineCount: number;
  charCount: number;
  preview: string;
  language?: string;
  summary: string;
}

/**
 * Detect if text is a multi-line paste (3+ lines)
 */
export function isMultilinePaste(text: string): boolean {
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  return lines.length >= 3;
}

/**
 * Detect likely programming language from content
 */
function detectLanguage(text: string): string | undefined {
  const patterns: Record<string, RegExp> = {
    javascript: /\b(const|let|var|function|async|await|import|export|=>)\b/,
    typescript: /\b(interface|type|enum|namespace|declare|as const)\b/,
    python: /\b(def|class|import|from|if __name__|async def)\b/,
    json: /^\s*(?:\{|\[).*(?:\}|\])\s*$/,
    html: /^<[a-z]/i,
    css: /^\s*[.#[]?[\w-]+\s*{/,
    sql: /\b(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|TABLE)\b/i,
    bash: /^#!/,
    yaml: /^[\w-]+:\s*\S/m,
  };

  for (const [lang, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) {
      return lang;
    }
  }

  return undefined;
}

/**
 * Generate a concise summary of pasted content
 */
export function generatePasteSummary(text: string): PasteSummary {
  const lines = text.split('\n');
  const nonEmptyLines = lines.filter(line => line.trim().length > 0);
  const charCount = text.length;
  const lineCount = nonEmptyLines.length;
  const language = detectLanguage(text);

  // Create preview: first 60 chars or first line
  let preview = nonEmptyLines[0]?.substring(0, 60) || '';
  if (preview.length === 60) {
    preview += '...';
  }

  // Generate summary description
  const summaryParts: string[] = [];

  if (language) {
    summaryParts.push(`${language.toUpperCase()}`);
  }

  summaryParts.push(`${lineCount} line${lineCount !== 1 ? 's' : ''}`);
  summaryParts.push(`${charCount} char${charCount !== 1 ? 's' : ''}`);

  const summary = `📋 Pasted: ${summaryParts.join(' • ')}`;

  return {
    isMultiline: true,
    lineCount,
    charCount,
    preview,
    language,
    summary,
  };
}

/**
 * Format a paste for display - returns the full content instead of a summary
 */
export function formatPasteSummaryForDisplay(summary: PasteSummary): string {
  // Return empty string - the UI should display the full content directly
  return "";
}

/**
 * Create a display-friendly version of multi-line content
 * Returns both the summary for display and the full content for sending
 */
export interface ProcessedPaste {
  displaySummary: string;
  fullContent: string;
  metadata: PasteSummary;
}

export function processPaste(text: string): ProcessedPaste {
  const summary = generatePasteSummary(text);
  const displaySummary = formatPasteSummaryForDisplay(summary);

  return {
    displaySummary,
    fullContent: text,
    metadata: summary,
  };
}
