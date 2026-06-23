import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface DiffSegment {
  type: 'added' | 'removed' | 'context';
  lineNumber: number;
  content: string;
}

/**
 * Result from building a diff with context lines
 */
export interface DiffWithContext {
  segments: DiffSegment[];
  additions: number;
  removals: number;
}

export function buildDiffSegments(previous: string, next: string): DiffSegment[] {
  const before = normalizeNewlines(previous);
  const after = normalizeNewlines(next);

  if (before === after) {
    return [];
  }

  const gitSegments = tryBuildWithGit(before, after);
  if (gitSegments) {
    return gitSegments;
  }

  return buildNaiveDiff(before, after);
}

/**
 * Fast in-memory diff algorithm - no git spawning, no temp files.
 * Uses efficient line-by-line comparison with context tracking.
 * ~10x faster than git-based diff for typical edits.
 */
export function buildDiffSegmentsFast(previous: string, next: string): DiffSegment[] {
  const before = normalizeNewlines(previous);
  const after = normalizeNewlines(next);

  if (before === after) {
    return [];
  }

  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const segments: DiffSegment[] = [];

  // Limit output for very large files
  const MAX_DIFF_SEGMENTS = 200;
  const MAX_LINE_LENGTH = 500;

  // Use simple LCS-based approach optimized for typical code edits
  // Most edits are small, so we use a fast path for detecting changed regions
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (segments.length >= MAX_DIFF_SEGMENTS) {
      const remaining = Math.max(oldLines.length - i, newLines.length - j);
      if (remaining > 0) {
        segments.push({
          type: 'added',
          lineNumber: 0,
          content: `[Diff truncated - ${remaining} more lines not shown]`
        });
      }
      break;
    }

    const oldLine = oldLines[i];
    const newLine = newLines[j];

    // Both lines exist and match - skip
    if (oldLine === newLine) {
      i++;
      j++;
      continue;
    }

    // Look ahead to find matching lines (handles insertions/deletions)
    const lookAhead = 10;
    let foundOld = -1;
    let foundNew = -1;

    // Check if current old line appears later in new (deletion followed by same content)
    for (let k = 1; k <= lookAhead && j + k < newLines.length; k++) {
      if (oldLine === newLines[j + k]) {
        foundNew = j + k;
        break;
      }
    }

    // Check if current new line appears later in old (insertion)
    for (let k = 1; k <= lookAhead && i + k < oldLines.length; k++) {
      if (newLine === oldLines[i + k]) {
        foundOld = i + k;
        break;
      }
    }

    // Insertion: new lines were added
    if (foundOld > 0 && (foundNew < 0 || foundNew > foundOld)) {
      while (j < newLines.length && newLines[j] !== oldLines[i]) {
        if (segments.length >= MAX_DIFF_SEGMENTS) break;
        const content = newLines[j] || '';
        segments.push({
          type: 'added',
          lineNumber: j + 1,
          content: content.length > MAX_LINE_LENGTH ? `${content.slice(0, MAX_LINE_LENGTH)  }...` : content
        });
        j++;
      }
      continue;
    }

    // Deletion: old lines were removed
    if (foundNew > 0) {
      while (i < oldLines.length && oldLines[i] !== newLines[j]) {
        if (segments.length >= MAX_DIFF_SEGMENTS) break;
        const content = oldLines[i] || '';
        segments.push({
          type: 'removed',
          lineNumber: i + 1,
          content: content.length > MAX_LINE_LENGTH ? `${content.slice(0, MAX_LINE_LENGTH)  }...` : content
        });
        i++;
      }
      continue;
    }

    // Modification: line changed
    if (typeof oldLine === 'string') {
      const content = oldLine.length > MAX_LINE_LENGTH ? `${oldLine.slice(0, MAX_LINE_LENGTH)  }...` : oldLine;
      segments.push({ type: 'removed', lineNumber: i + 1, content });
      i++;
    }
    if (typeof newLine === 'string') {
      const content = newLine.length > MAX_LINE_LENGTH ? `${newLine.slice(0, MAX_LINE_LENGTH)  }...` : newLine;
      segments.push({ type: 'added', lineNumber: j + 1, content });
      j++;
    }

    // Handle end of one array
    if (i >= oldLines.length && j < newLines.length) {
      j++;
    } else if (j >= newLines.length && i < oldLines.length) {
      i++;
    }
  }

  return segments;
}

