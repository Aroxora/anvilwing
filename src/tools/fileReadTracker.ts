/**
 * File Read Tracker - Enforces "Read Before Edit" pattern
 *
 * This module tracks file reads to ensure the AI has fresh content
 * before attempting edits. This prevents "old_string not found" errors
 * caused by using stale content from memory.
 */

export interface FileReadRecord {
  /** When the file was last read */
  timestamp: number;
  /** Hash of the content at read time (for staleness detection) */
  contentHash: string;
  /** Line range that was read (null = full file) */
  lineRange: { start: number; end: number } | null;
}

export interface ReadValidationResult {
  /** Whether the read is valid for editing */
  valid: boolean;
  /** Type of issue if not valid */
  issue?: 'not_read' | 'stale' | 'content_changed';
  /** Error message for display */
  errorMessage?: string;
  /** Whether auto-refresh can resolve the issue */
  canAutoRefresh?: boolean;
}

/** How long a read is considered valid (5 minutes) */
const READ_VALIDITY_MS = 5 * 60 * 1000;

/** Environment flag to disable enforcement (for testing) */
const ENFORCE_READ_BEFORE_EDIT = process.env['ANVILWING_ENFORCE_READ_BEFORE_EDIT'] !== 'false';

/** Maximum entries to track (LRU eviction) */
const MAX_TRACKED_FILES = 100;

/** Map of file paths to their read records */
const fileReadRecords = new Map<string, FileReadRecord>();

/**
 * Simple content hash for staleness detection
 */
export function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(36);
}

/**
 * Record that a file was read
 */
export function recordFileRead(
  filePath: string,
  content: string,
  lineRange?: { start: number; end: number }
): void {
  // LRU eviction if at capacity
  if (fileReadRecords.size >= MAX_TRACKED_FILES) {
    let oldestPath: string | null = null;
    let oldestTime = Infinity;
    for (const [path, record] of fileReadRecords) {
      if (record.timestamp < oldestTime) {
        oldestTime = record.timestamp;
        oldestPath = path;
      }
    }
    if (oldestPath) {
      fileReadRecords.delete(oldestPath);
    }
  }

  fileReadRecords.set(filePath, {
    timestamp: Date.now(),
    contentHash: hashContent(content),
    lineRange: lineRange ?? null,
  });
}

/**
 * Check if a file has been read recently enough for editing
 */
export function wasFileReadRecently(filePath: string): boolean {
  const record = fileReadRecords.get(filePath);
  if (!record) return false;

  const age = Date.now() - record.timestamp;
  return age < READ_VALIDITY_MS;
}

/**
 * Get the read record for a file
 */
export function getFileReadRecord(filePath: string): FileReadRecord | null {
  return fileReadRecords.get(filePath) ?? null;
}

/**
 * Validate that a file read is valid for the edit being attempted
 * Returns null if valid, or an error message if not
 */
export function validateReadForEdit(
  filePath: string,
  _oldString: string,
  currentContent: string
): string | null {
  // Allow bypass for testing environments
  if (!ENFORCE_READ_BEFORE_EDIT) {
    return null;
  }

  const record = fileReadRecords.get(filePath);

  // No read record at all
  if (!record) {
    return [
      'Error: You must Read the file before editing it.',
      '',
      'This ensures you have the exact current content including whitespace.',
      '',
      'Required steps:',
      `1. Use read_file tool to read: ${filePath}`,
      '2. Copy the EXACT text from the Read output (including indentation)',
      '3. Use that text as old_string in your Edit call',
      '',
      'NEVER edit a file without reading it first in this conversation.',
    ].join('\n');
  }

  // Check if read is stale (too old)
  const age = Date.now() - record.timestamp;
  if (age > READ_VALIDITY_MS) {
    const minutes = Math.floor(age / 60000);
    return [
      `Error: File read is stale (${minutes} minutes old).`,
      '',
      'The file may have changed since you last read it.',
      '',
      'Required: Read the file again before editing.',
      `Use read_file tool to get fresh content from: ${filePath}`,
    ].join('\n');
  }

  // Check if content has changed since read (file was modified externally)
  const currentHash = hashContent(currentContent);
  if (record.contentHash !== currentHash) {
    return [
      'Error: File content has changed since you read it.',
      '',
      'The file was modified (possibly by a formatter, linter, or external process).',
      '',
      'Required: Read the file again to get the current content.',
      `Use read_file tool to refresh: ${filePath}`,
    ].join('\n');
  }

  // Valid read
  return null;
}

/**
 * Enhanced validation that returns structured result for auto-refresh support.
 * Returns detailed info about validation state instead of just an error message.
 */
export function validateReadForEditEx(
  filePath: string,
  _oldString: string,
  currentContent: string
): ReadValidationResult {
  // Allow bypass for testing environments
  if (!ENFORCE_READ_BEFORE_EDIT) {
    return { valid: true };
  }

  const record = fileReadRecords.get(filePath);

  // No read record at all
  if (!record) {
    return {
      valid: false,
      issue: 'not_read',
      canAutoRefresh: false,
      errorMessage: [
        'Error: You must Read the file before editing it.',
        '',
        'This ensures you have the exact current content including whitespace.',
        '',
        'Required steps:',
        `1. Use read_file tool to read: ${filePath}`,
        '2. Copy the EXACT text from the Read output (including indentation)',
        '3. Use that text as old_string in your Edit call',
        '',
        'NEVER edit a file without reading it first in this conversation.',
      ].join('\n'),
    };
  }

  // Check if read is stale (too old)
  const age = Date.now() - record.timestamp;
  if (age > READ_VALIDITY_MS) {
    const minutes = Math.floor(age / 60000);
    return {
      valid: false,
      issue: 'stale',
      canAutoRefresh: true,
      errorMessage: [
        `Error: File read is stale (${minutes} minutes old).`,
        '',
        'The file may have changed since you last read it.',
        '',
        'Required: Read the file again before editing.',
        `Use read_file tool to get fresh content from: ${filePath}`,
      ].join('\n'),
    };
  }

  // Check if content has changed since read (file was modified externally)
  const currentHash = hashContent(currentContent);
  if (record.contentHash !== currentHash) {
    return {
      valid: false,
      issue: 'content_changed',
      canAutoRefresh: true,
      errorMessage: [
        'Error: File content has changed since you read it.',
        '',
        'The file was modified (possibly by a formatter, linter, or external process).',
        '',
        'Required: Read the file again to get the current content.',
        `Use read_file tool to refresh: ${filePath}`,
      ].join('\n'),
    };
  }

  // Valid read
  return { valid: true };
}

/**
 * Clear all read records (for testing or session reset)
 */
export function clearFileReadRecords(): void {
  fileReadRecords.clear();
}

/**
 * Get stats for debugging
 */
export function getReadTrackerStats(): { trackedFiles: number; oldestReadAge: number | null } {
  if (fileReadRecords.size === 0) {
    return { trackedFiles: 0, oldestReadAge: null };
  }

  let oldestTime = Infinity;
  for (const record of fileReadRecords.values()) {
    if (record.timestamp < oldestTime) {
      oldestTime = record.timestamp;
    }
  }

  return {
    trackedFiles: fileReadRecords.size,
    oldestReadAge: Date.now() - oldestTime,
  };
}
