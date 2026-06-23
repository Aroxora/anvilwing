/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { ToolDefinition } from '../core/toolRuntime.js';
import { buildError } from '../core/errors.js';
import { parallelMap } from '../utils/asyncUtils.js';
import { recordFileRead } from './fileReadTracker.js';
import { expandHome } from '../utils/pathUtils.js';

const DEFAULT_SEARCH_HEAD_LIMIT = 50;

interface FormattedReadResult {
  filePath?: string;
  output: string;
}

export function createFileTools(workingDir: string): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      // Short cache TTL (like list_files): dedup the agent's tight-loop re-reads
      // without serving 5-minute-stale CONTENT after a file changes externally
      // (a background build, a formatter/watcher, a manual edit). A mutating tool
      // already clears the whole cache; this bounds the external-change window.
      cacheTtlMs: 4000,
      description: 'Read the contents of a file at the specified path. Returns content with line numbers. CRITICAL: ALWAYS use this tool BEFORE using Edit tool to get exact text including whitespace. Copy text directly from this output to old_string parameter in Edit. For large files, use offset and limit to read specific portions.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The file path (relative to working directory or absolute)',
            minLength: 1,
          },
          offset: {
            type: 'number',
            description: 'Line number to start reading from (1-based). Defaults to 1.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to read. Defaults to entire file (max 2000 lines for large files).',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const result = await readFileWithLineNumbers(workingDir, args['path'], args['offset'], args['limit']);
        return result.output;
      },
    },
    {
      name: 'read_files',
      description: 'Read multiple files in parallel with line numbers. Use this to avoid sequential read bottlenecks when inspecting several files.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'string',
              minLength: 1,
            },
            description: 'List of file paths to read (relative or absolute)',
          },
          offset: {
            type: 'number',
            description: 'Optional starting line for all files (1-based).',
          },
          limit: {
            type: 'number',
            description: 'Optional max lines to read for each file.',
          },
          concurrency: {
            type: 'number',
            description: 'Maximum number of files to read concurrently (default: 5, max: 10).',
          },
        },
        required: ['paths'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const pathsArg = args['paths'];
        if (!Array.isArray(pathsArg) || pathsArg.length === 0) {
          return 'Error: paths must be a non-empty array of file paths.';
        }

        const sanitizedPaths = pathsArg
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean);

        if (sanitizedPaths.length === 0) {
          return 'Error: paths must contain at least one valid string path.';
        }

        const concurrencyArg = typeof args['concurrency'] === 'number' ? Math.floor(args['concurrency']) : 5;
        const concurrency = Math.min(Math.max(concurrencyArg, 1), 10);
        const offsetArg = args['offset'];
        const limitArg = args['limit'];

        const results = await parallelMap(
          sanitizedPaths,
          async (path) => readFileWithLineNumbers(workingDir, path, offsetArg, limitArg),
          concurrency
        );

        const header = `Read ${results.length} file${results.length === 1 ? '' : 's'} in parallel (max ${concurrency} concurrent):`;
        const body = results.map((result) => result.output).join('\n\n---\n\n');
        return [header, body].join('\n\n');
      },
    },
    {
      name: 'list_files',
      description: 'List files and directories at the specified path',
      cacheable: true,
      cacheTtlMs: 4000, // short TTL to avoid stale listings while cutting redundant calls
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The directory path (defaults to current working directory)',
            minLength: 1,
          },
          recursive: {
            type: 'boolean',
            description: 'Whether to list files recursively',
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const pathArg = args['path'];
        const requestedPath = normalizePathContext(pathArg);
        let resolvedPath: string | undefined;
        try {
          const dirPath =
            pathArg !== undefined && pathArg !== null ? resolveFilePath(workingDir, pathArg) : workingDir;
          resolvedPath = dirPath;
          const recursive = args['recursive'] === true;

          if (!existsSync(dirPath)) {
            return `Error: Directory not found: ${dirPath}`;
          }

          const files = listFilesRecursive(dirPath, recursive ? 5 : 1, workingDir);
          return `Directory: ${dirPath}\n\n${files.join('\n')}`;
        } catch (error: any) {
          return buildError('listing files', error, { path: requestedPath, resolvedPath });
        }
      },
    },
    {
      name: 'search_files',
      description: 'Search for files matching a pattern (supports glob patterns)',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The search pattern (e.g., "*.ts", "src/**/*.js")',
            minLength: 1,
          },
          path: {
            type: 'string',
            description: 'The directory to search in (defaults to current working directory)',
            minLength: 1,
          },
          head_limit: {
            type: 'number',
            description: `Maximum number of files to return. Defaults to ${DEFAULT_SEARCH_HEAD_LIMIT}.`,
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const pathArg = args['path'];
        const requestedPath = normalizePathContext(pathArg);
        const patternArg = args['pattern'];
        const requestedPattern = typeof patternArg === 'string' ? patternArg : undefined;
        let resolvedPath: string | undefined;
        try {
          const pattern = typeof patternArg === 'string' && patternArg.trim() ? patternArg : null;
          if (!pattern) {
            return 'Error: pattern must be a non-empty string.';
          }
          const headLimitArg = args['head_limit'];
          const headLimit =
            typeof headLimitArg === 'number' && Number.isFinite(headLimitArg) && headLimitArg > 0
              ? Math.floor(headLimitArg)
              : DEFAULT_SEARCH_HEAD_LIMIT;
          const searchPath =
            pathArg !== undefined && pathArg !== null ? resolveFilePath(workingDir, pathArg) : workingDir;
          resolvedPath = searchPath;
          const results = searchFilesGlob(searchPath, pattern).sort();
          if (results.length === 0) {
            return `No files found matching pattern: ${pattern}`;
          }
          const limited = results.slice(0, headLimit);
          const truncated = results.length > headLimit;
          const headerParts = [
            `Found ${results.length} file${results.length === 1 ? '' : 's'} matching "${pattern}"`,
            truncated ? `showing first ${headLimit}` : null,
          ].filter(Boolean);

          let output = `${headerParts.join(' ')}:\n\n${limited.map((f) => relative(workingDir, f)).join('\n')}`;

          if (truncated) {
            output += `\n\n... [${results.length - headLimit} more files truncated. Use head_limit parameter to see more]`;
          }

          return output;
        } catch (error: any) {
          return buildError('searching files', error, {
            path: requestedPath,
            resolvedPath,
            pattern: requestedPattern,
          });
        }
      },
    },
  ];
}

