/**
 * File Change Tracker - Tracks file modifications for revert functionality
 *
 * This module stores original file content before modifications so users
 * can revert all changes made during a run with /revert command.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { relative } from 'node:path';

export interface FileChangeRecord {
  /** Original content before modification (null if file was created) */
  originalContent: string | null;
  /** Whether file existed before this run */
  existedBefore: boolean;
  /** Timestamp of first modification */
  firstModified: number;
  /** Number of times modified this run */
  modifyCount: number;
}

/** Map of file paths to their original state */
const fileChanges = new Map<string, FileChangeRecord>();

/** Current run ID to track which run we're in */
let currentRunId = 0;

/** Run ID when changes were recorded */
let changesRunId = 0;

/**
 * Start a new run - clears previous change tracking
 */
export function startNewRun(): void {
  currentRunId++;
  // Don't clear changes yet - allow revert of previous run until new changes happen
}

/**
 * Record original content before a file is modified
 * Only records the FIRST state - subsequent edits don't overwrite
 */
export function recordFileChange(filePath: string): void {
  // If this is a new run, clear old tracking
  if (changesRunId !== currentRunId) {
    fileChanges.clear();
    changesRunId = currentRunId;
  }

  // Only record first modification
  if (fileChanges.has(filePath)) {
    const record = fileChanges.get(filePath)!;
    record.modifyCount++;
    return;
  }

  // Check if file exists and read original content
  const existedBefore = existsSync(filePath);
  let originalContent: string | null = null;

  if (existedBefore) {
    try {
      originalContent = readFileSync(filePath, 'utf-8');
    } catch {
      // If we can't read it, we can't revert it
      originalContent = null;
    }
  }

  fileChanges.set(filePath, {
    originalContent,
    existedBefore,
    firstModified: Date.now(),
    modifyCount: 1,
  });
}

/**
 * Get all changed files in the current run
 */
export function getChangedFiles(): Map<string, FileChangeRecord> {
  return new Map(fileChanges);
}

/**
 * Check if there are any changes to revert
 */
export function hasChangesToRevert(): boolean {
  return fileChanges.size > 0;
}

/**
 * Revert all changes made during the current run
 * Returns a summary of what was reverted
 */
export function revertAllChanges(workingDir: string): string {
  if (fileChanges.size === 0) {
    return 'No changes to revert.';
  }

  const results: string[] = [];
  let reverted = 0;
  let deleted = 0;
  let errors = 0;

  for (const [filePath, record] of fileChanges) {
    const relativePath = relative(workingDir, filePath);
    const displayPath = relativePath && !relativePath.startsWith('..') ? relativePath : filePath;

    try {
      if (record.existedBefore && record.originalContent !== null) {
        // Restore original content
        writeFileSync(filePath, record.originalContent, 'utf-8');
        results.push(`  ✓ Restored: ${displayPath}`);
        reverted++;
      } else if (!record.existedBefore) {
        // Delete file that was created
        if (existsSync(filePath)) {
          unlinkSync(filePath);
          results.push(`  ✓ Deleted: ${displayPath} (was created this run)`);
          deleted++;
        }
      } else {
        results.push(`  ⚠ Skipped: ${displayPath} (no original content recorded)`);
      }
    } catch (error) {
      results.push(`  ✗ Failed: ${displayPath} - ${(error as Error).message}`);
      errors++;
    }
  }

  // Clear the change tracking after revert
  fileChanges.clear();

  const summary = [];
  if (reverted > 0) summary.push(`${reverted} file${reverted === 1 ? '' : 's'} restored`);
  if (deleted > 0) summary.push(`${deleted} file${deleted === 1 ? '' : 's'} deleted`);
  if (errors > 0) summary.push(`${errors} error${errors === 1 ? '' : 's'}`);

  return [
    `⏪ Revert complete: ${summary.join(', ')}`,
    '',
    ...results,
  ].join('\n');
}

/**
 * Get a summary of pending changes that can be reverted
 */
export function getRevertSummary(workingDir: string): string {
  if (fileChanges.size === 0) {
    return 'No changes to revert.';
  }

  const lines: string[] = [
    `📋 Changes that will be reverted (${fileChanges.size} file${fileChanges.size === 1 ? '' : 's'}):`,
    '',
  ];

  for (const [filePath, record] of fileChanges) {
    const relativePath = relative(workingDir, filePath);
    const displayPath = relativePath && !relativePath.startsWith('..') ? relativePath : filePath;

    if (record.existedBefore) {
      lines.push(`  • ${displayPath} (modified ${record.modifyCount}x)`);
    } else {
      lines.push(`  • ${displayPath} (created - will be deleted)`);
    }
  }

  lines.push('');
  lines.push('Use /revert confirm to revert these changes.');

  return lines.join('\n');
}

/**
 * Clear change tracking (for testing or manual reset)
 */
export function clearChangeTracking(): void {
  fileChanges.clear();
}