// ANSI color codes for terminal output
const ANSI_RESET = '\x1b[0m';
const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_DIM = '\x1b[2m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RED_BOLD = '\x1b[1;31m';
const ANSI_GREEN_BOLD = '\x1b[1;32m';
// Background colors for Claude Code style highlighting

/**
 * Format diff lines with + and - prefixes for added/removed lines.
 * Supports context lines (unchanged lines around changes).
 */
export function formatDiffLines(diff: DiffSegment[], useColors = true): string[] {
  if (!diff.length) {
    return [];
  }
  const width = Math.max(
    1,
    ...diff.map((entry) => Math.max(1, entry.lineNumber).toString().length)
  );

  return diff.map((entry) => {
    const lineNumber = Math.max(1, entry.lineNumber);
    const body = entry.content.length > 0 ? entry.content : '[empty line]';
    const paddedNumber = lineNumber.toString().padStart(width, ' ');

    if (entry.type === 'added') {
      const prefix = '+';
      if (useColors) {
        return `${ANSI_GREEN_BOLD}${prefix} L${paddedNumber} | ${body}${ANSI_RESET}`;
      }
      return `${prefix} L${paddedNumber} | ${body}`;
    } else if (entry.type === 'removed') {
      const prefix = '-';
      if (useColors) {
        return `${ANSI_RED_BOLD}${prefix} L${paddedNumber} | ${body}${ANSI_RESET}`;
      }
      return `${prefix} L${paddedNumber} | ${body}`;
    } else {
      // context line
      if (useColors) {
        return `${ANSI_DIM}  L${paddedNumber} | ${body}${ANSI_RESET}`;
      }
      return `  L${paddedNumber} | ${body}`;
    }
  });
}

/**
 * Format diff in Claude Code style with proper indentation and line wrapping.
 * Shows line numbers in margin with +/- symbols for changes.
 * Long lines are wrapped with continuation markers, but the default width is
 * deliberately generous so single logical lines don't look like multiple edits.
 *
 * Example output:
 *   1832 +    /**
 *        +     * Show a compacting
 *        + status with animated
 */
export function formatDiffClaudeStyle(
  diff: DiffSegment[],
  useColors = true,
  maxLineWidth?: number
): string[] {
  if (!diff.length) {
    return [];
  }

  // Use terminal-aware width so single logical lines don't appear split.
  const wrapWidth = normalizeWrapWidth(maxLineWidth);

  const INDENT = '      '; // 6 spaces for line number column
  const width = Math.max(
    1,
    ...diff.map((entry) => Math.max(1, entry.lineNumber).toString().length)
  );

  const result: string[] = [];

  for (const entry of diff) {
    const lineNumber = Math.max(1, entry.lineNumber);
    const paddedNumber = lineNumber.toString().padStart(width, ' ');
    const continuationPad = ' '.repeat(width); // Same width as line number for continuation

    if (entry.type === 'added') {
      const prefix = ` ${paddedNumber} +`;
      const continuationPrefix = `${continuationPad}    +`; // Align + with first line
      const body = entry.content;

      // Wrap long lines using terminal-aware width
      const wrappedLines = wrapDiffLine(body, wrapWidth);

      for (let i = 0; i < wrappedLines.length; i++) {
        const lineContent = wrappedLines[i];
        const isFirstLine = i === 0;
        const linePrefix = isFirstLine ? prefix : continuationPrefix;

        if (useColors) {
          result.push(`${ANSI_GREEN_BOLD}${INDENT}${linePrefix}   ${lineContent}${ANSI_RESET}`);
        } else {
          result.push(`${INDENT}${linePrefix}   ${lineContent}`);
        }
      }
    } else if (entry.type === 'removed') {
      const prefix = ` ${paddedNumber} -`;
      const continuationPrefix = `${continuationPad}    -`; // Align - with first line
      const body = entry.content;

      // Wrap long lines using terminal-aware width
      const wrappedLines = wrapDiffLine(body, wrapWidth);

      for (let i = 0; i < wrappedLines.length; i++) {
        const lineContent = wrappedLines[i];
        const isFirstLine = i === 0;
        const linePrefix = isFirstLine ? prefix : continuationPrefix;

        if (useColors) {
          result.push(`${ANSI_RED_BOLD}${INDENT}${linePrefix}   ${lineContent}${ANSI_RESET}`);
        } else {
          result.push(`${INDENT}${linePrefix}   ${lineContent}`);
        }
      }
    } else {
      // context line - no wrapping for context
      const prefix = ` ${paddedNumber}  `;
      const body = entry.content;
      if (useColors) {
        result.push(`${ANSI_DIM}${INDENT}${prefix}  ${body}${ANSI_RESET}`);
      } else {
        result.push(`${INDENT}${prefix}  ${body}`);
      }
    }
  }

  return result;
}

function normalizeWrapWidth(maxLineWidth?: number): number {
  // Honor explicit width when provided
  if (typeof maxLineWidth === 'number' && Number.isFinite(maxLineWidth) && maxLineWidth > 0) {
    return Math.max(40, Math.floor(maxLineWidth));
  }

  const terminalWidth = typeof process.stdout?.columns === 'number' && process.stdout.columns > 0
    ? process.stdout.columns
    : null;

  // Default to a generous width so single logical lines don't render as multiple edits.
  // We intentionally avoid shrinking to the terminal width; the terminal can wrap naturally
  // without adding extra +/- prefixes that look like new lines.
  const baseWidth = terminalWidth ? Math.max(terminalWidth - 8, 120) : 240;

  // Cap to avoid runaway wrapping for extremely long lines while keeping most code unwrapped.
  return Math.max(200, Math.min(baseWidth, 500));
}

/**
 * Wrap a diff line at word boundaries if it exceeds maxWidth.
 * Preserves leading whitespace on first line.
 */
function wrapDiffLine(line: string, maxWidth: number): string[] {
  const width = Math.max(1, Math.floor(maxWidth));

  if (line.length <= width) {
    return [line];
  }

  const result: string[] = [];
  let remaining = line;

  while (remaining.length > width) {
    // Find a good break point (space, or force break at maxWidth)
    let breakPoint = remaining.lastIndexOf(' ', width);
    if (breakPoint <= 0) {
      // No space found, force break
      breakPoint = width;
    }

    result.push(remaining.substring(0, breakPoint));
    remaining = remaining.substring(breakPoint).trimStart();
  }

  if (remaining.length > 0) {
    result.push(remaining);
  }

  return result.length > 0 ? result : [''];
}

function tryBuildWithGit(before: string, after: string): DiffSegment[] | null {
  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'agi-diff-'));
    const originalPath = join(tempDir, 'before.txt');
    const updatedPath = join(tempDir, 'after.txt');
    writeFileSync(originalPath, before, 'utf8');
    writeFileSync(updatedPath, after, 'utf8');

    const result = spawnSync(
      'git',
      ['--no-pager', 'diff', '--no-index', '--unified=0', '--color=never', '--', originalPath, updatedPath],
      { encoding: 'utf8' }
    );

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return null;
      }
      return null;
    }

    if (typeof result.status === 'number' && result.status > 1) {
      return null;
    }

    return parseUnifiedDiff(result.stdout);
  } catch {
    return null;
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function parseUnifiedDiff(output: string): DiffSegment[] {
  if (!output.trim()) {
    return [];
  }

  const lines = output.split('\n');
  const segments: DiffSegment[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) {
      continue;
    }
    if (line.startsWith('@@')) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match?.[1] && match?.[2]) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      continue;
    }

    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      continue;
    }

    if (line.startsWith('Binary ')) {
      continue;
    }

    if (line.startsWith('\\')) {
      continue;
    }

    if (line.startsWith('+')) {
      segments.push({ type: 'added', lineNumber: newLine, content: line.slice(1) });
      newLine += 1;
      continue;
    }

    if (line.startsWith('-')) {
      segments.push({ type: 'removed', lineNumber: oldLine, content: line.slice(1) });
      oldLine += 1;
      continue;
    }

    if (line.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
      continue;
    }
  }

  return segments;
}