function resolveFilePath(workingDir: string, path: unknown): string {
  const validated = expandHome(validatePathArg(path));
  // Use Node's platform-aware isAbsolute so `C:\…` (Windows) and `/…`
  // (POSIX) are both treated as absolute. Previously we only checked the
  // leading `/`, so a Windows absolute path slipped through and got
  // re-joined onto workingDir — producing `C:\…\C:\…\file` which the read
  // tool then failed to find.
  return isAbsolute(validated) ? validated : join(workingDir, validated);
}

function validatePathArg(path: unknown): string {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('Path must be a non-empty string.');
  }
  return path.trim();
}

function normalizePathContext(path: unknown): string | undefined {
  if (path === undefined || path === null) {
    return undefined;
  }
  try {
    return String(path);
  } catch {
    return '(unprintable)';
  }
}

function listFilesRecursive(dir: string, maxDepth: number, baseDir: string, currentDepth = 0): string[] {
  if (currentDepth >= maxDepth) {
    return [];
  }

  const ignoredDirs = new Set(['.git', 'node_modules', 'dist', '.next', 'build', 'coverage']);
  const results: string[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (ignoredDirs.has(entry.name)) {
        continue;
      }

      const fullPath = join(dir, entry.name);
      const indent = '  '.repeat(currentDepth);

      if (entry.isDirectory()) {
        results.push(`${indent}${entry.name}/`);
        const child = listFilesRecursive(fullPath, maxDepth, baseDir, currentDepth + 1);
        results.push(...child);
        // No silent caps: a recursive walk that hit the depth limit on a
        // NON-empty directory returns [] — say so instead, or the agent assumes
        // it saw the whole tree. (Not for the intentional non-recursive case,
        // maxDepth === 1.)
        if (child.length === 0 && maxDepth > 1 && currentDepth + 1 >= maxDepth) {
          try {
            if (readdirSync(fullPath).some((n) => !ignoredDirs.has(n))) {
              results.push(`${indent}  … deeper entries not shown (depth ${maxDepth} limit) — list ${entry.name}/ directly`);
            }
          } catch { /* ignore */ }
        }
      } else {
        const stats = statSync(fullPath);
        const size = formatFileSize(stats.size);
        results.push(`${indent}${entry.name} ${size}`);
      }
    }
  } catch (error) {
    // Ignore filesystem errors; best-effort file listing only.
  }

  return results;
}

