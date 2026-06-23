import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join, relative, dirname, isAbsolute } from 'node:path';
import type { ToolDefinition } from '../core/toolRuntime.js';
import { expandHome } from '../utils/pathUtils.js';
import { buildError } from '../core/errors.js';
import { buildDiffSegmentsFast, formatDiffLines, buildDiffWithContext, formatDiffClaudeStyle } from './diffUtils.js';
import { logDebug } from '../utils/debugLogger.js';
import { validateReadForEditEx, recordFileRead, hashContent, type ReadValidationResult } from './fileReadTracker.js';
import { recordFileChange } from './fileChangeTracker.js';

/**
 * Track edit attempts per file to detect when edits keep being reverted (e.g., by linters/hooks)
 */
const fileEditAttempts = new Map<string, { count: number; lastContent: string; lastTimestamp: number }>();
const MAX_EDIT_ATTEMPTS_PER_FILE = 3;
const EDIT_ATTEMPT_RESET_MS = 60000; // Reset counter after 1 minute of no edits

/**
 * Creates the Edit tool for surgical file modifications using exact string replacement.
 *
 * This tool performs string-based edits without requiring full file rewrites,
 * making it ideal for targeted changes while preserving exact formatting and indentation.
 *
 * Features:
 * - Exact string matching (preserves indentation)
 * - Replace all occurrences or enforce uniqueness
 * - Unified diff preview
 * - Validation before writing
 *
 * @param workingDir - The working directory for resolving relative paths
 * @returns Array containing the Edit tool definition
 */
export function createEditTools(workingDir: string): ToolDefinition[] {
  return [
    {
      name: 'Edit',
      description:
        'Performs exact string replacements in files. CRITICAL: For existing files, you MUST use the Read tool FIRST to get the exact text including whitespace and indentation, then copy it into old_string. The edit will FAIL if old_string is not unique unless replace_all is true. To CREATE a new file, use empty old_string (no prior read needed). To DELETE text, use empty new_string. For multiple edits to the SAME file, prefer MultiEdit.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'The absolute path to the file to modify or create',
          },
          old_string: {
            type: 'string',
            description: 'The exact text to replace (must match precisely including whitespace and indentation). For existing files, use read_file FIRST, then copy the exact text from its output (excluding line numbers). Use empty string "" to create a new file without needing a prior read.',
          },
          new_string: {
            type: 'string',
            default: '',
            description:
              'The text to replace it with. Use empty string "" to delete the old_string. For new files, this is the full content. Defaults to "" when omitted.',
          },
          replace_all: {
            type: 'boolean',
            description:
              'Replace all occurrences of old_string (default false). When false, the edit fails if old_string appears multiple times.',
          },
        },
        required: ['file_path', 'old_string'],
        additionalProperties: false,
      },
      handler: async (args) => performSurgicalEdit(workingDir, args),
    },
    {
      name: 'MultiEdit',
      description:
        'Apply MULTIPLE exact string edits to a single file in one atomic operation. Edits are applied IN ORDER (each subsequent edit sees the results of the previous one). If ANY edit fails (old_string not found / not unique), the WHOLE batch is rolled back — the file is left untouched. Use this when you need to make several related changes to one file: it\'s faster than N separate Edit calls and prevents the file ending up in a half-edited state.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The absolute path to the file to modify.' },
          edits: {
            type: 'array',
            description: 'List of edits to apply in order. Each edit\'s old_string must match the file content AT THAT POINT (after preceding edits have been applied).',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string', description: 'Exact text to replace (must match including whitespace).' },
                new_string: { type: 'string', description: 'Replacement text.' },
                replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string in this edit (default false).' },
              },
              required: ['old_string', 'new_string'],
            },
          },
        },
        required: ['file_path', 'edits'],
        additionalProperties: false,
      },
      handler: async (args) => performMultiEdit(workingDir, args),
    },
  ];
}