function buildNaiveDiff(before: string, after: string): DiffSegment[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const max = Math.max(a.length, b.length);
  const segments: DiffSegment[] = [];

  // Limit diff output for very large files to prevent memory issues
  const MAX_DIFF_SEGMENTS = 500;
  const MAX_LINE_LENGTH = 1000;

  for (let index = 0; index < max; index += 1) {
    // Stop if we've collected too many segments
    if (segments.length >= MAX_DIFF_SEGMENTS) {
      segments.push({
        type: 'added',
        lineNumber: 0,
        content: `[Diff truncated - ${max - index} more lines not shown]`
      });
      break;
    }

    const left = a[index];
    const right = b[index];

    if (left === right) {
      continue;
    }

    if (typeof left === 'string') {
      // Truncate very long lines to prevent display issues
      const content = left.length > MAX_LINE_LENGTH
        ? `${left.slice(0, MAX_LINE_LENGTH)  }...`
        : left;
      segments.push({ type: 'removed', lineNumber: index + 1, content });
    }

    if (typeof right === 'string') {
      // Truncate very long lines to prevent display issues
      const content = right.length > MAX_LINE_LENGTH
        ? `${right.slice(0, MAX_LINE_LENGTH)  }...`
        : right;
      segments.push({ type: 'added', lineNumber: index + 1, content });
    }
  }

  return segments;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function splitLines(value: string): string[] {
  if (!value) {
    return [];
  }
  const normalized = normalizeNewlines(value);
  return normalized.split('\n');
}

/**
 * Build a diff with context lines around changes (Anvilwing CLI style).
 * Shows N lines before and after each change, with ... truncation for gaps.
 */
export function buildDiffWithContext(
  previous: string,
  next: string,
  contextLines = 2
): DiffWithContext {
  const before = normalizeNewlines(previous);
  const after = normalizeNewlines(next);

  if (before === after) {
    return { segments: [], additions: 0, removals: 0 };
  }

  const oldLines = splitLines(before);
  const newLines = splitLines(after);

  // First, identify all changed line indices
  const changes: Array<{
    type: 'added' | 'removed';
    lineNumber: number;
    content: string;
    newLineIndex?: number;
    oldLineIndex?: number;
  }> = [];

  // Simple LCS to find changes
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    const oldLine = oldLines[i];
    const newLine = newLines[j];

    if (oldLine === newLine) {
      i++;
      j++;
      continue;
    }

    // Look ahead for matching lines
    const lookAhead = 15;
    let foundInNew = -1;
    let foundInOld = -1;

    for (let k = 1; k <= lookAhead && j + k < newLines.length; k++) {
      if (oldLine === newLines[j + k]) {
        foundInNew = j + k;
        break;
      }
    }

    for (let k = 1; k <= lookAhead && i + k < oldLines.length; k++) {
      if (newLine === oldLines[i + k]) {
        foundInOld = i + k;
        break;
      }
    }

    // Insertion
    if (foundInOld > 0 && (foundInNew < 0 || foundInNew > foundInOld)) {
      while (j < newLines.length && newLines[j] !== oldLines[i]) {
        changes.push({
          type: 'added',
          lineNumber: j + 1,
          content: newLines[j] || '',
          newLineIndex: j,
        });
        j++;
      }
      continue;
    }

    // Deletion
    if (foundInNew > 0) {
      while (i < oldLines.length && oldLines[i] !== newLines[j]) {
        changes.push({
          type: 'removed',
          lineNumber: i + 1,
          content: oldLines[i] || '',
          oldLineIndex: i,
        });
        i++;
      }
      continue;
    }

    // Modification
    if (typeof oldLine === 'string') {
      changes.push({
        type: 'removed',
        lineNumber: i + 1,
        content: oldLine,
        oldLineIndex: i,
      });
      i++;
    }
    if (typeof newLine === 'string') {
      changes.push({
        type: 'added',
        lineNumber: j + 1,
        content: newLine,
        newLineIndex: j,
      });
      j++;
    }

    if (i >= oldLines.length && j < newLines.length) {
      j++;
    } else if (j >= newLines.length && i < oldLines.length) {
      i++;
    }
  }

  // Count additions and removals
  const additions = changes.filter((c) => c.type === 'added').length;
  const removals = changes.filter((c) => c.type === 'removed').length;

  // Now build segments with context
  // Group changes that are close together
  const segments: DiffSegment[] = [];
  const changeIndices = new Set<number>();
  const removedIndices = new Set<number>();

  for (const change of changes) {
    if (change.type === 'added' && change.newLineIndex !== undefined) {
      changeIndices.add(change.newLineIndex);
    }
    if (change.type === 'removed' && change.oldLineIndex !== undefined) {
      removedIndices.add(change.oldLineIndex);
    }
  }

  // For each change, include context lines
  const linesToShow = new Set<number>();
  for (const change of changes) {
    if (change.type === 'added' && change.newLineIndex !== undefined) {
      const idx = change.newLineIndex;
      for (let k = Math.max(0, idx - contextLines); k <= Math.min(newLines.length - 1, idx + contextLines); k++) {
        linesToShow.add(k);
      }
    }
  }

  // Build final segments in order
  let lastLineShown = -1;
  const sortedLines = Array.from(linesToShow).sort((a, b) => a - b);

  for (const lineIdx of sortedLines) {
    // Add truncation marker if there's a gap
    if (lastLineShown >= 0 && lineIdx > lastLineShown + 1) {
      segments.push({
        type: 'context',
        lineNumber: 0,
        content: '...',
      });
    }

    if (changeIndices.has(lineIdx)) {
      segments.push({
        type: 'added',
        lineNumber: lineIdx + 1,
        content: newLines[lineIdx] || '',
      });
    } else {
      segments.push({
        type: 'context',
        lineNumber: lineIdx + 1,
        content: newLines[lineIdx] || '',
      });
    }
    lastLineShown = lineIdx;
  }

  // Add removed lines (show them before the context around their location)
  // Rebuild segments to interleave removals properly
  const finalSegments: DiffSegment[] = [];
  let changeIdx = 0;

  for (const seg of segments) {
    // Insert any removals that come before this line
    while (changeIdx < changes.length) {
      const change = changes[changeIdx];
      if (!change) break;
      if (change.type === 'removed') {
        // Find where this removal should go - before the added line at same position
        const removedOldIdx = change.oldLineIndex ?? 0;
        // If we're showing an added line that replaced this removed line
        const matchingAdd = changes.find(
          (c) => c.type === 'added' && c.newLineIndex !== undefined && Math.abs((c.newLineIndex) - removedOldIdx) <= 1
        );
        if (matchingAdd && seg.type === 'added' && seg.lineNumber === (matchingAdd.newLineIndex ?? 0) + 1) {
          finalSegments.push({
            type: 'removed',
            lineNumber: change.lineNumber,
            content: change.content,
          });
          changeIdx++;
          continue;
        }
      }
      break;
    }
    finalSegments.push(seg);
  }

  // Add any remaining removals at the end
  while (changeIdx < changes.length) {
    const change = changes[changeIdx];
    if (!change) break;
    if (change.type === 'removed') {
      finalSegments.push({
        type: 'removed',
        lineNumber: change.lineNumber,
        content: change.content,
      });
    }
    changeIdx++;
  }

  return { segments: finalSegments.length > 0 ? finalSegments : changes, additions, removals };
}