function searchFilesGlob(dir: string, pattern: string): string[] {
  const results: string[] = [];
  const regex = globToRegex(pattern);

  function search(currentDir: string) {
    const ignoredDirs = new Set(['.git', 'node_modules', 'dist', '.next', 'build', 'coverage']);

    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (ignoredDirs.has(entry.name)) {
          continue;
        }

        const fullPath = join(currentDir, entry.name);

        if (entry.isDirectory()) {
          search(fullPath);
        } else if (regex.test(entry.name) || regex.test(relative(dir, fullPath))) {
          // Match the anchored pattern against the basename (so `*.ts` / `a.ts`
          // find files at any depth via the recursive walk) OR the path RELATIVE
          // to the search root (so `src/*.ts`, `**/*.ts` work) — never the
          // absolute path, whose leading dirs defeated the `^` anchor and made
          // every non-`**`-prefixed pattern return "No files found".
          results.push(fullPath);
        }
      }
    } catch (error) {
      // Ignore directory read errors and continue scanning.
    }
  }

  search(dir);
  return results;
}

function globToRegex(pattern: string): RegExp {
  // Mirrors the hardened converter in tools/searchTools.ts (kept in sync; TODO:
  // consolidate all copies onto picomatch). Anchored at BOTH ends so the caller
  // matches a basename / path relative to the search root, not a substring.
  // `**/` collapses to ZERO-or-more leading segments so `**/*.ts` also matches a
  // root-level file; a bare `**` spans depth; `*` is bounded to one segment.
  // Sentinels are printable (no NUL bytes in source) and translated AFTER the
  // single-`*` and `?` passes so those passes can't corrupt them.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '<!GLOBSTAR_SLASH!>')
    .replace(/\*\*/g, '<!GLOBSTAR!>')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/<!GLOBSTAR_SLASH!>/g, '(?:.*/)?')
    .replace(/<!GLOBSTAR!>/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function readFileWithLineNumbers(
  workingDir: string,
  pathArg: unknown,
  offsetArg: unknown,
  limitArg: unknown
): Promise<FormattedReadResult> {
  const requestedPath = normalizePathContext(pathArg);
  let resolvedPath: string | undefined;

  try {
    const filePath = resolveFilePath(workingDir, pathArg);
    resolvedPath = filePath;
    if (!existsSync(filePath)) {
      return { filePath, output: `Error: File not found: ${filePath}` };
    }

    // If the AI passed a directory path, fall back to a directory listing
    // instead of throwing EISDIR. Saves the recovery round-trip and gives
    // immediately-usable structure info.
    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        const entries = readdirSync(filePath, { withFileTypes: true })
          .filter(e => !['.git', 'node_modules', 'dist', '.next', 'build', 'coverage'].includes(e.name))
          .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        const lines = entries.map(e => {
          if (e.isDirectory()) return `  ${e.name}/`;
          try {
            const s = statSync(join(filePath, e.name));
            return `  ${e.name}  ${formatFileSize(s.size)}`;
          } catch {
            return `  ${e.name}`;
          }
        });
        return {
          filePath,
          output: [
            `Note: ${filePath} is a directory — Read auto-listed its contents.`,
            `Pass a specific file path to read its bytes, or use the list_files tool for recursive listing.`,
            '',
            `Directory: ${filePath} (${entries.length} entries)`,
            ...lines,
          ].join('\n'),
        };
      }
    } catch {
      // statSync failure: fall through to readFile which will surface a real error.
    }

    // Detect binary before decoding as text. Reading a PNG/PDF/executable/zip as
    // utf-8 dumps NUL bytes + control chars into the model's context (wasted
    // tokens, and the control bytes can corrupt the terminal). A NUL byte in the
    // first 8 KB is the standard binary signal (git/grep use it) — text files,
    // including source, don't contain NUL. (This is binary DETECTION; rendering
    // images/PDFs for the model is a separate capability.)
    const head = await readFile(filePath);
    const scanLen = Math.min(head.length, 8192);
    if (head.indexOf(0, 0) >= 0 && head.indexOf(0, 0) < scanLen) {
      return {
        filePath,
        output: `File: ${filePath}\n\nThis is a binary file (${formatFileSize(head.length)}) — not displayed as text. Use a dedicated tool or command if you need its bytes.`,
      };
    }
    const content = head.toString('utf-8');
    // Splitting on '\n' yields a phantom trailing '' for the (near-universal)
    // file that ends in a newline — that terminator is not a line. Drop it so the
    // line count and numbering match the file (Claude Code parity). A genuine
    // blank LAST line (file ends in '\n\n') still shows one empty line; an empty
    // file is 0 lines, not a spurious "1 lines" with a blank line.
    const lines = content === ''
      ? []
      : (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n');
    const totalLines = lines.length;

    const { offset, startLine, endLine } = normalizeReadWindow(totalLines, offsetArg, limitArg);

    // offset past the end → an empty window with a nonsensical "lines 15-10 of
    // 10" range. Say so clearly instead so the agent can re-read in range.
    if (totalLines > 0 && startLine >= totalLines) {
      return {
        filePath,
        output: `File: ${filePath} (${totalLines} lines)\n\nOffset ${offset} is past the end of the file — it has ${totalLines} line${totalLines === 1 ? '' : 's'}. Read with an offset of 1..${totalLines}.`,
      };
    }

    const selectedLines = lines.slice(startLine, endLine);

    // Truncate very long lines for DISPLAY only (Claude Code parity: lines over
    // ~2000 chars are cut). A minified bundle or a one-line JSON/base64 blob would
    // otherwise flood the context window with a single line. recordFileRead below
    // still stores the FULL content, so edit-validation is unaffected.
    const MAX_LINE_CHARS = 2000;
    const numberedLines = selectedLines.map((line, idx) => {
      const lineNum = String(startLine + idx + 1).padStart(6);
      const shown = line.length > MAX_LINE_CHARS
        ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated: ${line.length} chars total]`
        : line;
      return `${lineNum}\t${shown}`;
    });

    const showingRange = startLine > 0 || endLine < totalLines;
    const rangeInfo = showingRange
      ? ` (lines ${offset}-${endLine} of ${totalLines})`
      : ` (${totalLines} lines)`;

    // Track this read for "Read Before Edit" enforcement
    recordFileRead(
      filePath,
      content,
      showingRange ? { start: startLine + 1, end: endLine } : undefined
    );

    return {
      filePath,
      output: `File: ${filePath}${rangeInfo}\n\n${numberedLines.join('\n')}`,
    };
  } catch (error: any) {
    return { filePath: resolvedPath, output: buildError('reading file', error, { path: requestedPath, resolvedPath }) };
  }
}

function normalizeReadWindow(totalLines: number, offsetArg: unknown, limitArg: unknown): {
  offset: number;
  startLine: number;
  endLine: number;
} {
  const offset = typeof offsetArg === 'number' ? Math.max(1, Math.floor(offsetArg)) : 1;
  const defaultLimit = totalLines > 2000 ? 2000 : totalLines;
  const limit = typeof limitArg === 'number' ? Math.max(1, Math.floor(limitArg)) : defaultLimit;

  const startLine = offset - 1;
  const endLine = Math.min(startLine + limit, totalLines);

  return { offset, startLine, endLine };
}