/**
 * Apply N edits to one file atomically. The strategy is to delegate
 * each edit to performSurgicalEdit, but we capture the file's
 * original content at the start so we can restore it if any edit
 * fails. This is simpler than re-implementing all of performSurgicalEdit's
 * matching logic (whitespace tolerance, escaped-literal handling,
 * read-before-edit enforcement) — which would otherwise be ~150
 * lines of duplicated code.
 */
async function performMultiEdit(
  workingDir: string,
  args: Record<string, unknown>,
): Promise<string> {
  const pathArg = args['file_path'];
  const edits = args['edits'];
  if (typeof pathArg !== 'string' || !pathArg.trim()) {
    return 'Error: file_path must be a non-empty string.';
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    return 'Error: edits must be a non-empty array.';
  }
  if (edits.length > 50) {
    return 'Error: max 50 edits per MultiEdit call.';
  }

  // Validate each edit shape upfront before touching the file.
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] as Record<string, unknown>;
    if (!e || typeof e !== 'object') {
      return `Error: edits[${i}] must be an object {old_string, new_string}.`;
    }
    if (typeof e['old_string'] !== 'string') {
      return `Error: edits[${i}].old_string must be a string.`;
    }
    if (typeof e['new_string'] !== 'string') {
      return `Error: edits[${i}].new_string must be a string.`;
    }
  }

  const filePath = resolveFilePath(workingDir, pathArg);

  // Snapshot the file (or note it didn't exist) so we can roll back.
  let originalContent: string | null = null;
  let originallyExisted = false;
  try {
    const { stat } = await import('node:fs/promises');
    await stat(filePath);
    originallyExisted = true;
    const { readFile } = await import('node:fs/promises');
    originalContent = await readFile(filePath, 'utf-8');
  } catch {
    originallyExisted = false;
    originalContent = null;
  }

  const applied: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] as Record<string, unknown>;
    const result = await performSurgicalEdit(workingDir, {
      file_path: pathArg,
      old_string: e['old_string'] as string,
      new_string: e['new_string'] as string,
      replace_all: e['replace_all'] === true,
    });
    if (typeof result === 'string' && result.startsWith('Error:')) {
      // Roll back. Restore the original snapshot or delete the file
      // if it didn't exist at the start.
      try {
        const fs = await import('node:fs/promises');
        if (originallyExisted && originalContent !== null) {
          await fs.writeFile(filePath, originalContent, 'utf-8');
        } else {
          await fs.unlink(filePath).catch(() => undefined);
        }
      } catch (err) {
        return `Error: edit ${i + 1}/${edits.length} failed AND rollback also failed (${(err as Error).message}). File may be in inconsistent state. Original error: ${result}`;
      }
      return `Error: edit ${i + 1}/${edits.length} failed — rolled back ${applied.length} prior edit(s). File restored. Failure: ${result}`;
    }
    applied.push(result);
  }

  return [
    `⏺ MultiEdit(${pathArg}) — ${edits.length} edit${edits.length === 1 ? '' : 's'} applied atomically`,
    ...applied.map((r, i) => `\n--- edit ${i + 1}/${edits.length} ---\n${r}`),
  ].join('\n');
}

