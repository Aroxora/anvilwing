import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { safeWorkspaceContext, validateWorkspaceOptions } from './workspace.validator.js';
import { reportStatus, reportStatusError } from './utils/statusReporter.js';

const PRIORITY_DOCS = ['README.md']; // Removed package.json to save context
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', '.anvilwing', 'build', 'coverage', '.next', 'out',
  '__pycache__', '.pytest_cache', '.mypy_cache', 'venv', '.venv', 'env',
  'target', 'bin', 'obj', '.idea', '.vscode', '.DS_Store'
]);
const IGNORED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
const DEFAULT_TREE_DEPTH = 1;  // Reduced from 2 to 1 for critical context savings
const DEFAULT_MAX_ENTRIES = 30;  // Further reduced from 50 to 30 - emergency reduction
const DEFAULT_DOC_LIMIT = 200;  // Further reduced from 300 to 200 - emergency reduction
const DEBUG_CONTEXT_ERRORS = Boolean(process.env['DEBUG_CONTEXT_ERRORS']);

export interface WorkspaceCaptureOptions {
  treeDepth?: number;
  maxEntries?: number;
  docExcerptLimit?: number;
}

export function resolveWorkspaceCaptureOptions(env: NodeJS.ProcessEnv = process.env): WorkspaceCaptureOptions {
  return {
    treeDepth: parsePositiveInt(env['ANVILWING_CONTEXT_TREE_DEPTH']),
    maxEntries: parsePositiveInt(env['ANVILWING_CONTEXT_MAX_ENTRIES']),
    docExcerptLimit: parsePositiveInt(env['ANVILWING_CONTEXT_DOC_LIMIT']),
  };
}

export function buildWorkspaceContext(root: string, options: WorkspaceCaptureOptions = {}): string | null {
  // CRITICAL: Validate options BEFORE building context
  const optionsValidation = validateWorkspaceOptions(options);
  if (!optionsValidation.valid) {
    // Only log in debug mode to avoid polluting chat
    if (process.env['DEBUG_CONTEXT']) {
      reportStatus(`[Workspace Context] Invalid options: ${optionsValidation.errors.join(', ')}`);
    }
    throw new Error(`Invalid workspace options: ${optionsValidation.errors.join(', ')}`);
  }

  // Warnings only in debug mode
  if (optionsValidation.warnings.length > 0 && process.env['DEBUG_CONTEXT']) {
    console.warn('[Workspace Context] Warnings:', optionsValidation.warnings);
  }

  const treeDepth = options.treeDepth ?? DEFAULT_TREE_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const docLimit = options.docExcerptLimit ?? DEFAULT_DOC_LIMIT;

  try {
    const treeLines = formatFileTree(root, treeDepth, maxEntries);
    const docSnippets = capturePriorityDocs(root, docLimit);

    const sections: string[] = [`cwd: ${root}`];
    if (treeLines.length) {
      sections.push('files:', ...treeLines);
    }
    if (docSnippets.length) {
      sections.push(docSnippets.join('\n\n'));
    }

    const rawContent = sections.filter((section) => section.trim().length > 0).join('\n');

    const safe = safeWorkspaceContext(rawContent, {
      truncate: true,
      throwOnError: false,
    });

    if (process.env['DEBUG_CONTEXT']) {
      console.log('[Workspace Context] Stats:', safe.stats);
    }

    if (!safe.content.trim()) {
      if (DEBUG_CONTEXT_ERRORS) {
        console.warn('[Workspace Context] Captured context is empty after filtering.');
      }
      return null;
    }

    return safe.content;
  } catch (error) {
    // Only log errors in debug mode to avoid polluting chat
    if (DEBUG_CONTEXT_ERRORS || process.env['DEBUG_CONTEXT']) {
      const message = error instanceof Error ? error.message : String(error);
      reportStatus(`[Workspace Context] Failed to build context: ${message}`);
      reportStatusError(error, '[Workspace Context] Error');
    }
    return null;
  }
}

function capturePriorityDocs(root: string, docLimit: number): string[] {
  return PRIORITY_DOCS.filter((name) => existsSync(join(root, name))).map((name) => {
    try {
      const content = readFileSync(join(root, name), 'utf8');
      // Safety: Hard limit to prevent context explosion
      const safeLimit = Math.min(docLimit, 300);
      const snippet = content.length > safeLimit ? `${content.slice(0, safeLimit)}\n...` : content;
      return `--- ${name} ---\n${snippet.trim()}`;
    } catch {
      return `--- ${name} ---\n[Could not read file]`;
    }
  });
}

function formatFileTree(root: string, maxDepth: number, maxEntries: number): string[] {
  const lines: string[] = [];
  const walk = (dir: string, depth: number, prefix: string) => {
    if (depth > maxDepth || lines.length >= maxEntries) {
      return;
    }

    const entries = safeReadDir(dir)
      .filter((entry) => !IGNORED_DIRS.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isFile() && IGNORED_FILES.has(entry.name)) {
        continue;
      }

      if (lines.length >= maxEntries) {
        break;
      }

      const isDir = entry.isDirectory();
      lines.push(`${prefix}${entry.name}${isDir ? '/' : ''}`);
      if (isDir && depth < maxDepth) {
        walk(join(dir, entry.name), depth + 1, `${prefix}  `);
      }
    }
  };

  walk(root, 0, '');
  return lines;
}

function safeReadDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (DEBUG_CONTEXT_ERRORS) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Workspace Context] Skipping ${dir}: ${message}`);
    }
    return [];
  }
}

function parsePositiveInt(raw?: string): number | undefined {
  if (!raw) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