export interface EditArguments {
  file_path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

/**
 * Shared edit executor used by both legacy and unified tool flows.
 * Provides consistent validation, creation/deletion handling, and diff output.
 */
export async function performSurgicalEdit(
  workingDir: string,
  args: EditArguments | Record<string, unknown>
): Promise<string> {
  const pathArg = (args as EditArguments)['file_path'];
  const oldString = (args as EditArguments)['old_string'];
  const newStringRaw = (args as EditArguments)['new_string'];
  const replaceAll = (args as EditArguments)['replace_all'] === true;
  let replacementString = typeof newStringRaw === 'string' ? newStringRaw : '';

  // Validate inputs
  if (typeof pathArg !== 'string' || !pathArg.trim()) {
    return 'Error: file_path must be a non-empty string.';
  }
  if (typeof oldString !== 'string') {
    return 'Error: old_string must be a string (use "" for empty).';
  }
  if (newStringRaw !== undefined && typeof newStringRaw !== 'string') {
    return 'Error: new_string must be a string (use "" for empty).';
  }
  // Only error if both are identical AND non-empty (no-op edit)
  // Allow: empty old + content = create, content + empty new = delete
  if (oldString === replacementString && oldString !== '') {
    return 'Error: old_string and new_string are identical. No changes would be made.';
  }
  // Both empty is also a no-op
  if (oldString === '' && replacementString === '') {
    return 'Error: Both old_string and new_string are empty. Provide content to create a file or text to replace.';
  }

  try {
    const filePath = resolveFilePath(workingDir, pathArg);

    // Check if file exists
    let fileExists = false;
    try {
      await stat(filePath);
      fileExists = true;
    } catch {
      fileExists = false;
    }

    // Handle file creation mode (empty old_string)
    if (oldString === '') {
      if (fileExists) {
        return `Error: File already exists: ${filePath}\nTo modify an existing file, provide the exact text to replace in old_string.`;
      }

      // Create parent directories if needed
      const dir = dirname(filePath);
      await mkdir(dir, { recursive: true });

      // Record for revert before writing
      recordFileChange(filePath);

      // Write new file
      await writeFile(filePath, replacementString, 'utf-8');

      const relativePath = relative(workingDir, filePath);
      const displayPath = relativePath && !relativePath.startsWith('..') ? relativePath : filePath;
      const lineCount = replacementString.split('\n').length;
      const diffSegments = buildDiffSegmentsFast('', replacementString);
      const addedLines = diffSegments.filter((s) => s.type === 'added').length;
      // Limit to 5 diff lines for concise output
      const MAX_DIFF_LINES = 5;
      const truncatedSegments = diffSegments.slice(0, MAX_DIFF_LINES);
      const diffLines = formatDiffLines(truncatedSegments, true);
      if (diffSegments.length > MAX_DIFF_LINES) {
        diffLines.push(`      ... +${diffSegments.length - MAX_DIFF_LINES} more lines`);
      }
      const diffBlock =
        diffLines.length > 0 ? diffLines.join('\n') : '(No visual diff - whitespace or formatting changes only)';

      return [
        `⏺ Create(${displayPath})`,
        `  ⎿  Created ${displayPath} with ${addedLines} additions`,
        `     ${lineCount} line${lineCount === 1 ? '' : 's'} written`,
        diffBlock,
      ].join('\n');
    }

    // For modifications, file must exist
    if (!fileExists) {
      return `Error: File not found: ${filePath}\nTo create a new file, use empty old_string ("").`;
    }

    // Check file size before reading to prevent memory issues
    const stats = await stat(filePath);
    if (stats.size > 1024 * 1024) { // 1MB limit
      return `Error: File is too large (${Math.round(stats.size / 1024)}KB). Edit tool size limit is 1MB to prevent memory exhaustion.`;
    }

    // Read current content (async for speed)
    let currentContent = await readFile(filePath, 'utf-8');
    let autoRefreshNote = '';

    // ENFORCE READ BEFORE EDIT: Check that this file was read before attempting edit
    const readValidation = validateReadForEditEx(filePath, oldString, currentContent);
    if (!readValidation.valid) {
      // If content changed but can auto-refresh, update the read record automatically
      if (readValidation.canAutoRefresh && (readValidation.issue === 'content_changed' || readValidation.issue === 'stale')) {
        // Auto-refresh: re-read the file and update the tracker
        currentContent = await readFile(filePath, 'utf-8');
        recordFileRead(filePath, currentContent);
        autoRefreshNote = readValidation.issue === 'content_changed'
          ? ' [auto-refreshed: file was modified externally]'
          : ' [auto-refreshed: previous read was stale]';
        logDebug(`Auto-refreshed file read for ${filePath}: ${readValidation.issue}`);
      } else {
        // Cannot auto-refresh (file was never read) - return the error
        return readValidation.errorMessage ?? 'Error: File validation failed.';
      }
    }

    // Normalize escaped literals and whitespace differences to reduce mismatch errors
    let targetString = oldString;
    let matchNote: string | null = null;
    if (!currentContent.includes(targetString)) {
      const unescaped = unescapeLiteral(oldString);
      if (unescaped !== oldString && currentContent.includes(unescaped)) {
        targetString = unescaped;
        matchNote = 'normalized escaped old_string';
      }
    }

    if (!currentContent.includes(targetString)) {
      const flexibleMatch = matchWithFlexibleWhitespace(currentContent, targetString);
      if (flexibleMatch) {
        matchNote = matchNote ? matchNote : 'normalized whitespace';
        targetString = flexibleMatch;
      }
    }

    // Check if old_string exists in file
    if (!currentContent.includes(targetString)) {
      // Provide helpful debugging info when match fails
      const firstLine = oldString.split('\n')[0] || '';
      const suggestions = findSimilarLinesWithSuggestion(currentContent, firstLine, oldString, filePath, workingDir);

      // AI Flow Design: Provide structured guidance for self-correction
      const aiGuidance = buildAIRecoveryGuidance(oldString, currentContent);

      return [
        'Error: old_string not found in file.',
        '',
        `File: ${filePath}`,
        `Searching for: ${JSON.stringify(firstLine.substring(0, 80))}${firstLine.length > 80 ? '...' : ''}`,
        '',
        suggestions.hints,
        '',
        suggestions.actionable ? 'RECOMMENDED ACTION:' : 'Guidance:',
        suggestions.actionable ? suggestions.actionable : '- Ensure exact whitespace/indentation matches\n- Copy text directly from Read output\n- Check for tabs vs spaces',
        '',
        '---',
        'AI SELF-CORRECTION GUIDANCE:',
        aiGuidance,
      ].join('\n');
    }

    // Count occurrences
    // Preserve indentation when we had to normalize whitespace or use fuzzy matching
    if (matchNote && (matchNote.includes('whitespace') || matchNote.includes('fuzzy'))) {
      const adjusted = alignIndentation(targetString, replacementString);
      if (adjusted !== replacementString) {
        replacementString = adjusted;
      }
    }

    const occurrences = countOccurrences(currentContent, targetString);

    if (!replaceAll && occurrences > 1) {
      return `Error: old_string appears ${occurrences} times in the file. Either:\n1. Provide a larger unique string that includes more context\n2. Set replace_all: true to replace all ${occurrences} occurrences\n\nFile: ${filePath}`;
    }

    // Perform replacement. Use the function form for the single-occurrence
    // path: a string replacement interprets $&, $`, $' and $$, silently
    // corrupting any new_string that legitimately contains them (a regex
    // replacement like '$&!', a shell PID $$, a backref). The function form
    // returns the text verbatim. (split/join is already literal.)
    const newContent = replaceAll
      ? currentContent.split(targetString).join(replacementString)
      : currentContent.replace(targetString, () => replacementString);

    // Generate diff with context lines (Anvilwing CLI style)
    const diffResult = buildDiffWithContext(currentContent, newContent, 2);

    // Check for repeated edit attempts on same file (detect linter/hook reversion loops)
    const now = Date.now();
    const attempts = fileEditAttempts.get(filePath);
    if (attempts) {
      // Reset if enough time has passed
      if (now - attempts.lastTimestamp > EDIT_ATTEMPT_RESET_MS) {
        fileEditAttempts.set(filePath, { count: 1, lastContent: newContent, lastTimestamp: now });
      } else if (attempts.lastContent === newContent) {
        // Same exact edit being attempted again - likely in a loop
        attempts.count++;
        attempts.lastTimestamp = now;
        if (attempts.count > MAX_EDIT_ATTEMPTS_PER_FILE) {
          return [
            `Error: Edit loop detected on ${filePath}`,
            '',
            `This edit has been attempted ${attempts.count} times in quick succession.`,
            'The file may be getting reverted by a linter, formatter, or pre-commit hook.',
            '',
            'To resolve:',
            '1. Check for active file watchers or formatters',
            '2. Disable auto-formatting temporarily',
            '3. Or accept the current file state and move on',
            '',
            'STOPPING to prevent infinite loop.',
          ].join('\n');
        }
      } else {
        // Different edit - reset counter but track the new content
        fileEditAttempts.set(filePath, { count: 1, lastContent: newContent, lastTimestamp: now });
      }
    } else {
      fileEditAttempts.set(filePath, { count: 1, lastContent: newContent, lastTimestamp: now });
    }

    // Record for revert before writing
    recordFileChange(filePath);

    // Write file (async for speed)
    await writeFile(filePath, newContent, 'utf-8');

    // Verify the edit persisted (detect immediate reversion by hooks/watchers)
    // Small delay to allow any file watchers to trigger
    await new Promise(resolve => setTimeout(resolve, 50));
    const verifyContent = await readFile(filePath, 'utf-8');
    if (verifyContent !== newContent) {
      // File was modified after our write - likely by a linter/formatter
      // Update the read tracker with the new content so subsequent edits work
      recordFileRead(filePath, verifyContent);

      const editAttempts = fileEditAttempts.get(filePath);
      if (editAttempts) {
        editAttempts.count++;
      }

      // Check if the core change was preserved (fuzzy check)
      const coreChangePreserved = verifyContent.includes(replacementString.trim());

      if (coreChangePreserved) {
        // Linter only reformatted, core change is there - continue with success
        logDebug(`Edit reformatted by linter but core change preserved: ${filePath}`);
        // Update autoRefreshNote to indicate linter ran
        autoRefreshNote = autoRefreshNote
          ? `${autoRefreshNote} [reformatted by linter]`
          : ' [reformatted by linter]';
      } else {
        return [
          `Warning: Edit was immediately modified by an external process.`,
          '',
          `File: ${filePath}`,
          'The edit was written but the file content changed immediately after.',
          'This is likely caused by a linter, formatter, or file watcher.',
          '',
          'The current file state may differ from the intended edit.',
          'The read tracker has been updated with the current content.',
          'You can retry the edit - it should work now.',
        ].join('\n');
      }
    } else {
      // Edit persisted exactly - update the read tracker with new content
      recordFileRead(filePath, newContent);
    }

    // Build summary (Anvilwing CLI style)
    const relativePath = relative(workingDir, filePath);
    const displayPath = relativePath && !relativePath.startsWith('..') ? relativePath : filePath;
    const { additions, removals } = diffResult;
    const occurrencesText = replaceAll ? ` (${occurrences} occurrence${occurrences > 1 ? 's' : ''})` : '';
    const noteText = matchNote ? ` [${matchNote}]` : '';
    const refreshText = autoRefreshNote || '';

    // Format diff with colors for terminal display (Anvilwing CLI style)
    // Limit to 5 diff lines to keep output concise
    const MAX_DIFF_LINES = 5;
    const truncatedSegments = diffResult.segments.slice(0, MAX_DIFF_LINES);
    const diffLines = formatDiffClaudeStyle(truncatedSegments, true);
    const remainingChanges = diffResult.segments.length - MAX_DIFF_LINES;
    if (remainingChanges > 0) {
      diffLines.push(`      ... +${remainingChanges} more changes`);
    }
    const diffBlock =
      diffLines.length > 0 ? diffLines.join('\n') : '      (No visual diff - whitespace or formatting changes only)';

    // Build Anvilwing CLI style output:
    // ⏺ Update(filepath)
    //   ⎿  Updated filepath with N additions and M removals
    //       41    }
    //       42 +   new line
    const additionText = additions === 1 ? '1 addition' : `${additions} additions`;
    const removalText = removals === 1 ? '1 removal' : `${removals} removals`;
    const summaryParts = [];
    if (additions > 0) summaryParts.push(additionText);
    if (removals > 0) summaryParts.push(removalText);
    const summaryText = summaryParts.length > 0 ? summaryParts.join(' and ') : 'no changes';

    // Post-edit anchor: the new total line count + the line range that changed,
    // so the model can keep editing from here instead of re-reading the whole
    // file to re-establish line numbers (the over-edit driver F1 also targets).
    const totalLines = newContent.split('\n').length;
    let regionNote = '';
    if (!replaceAll) {
      // Only 'added' segments are genuinely changed NEW-file lines (context lines
      // are unchanged; removed carry OLD indices; gap markers are lineNumber 0).
      const editedLines = diffResult.segments
        .filter((s) => s.type === 'added' && s.lineNumber > 0)
        .map((s) => s.lineNumber);
      if (editedLines.length > 0) {
        const lo = Math.min(...editedLines);
        const hi = Math.max(...editedLines);
        regionNote = lo === hi ? `; changed line ${lo}` : `; changed lines ${lo}-${hi}`;
      }
    }
    const anchorLine = `  ⎿  File now ${totalLines} line${totalLines === 1 ? '' : 's'}${regionNote}`;

    return [
      `⏺ Update(${displayPath})${occurrencesText}${noteText}${refreshText}`,
      `  ⎿  Updated ${displayPath} with ${summaryText}`,
      diffBlock,
      anchorLine,
    ].filter(Boolean).join('\n');
  } catch (error: unknown) {
    return buildError('editing file', error, {
      file_path: typeof pathArg === 'string' ? pathArg : '',
      old_string_length: typeof oldString === 'string' ? oldString.length : 0,
      new_string_length: typeof replacementString === 'string' ? replacementString.length : 0,
    });
  }
}

function resolveFilePath(workingDir: string, path: string): string {
  const normalized = expandHome(path.trim());
  // Cross-platform: isAbsolute handles both POSIX (/foo) and Windows
  // (C:\foo, \\?\C:\foo) absolute forms. The prior `startsWith('/')`
  // check failed on Windows, joining `C:\…` onto workingDir.
  return isAbsolute(normalized) ? normalized : join(workingDir, normalized);
}

function countOccurrences(text: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let position = 0;

  while ((position = text.indexOf(search, position)) !== -1) {
    count++;
    position += search.length;
  }

  return count;
}

/**
 * Convert common escaped sequences (\\n, \\r, \\t, \\\\) into their literal forms.
 */
function unescapeLiteral(value: string): string {
  if (!value.includes('\\')) return value;
  return value
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

/**
 * Try to locate the search string allowing whitespace differences (indentation, spacing).
 * Returns the exact substring from the original content when matched.
 */
function matchWithFlexibleWhitespace(content: string, search: string): string | null {
  // Whitespace-flexible match ONLY — the pattern escapes every regex special and
  // makes solely WHITESPACE flexible, so it matches the same non-whitespace
  // content at a different indent and can never target a DIFFERENT block.
  // Content-fuzzy (Levenshtein) matching was removed: a ≥0.92 match silently
  // edited ~8%-different sibling blocks (a renamed field, a duplicated line),
  // corrupting code. Like Claude Code, a non-exact old_string now fails with
  // guidance so the agent re-reads and retries.
  const normalizedPattern = buildWhitespaceFlexiblePattern(search);
  if (normalizedPattern) {
    const regex = new RegExp(normalizedPattern, 's');
    const match = content.match(regex);
    if (match) return match[0];
  }
  return null;
}

function buildWhitespaceFlexiblePattern(search: string): string | null {
  if (!search.trim()) {
    return null;
  }
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Make whitespace flexible per-line: strip the search line's own
  // leading/trailing whitespace and replace with `[ \t]*` so the match
  // succeeds regardless of how the file is indented (the most common cause
  // of "old_string not found" errors — AI guessing the wrong indent).
  // Internal whitespace runs also become flexible, and blank/whitespace-only
  // lines collapse to `[ \t]*`. Newlines stay anchored (`\r?\n`) so the
  // match still can't span structural boundaries.
  const lines = escaped.split(/\\n|\n/);
  const flexibleLines = lines.map(line => {
    const trimmed = line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (!trimmed) return '[ \\t]*';
    const inner = trimmed.replace(/[ \t]+/g, '[ \\t]*');
    return `[ \\t]*${inner}[ \\t]*`;
  });
  return flexibleLines.join('\\r?\\n');
}

/**
 * When whitespace normalization is used, keep the replacement aligned with the matched indentation.
 * If a line in the replacement has no indentation, inherit indentation from the matched line.
 */
function alignIndentation(target: string, replacement: string): string {
  const targetLines = target.split('\n');
  const replacementLines = replacement.split('\n');
  if (targetLines.length !== replacementLines.length) {
    return replacement;
  }

  const adjusted = replacementLines.map((line, idx) => {
    const targetLine = targetLines[idx] ?? '';
    const targetIndent = targetLine.match(/^\s*/)?.[0] ?? '';
    if (!line.trim()) {
      return targetIndent;
    }
    const lineIndent = line.match(/^\s*/)?.[0] ?? '';
    if (lineIndent.length < targetIndent.length) {
      const missing = targetIndent.slice(lineIndent.length);
      return `${lineIndent}${missing}${line.trimStart()}`;
    }
    return line;
  });

  return adjusted.join('\n');
}

/**
 * Enhanced similar line finder with actionable suggestions for AI.
 * Provides exact text to use in old_string and clear next steps.
 */
function findSimilarLinesWithSuggestion(
  content: string,
  searchFirstLine: string,
  _fullSearchText: string,
  filePath: string,
  workingDir: string
): { hints: string; actionable: string | null } {
  const similarInfo = findSimilarLines(content, searchFirstLine, filePath);

  // Extract line numbers from similar lines
  const lineMatch = similarInfo.match(/Line (\d+)/);
  if (lineMatch && lineMatch[1]) {
    const lineNum = parseInt(lineMatch[1], 10);
    const relativePath = relative(workingDir, filePath);
    const displayPath = relativePath && !relativePath.startsWith('..') ? relativePath : filePath;

    // Provide concrete action: Read the file to get exact text
    const action = [
      `1. Use Read tool to view ${displayPath} starting at line ${Math.max(1, lineNum - 5)}`,
      `2. Copy the EXACT text from the Read output (including all indentation)`,
      `3. Use that exact text as old_string in your Edit call`,
      `4. Ensure you copy multiple lines if needed for uniqueness`,
    ].join('\n   ');

    return { hints: similarInfo, actionable: action };
  }

  // No similar lines found - suggest reading entire file
  const relativePath = relative(workingDir, filePath);
  const displayPath = relativePath && !relativePath.startsWith('..') ? relativePath : filePath;
  const action = [
    `1. Use Read tool to view the entire file: ${displayPath}`,
    `2. Locate the text you want to change`,
    `3. Copy the EXACT text including whitespace`,
    `4. Paste it as old_string in your Edit call`,
  ].join('\n   ');

  return { hints: similarInfo, actionable: action };
}

/**
 * Find lines in the file that are similar to the search text.
 * Enhanced with whitespace detection and auto-correction suggestions.
 */
function findSimilarLines(content: string, searchFirstLine: string, _filePath: string): string {
  if (!searchFirstLine.trim()) {
    return 'The search string starts with an empty line.';
  }

  const lines = content.split('\n');
  const searchNormalized = searchFirstLine.trim().toLowerCase();
  const matches: Array<{ lineNum: number; line: string; similarity: number; issue?: string }> = [];

  // Find lines that contain key words from the search
  const searchWords = searchNormalized.split(/\s+/).filter((w) => w.length > 2);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';
    const lineNormalized = line.trim().toLowerCase();

    // Check for exact match with different whitespace
    if (lineNormalized === searchNormalized && line !== searchFirstLine) {
      const hasTabs = line.includes('\t') !== searchFirstLine.includes('\t');
      const leadingDiff = line.match(/^\s*/)?.[0]?.length !== searchFirstLine.match(/^\s*/)?.[0]?.length;
      const issue = hasTabs ? 'tabs vs spaces' : leadingDiff ? 'different indentation' : 'whitespace difference';
      matches.push({ lineNum: i + 1, line, similarity: 0.99, issue });
      continue;
    }

    // Check for partial match (contains significant portion of the search)
    if (lineNormalized.includes(searchNormalized.substring(0, 20))) {
      matches.push({ lineNum: i + 1, line, similarity: 1.0 });
      continue;
    }

    // Check for word overlap
    if (searchWords.length > 0) {
      const matchingWords = searchWords.filter((w) => lineNormalized.includes(w));
      const similarity = matchingWords.length / searchWords.length;
      if (similarity >= 0.5) {
        matches.push({ lineNum: i + 1, line, similarity });
      }
    }
  }

  if (matches.length === 0) {
    return 'No similar lines found. The text may not exist in this file.';
  }

  // Sort by similarity and take top 3
  matches.sort((a, b) => b.similarity - a.similarity);
  const topMatches = matches.slice(0, 3);

  const suggestions = topMatches.map((m) => {
    const truncated = m.line.length > 80 ? `${m.line.substring(0, 77)  }...` : m.line;
    const issueNote = m.issue ? ` (${m.issue})` : '';
    return `  Line ${m.lineNum}${issueNote}: ${JSON.stringify(truncated)}`;
  });

  // Add auto-correction hint for whitespace issues
  const whitespaceMatch = topMatches.find((m) => m.issue);
  if (whitespaceMatch) {
    return `Similar lines found (possible whitespace mismatch):\n${suggestions.join('\n')}\n\nCopy the exact text from Read output including indentation.`;
  }

  return `Similar lines found:\n${suggestions.join('\n')}`;
}

/**
 * Build AI-specific recovery guidance based on the failure pattern.
 * This function implements AI flow design principles for self-correction.
 */
function buildAIRecoveryGuidance(searchText: string, fileContent: string): string {
  const guidance: string[] = [];

  // Analyze the failure pattern
  const hasMultipleLines = searchText.includes('\n');
  const hasLeadingWhitespace = /^\s/.test(searchText);
  const searchLen = searchText.length;
  const fileLen = fileContent.length;

  // PATTERN: Single line search in multi-line file
  if (!hasMultipleLines && fileLen > 1000) {
    guidance.push(
      '• PATTERN DETECTED: Single-line search in large file',
      '  → Include 2-3 surrounding lines for uniqueness',
      '  → Use Read tool with specific line offset to get exact context'
    );
  }

  // PATTERN: Missing leading whitespace
  if (!hasLeadingWhitespace && fileContent.includes('  ')) {
    guidance.push(
      '• PATTERN DETECTED: Search text may be missing indentation',
      '  → File uses indentation, but old_string starts without whitespace',
      '  → Copy exact text from Read output including leading spaces/tabs'
    );
  }

  // PATTERN: Very short search
  if (searchLen < 30) {
    guidance.push(
      '• PATTERN DETECTED: Search text is very short (<30 chars)',
      '  → Short strings are prone to false negatives due to whitespace',
      '  → Include more context: function body, surrounding statements'
    );
  }

  // PATTERN: Potential escape sequence issues
  if (searchText.includes('\\n') || searchText.includes('\\t')) {
    guidance.push(
      '• PATTERN DETECTED: Escaped characters in search text',
      '  → old_string contains \\n or \\t as literal strings',
      '  → Use actual newlines/tabs, not escaped versions'
    );
  }

  // PATTERN: Function/class definition
  if (/^(function|class|def |const |let |var |export )/.test(searchText.trim())) {
    guidance.push(
      '• PATTERN DETECTED: Function/class definition search',
      '  → Definitions often have complex indentation',
      '  → Read the exact definition including all decorators/comments above'
    );
  }

  // Default guidance if no specific pattern detected
  if (guidance.length === 0) {
    guidance.push(
      '• GENERAL GUIDANCE:',
      '  1. Use Read tool to view file around expected location',
      '  2. Copy exact text from Read output (including all whitespace)',
      '  3. Verify the text exists in file before Edit call',
      '  4. Include more context lines if text appears multiple times'
    );
  }

  // Always add the critical reminder
  guidance.push(
    '',
    'CRITICAL: Always Read → Copy → Edit. Never guess file content.'
  );

  return guidance.join('\n');
}
