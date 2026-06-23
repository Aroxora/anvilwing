/**
 * Unified Search Tools - Combines file pattern matching and content search
 *
 * Provides a single, powerful Search tool that handles:
 * - File pattern matching (glob)
 * - Content search (regex/grep)
 * - Definition finding
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, isAbsolute } from 'node:path';
import braces from 'braces';
import { loadGitignore, isPathIgnored } from './gitignore.js';
import type { ToolDefinition } from '../core/toolRuntime.js';
import { buildError } from '../core/errors.js';
import { expandHome } from '../utils/pathUtils.js';
import { createGrepTools } from './grepTools.js';


const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', '.next', 'build', 'coverage',
  '.turbo', '.cache', '__pycache__', '.pytest_cache', '.venv', 'venv',
  '.anvilwing',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.mp3', '.mp4', '.avi', '.mov', '.flv',
  '.woff', '.woff2', '.ttf', '.eot',
]);

const FILE_TYPE_MAP: Record<string, string[]> = {
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  ts: ['.ts', '.tsx'],
  py: ['.py'],
  rust: ['.rs'],
  go: ['.go'],
  java: ['.java'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.h'],
  c: ['.c', '.h'],
  ruby: ['.rb'],
  php: ['.php'],
  html: ['.html', '.htm'],
  css: ['.css', '.scss', '.sass', '.less'],
  json: ['.json'],
  yaml: ['.yaml', '.yml'],
  md: ['.md', '.markdown'],
  swift: ['.swift'],
  kotlin: ['.kt', '.kts'],
};

/**
 * Build a dedicated Glob tool — Claude-Code-parity. Equivalent to
 * `Search({ mode: 'files', pattern, ...})` but with a tighter API
 * the model finds easier to reach for. Returns paths sorted by
 * modification time (newest first), capped at `head_limit`.
 */
function createGlobTool(workingDir: string): ToolDefinition {
  return {
    name: 'Glob',
    // Short cache TTL (like list_files/read_file): dedup tight-loop re-globs
    // without serving 5-minute-stale results after files are added/removed.
    cacheTtlMs: 4000,
    description:
      'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.test.{js,ts}"). Returns paths sorted by modification time (newest first). Faster than Bash `find` and respects common ignored dirs (node_modules, dist, .git). For content search inside files, use Grep or Search.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern. Supports **, *, ?, character classes, and brace expansion ({js,ts}, {1..3}).' },
        path: { type: 'string', description: 'Directory to search in (relative to working dir or absolute). Default: working dir.' },
        head_limit: { type: 'number', description: 'Cap on results returned. Default 50, max 500.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const pattern = args['pattern'];
      if (typeof pattern !== 'string' || !pattern.trim()) {
        return 'Error: pattern is required.';
      }
      const pathArg = args['path'];
      const searchPath = typeof pathArg === 'string' && pathArg.trim()
        ? resolvePath(workingDir, pathArg)
        : workingDir;
      const requested = typeof args['head_limit'] === 'number' ? args['head_limit'] : 50;
      const limit = Math.max(1, Math.min(500, requested));
      try {
        return searchFiles(searchPath, workingDir, pattern, { limit });
      } catch (error) {
        return buildError('Glob', error, { pattern, path: searchPath });
      }
    },
  };
}

export function createSearchTools(workingDir: string): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'Search',
      description: 'Unified search tool for files and content. Use mode="files" for glob patterns, mode="content" for regex search, mode="definition" for code definitions.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Search pattern - glob pattern for files mode, regex for content/definition mode',
          },
          mode: {
            type: 'string',
            enum: ['files', 'content', 'definition'],
            description: 'Search mode: "files" (glob), "content" (grep), "definition" (find functions/classes)',
          },
          path: {
            type: 'string',
            description: 'Directory to search in (defaults to working directory)',
          },
          type: {
            type: 'string',
            description: 'File type filter (js, ts, py, go, etc.) or definition type (function, class, interface)',
          },
          glob: {
            type: 'string',
            description: 'Glob pattern to filter files (e.g., "*.ts", "src/**/*.js")',
          },
          ignoreCase: {
            type: 'boolean',
            description: 'Case insensitive search (default: true for content, false for files)',
          },
          context: {
            type: 'number',
            description: 'Lines of context around matches (content mode only)',
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return (default: 20)',
          },
        },
        required: ['pattern'],
        additionalProperties: true,
      },
      handler: async (args) => {
        const pattern = args['pattern'];
        if (typeof pattern !== 'string' || !pattern.trim()) {
          return 'Error: pattern is required';
        }

        const mode = (args['mode'] as string) || inferMode(pattern);
        const pathArg = args['path'];
        const fileType = args['type'];
        const globPattern = args['glob'];
        const ignoreCase = args['ignoreCase'] === true || (args['ignoreCase'] !== false && mode === 'content');
        const contextLines = typeof args['context'] === 'number' ? args['context'] : 0;
        const limit = typeof args['limit'] === 'number' ? Math.min(args['limit'], 100) : 20;

        const searchPath = pathArg && typeof pathArg === 'string'
          ? resolvePath(workingDir, pathArg)
          : workingDir;

        try {
          switch (mode) {
            case 'files':
              return searchFiles(searchPath, workingDir, pattern, { limit });

            case 'definition':
              return searchDefinitions(searchPath, workingDir, pattern, {
                definitionType: typeof fileType === 'string' ? fileType : 'any',
                limit,
              });

            case 'content':
            default:
              return searchContent(searchPath, workingDir, pattern, {
                ignoreCase,
                fileType: typeof fileType === 'string' ? fileType : undefined,
                globPattern: typeof globPattern === 'string' ? globPattern : undefined,
                contextLines,
                limit,
              });
          }
        } catch (error) {
          return buildError('search', error, { pattern: String(pattern), mode: String(mode) });
        }
      },
    },
  ];

  // Dedicated Glob tool — Claude-Code parity. Equivalent to
  // Search({ mode: 'files' }) but with a tighter, easier-to-reach API.
  tools.push(createGlobTool(workingDir));

  // Add grep-style search as a complementary tool for backward compatibility
  tools.push(...createGrepTools(workingDir));

  return tools;
}

function inferMode(pattern: string): string {
  // Glob patterns
  if (pattern.includes('*') || pattern.includes('?') || pattern.includes('[')) {
    if (pattern.includes('/') || pattern.startsWith('*.')) {
      return 'files';
    }
  }
  return 'content';
}

function resolvePath(workingDir: string, path: string): string {
  const normalized = expandHome(path.trim());
  return isAbsolute(normalized) ? normalized : join(workingDir, normalized);
}

// ============================================================================
// FILES MODE - Glob pattern matching
// ============================================================================

function searchFiles(
  searchPath: string,
  workingDir: string,
  pattern: string,
  options: { limit: number }
): string {
  const ig = loadGitignore(workingDir);
  const regexes = globToRegexes(pattern);
  const matches: Array<{ path: string; mtime: number }> = [];

  function walk(dir: string) {
    if (matches.length >= options.limit * 2) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (isPathIgnored(ig, workingDir, fullPath, entry.isDirectory())) continue;
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          // Match the glob against the path RELATIVE to the search root, with
          // forward slashes — the pattern is anchored (^…$), so testing it
          // against the absolute path would never match. (globToRegex emits '/'
          // separators; path.join returns '\' on Windows, hence the normalize.)
          const normalized = relative(searchPath, fullPath).replace(/\\/g, '/');
          if (regexes.some((r) => r.test(normalized))) {
            try {
              const stat = statSync(fullPath);
              matches.push({ path: fullPath, mtime: stat.mtimeMs });
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* skip */ }
  }

  walk(searchPath);

  // Sort by modification time (newest first)
  matches.sort((a, b) => b.mtime - a.mtime);

  // Honor the caller's head_limit (default 50, clamped to 500 in createGlobTool)
  // — previously hard-capped at 5, making head_limit a no-op.
  const limited = matches.slice(0, options.limit);
  if (limited.length === 0) {
    return `No files matching: ${pattern}`;
  }

  const relativePaths = limited.map(m => {
    const rel = relative(workingDir, m.path);
    return rel && !rel.startsWith('..') ? rel : m.path;
  });

  let result = `${matches.length} file(s) matching "${pattern}":\n${relativePaths.join('\n')}`;
  if (matches.length > limited.length) {
    result += `\n... +${matches.length - limited.length} more files`;
  }

  return result;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // `**/` matches ZERO or more leading path segments — so `**/*.ts` matches a
    // direct child `app.ts` as well as `a/b/app.ts` (it used to require a slash
    // and miss direct children).
    .replace(/\*\*\//g, '<!GLOBSTAR_SLASH!>')
    .replace(/\*\*/g, '<!GLOBSTAR!>')
    .replace(/\*/g, '[^/]*')
    // Translate the glob `?` BEFORE expanding the sentinels — the globstar
    // expansion introduces a regex `(?:…)?`, and a later `?`→`.` pass would
    // corrupt it.
    .replace(/\?/g, '.')
    .replace(/<!GLOBSTAR_SLASH!>/g, '(?:.*/)?')
    .replace(/<!GLOBSTAR!>/g, '.*');
  // Anchor at BOTH ends: without a leading `^`, `src/*.ts` also matched
  // `web/src/app.ts` (it only checked the tail) — wrong-directory matches.
  return new RegExp(`^${escaped}$`);
}

// Brace expansion ({js,ts}, {1..3}, cartesian {a,b}/{c,d}) via the `braces`
// library — Claude Code's Glob supports it, and CLAUDE.md bans hand-rolling
// glob logic (a `**`-clobbering bug shipped from exactly that). The tool's
// description and examples already advertise `{js,ts}`, but globToRegex escaped
// the braces, so those patterns silently matched nothing. A brace-free pattern
// expands to itself, so every existing non-brace glob is byte-for-byte
// unchanged; a brace pattern matches a path if ANY expansion matches. Compiled
// regexes are cached (the grep glob-filter calls this per file).
const globMatcherCache = new Map<string, RegExp[]>();
export function globToRegexes(pattern: string): RegExp[] {
  const cached = globMatcherCache.get(pattern);
  if (cached) return cached;
  let expansions: string[];
  try {
    expansions = braces(pattern, { expand: true });
    if (!expansions || expansions.length === 0) expansions = [pattern];
  } catch {
    expansions = [pattern];
  }
  const regexes = expansions.map(globToRegex);
  if (globMatcherCache.size > 500) globMatcherCache.clear();
  globMatcherCache.set(pattern, regexes);
  return regexes;
}

// ============================================================================
// CONTENT MODE - Regex search in file contents
// ============================================================================

interface ContentMatch {
  file: string;
  line: number;
  content: string;
}

function searchContent(
  searchPath: string,
  workingDir: string,
  pattern: string,
  options: {
    ignoreCase: boolean;
    fileType?: string;
    globPattern?: string;
    contextLines: number;
    limit: number;
  }
): string {
  const ig = loadGitignore(workingDir);
  const flags = options.ignoreCase ? 'gi' : 'g';
  const regex = new RegExp(pattern, flags);
  const matches: ContentMatch[] = [];
  const maxScan = options.limit * 3;

  function walk(dir: string) {
    if (matches.length >= maxScan) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (matches.length >= maxScan) break;
        const fullPath = join(dir, entry.name);
        if (isPathIgnored(ig, workingDir, fullPath, entry.isDirectory())) continue;
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          searchFile(fullPath);
        }
      }
    } catch { /* skip */ }
  }

  function searchFile(filePath: string) {
    // Filter by type
    if (options.fileType && !matchesFileType(filePath, options.fileType)) return;
    if (options.globPattern && !matchesFileGlob(relative(workingDir, filePath), options.globPattern)) return;
    if (isBinary(filePath)) return;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length && matches.length < maxScan; i++) {
        if (regex.test(lines[i]!)) {
          matches.push({
            file: filePath,
            line: i + 1,
            content: lines[i]!.trim(),
          });
        }
        regex.lastIndex = 0; // Reset for next test
      }
    } catch { /* skip */ }
  }

  walk(searchPath);

  if (matches.length === 0) {
    return `No matches for: ${pattern}`;
  }

  // Honour the caller's `limit` (default 20, clamped to 100 in the handler).
  // This used to be Math.min(options.limit, 5) — a hard 5-match cap that made
  // the documented `limit` parameter silently non-functional, so "find all
  // usages" only ever surfaced 5 hits regardless of what was requested.
  const limited = matches.slice(0, options.limit);
  const lines: string[] = [];

  for (const m of limited) {
    const relPath = relative(workingDir, m.file);
    const displayPath = relPath && !relPath.startsWith('..') ? relPath : m.file;
    lines.push(`${displayPath}:${m.line}: ${m.content.slice(0, 80)}${m.content.length > 80 ? '...' : ''}`);
  }

  let result = lines.join('\n');
  if (matches.length > options.limit) {
    result += `\n... +${matches.length - options.limit} more matches`;
  }

  return result;
}

// ============================================================================
// DEFINITION MODE - Find code definitions
// ============================================================================

function searchDefinitions(
  searchPath: string,
  workingDir: string,
  name: string,
  options: { definitionType: string; limit: number }
): string {
  const ig = loadGitignore(workingDir);
  const patterns: Record<string, string> = {
    function: `(function\\s+${name}|const\\s+${name}\\s*=.*=>|${name}\\s*\\([^)]*\\)\\s*\\{)`,
    class: `class\\s+${name}`,
    interface: `interface\\s+${name}`,
    type: `type\\s+${name}`,
    const: `const\\s+${name}`,
    any: `(function\\s+${name}|class\\s+${name}|interface\\s+${name}|type\\s+${name}|const\\s+${name})`,
  };

  const patternStr = patterns[options.definitionType] || patterns['any'];
  const regex = new RegExp(patternStr!, 'gi');
  const matches: ContentMatch[] = [];

  function walk(dir: string) {
    if (matches.length >= options.limit * 2) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (matches.length >= options.limit * 2) break;
        const fullPath = join(dir, entry.name);
        if (isPathIgnored(ig, workingDir, fullPath, entry.isDirectory())) continue;
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (isCodeFile(fullPath)) {
          searchFile(fullPath);
        }
      }
    } catch { /* skip */ }
  }

  function searchFile(filePath: string) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length && matches.length < options.limit * 2; i++) {
        if (regex.test(lines[i]!)) {
          matches.push({
            file: filePath,
            line: i + 1,
            content: lines[i]!.trim(),
          });
        }
        regex.lastIndex = 0;
      }
    } catch { /* skip */ }
  }

  walk(searchPath);

  if (matches.length === 0) {
    return `No definitions found for: ${name}`;
  }

  // Honour the caller's `limit` here too (was hard-capped at 5 definitions).
  const limited = matches.slice(0, options.limit);
  const lines: string[] = [];

  for (const m of limited) {
    const relPath = relative(workingDir, m.file);
    const displayPath = relPath && !relPath.startsWith('..') ? relPath : m.file;
    lines.push(`${displayPath}:${m.line}: ${m.content.slice(0, 80)}${m.content.length > 80 ? '...' : ''}`);
  }

  if (matches.length > options.limit) {
    lines.push(`... +${matches.length - options.limit} more definitions`);
  }

  return lines.join('\n');
}

// ============================================================================
// Utility functions
// ============================================================================

export function matchesFileType(filePath: string, fileType: string): boolean {
  const ext = extname(filePath).toLowerCase();
  const extensions = FILE_TYPE_MAP[fileType.toLowerCase()];
  return extensions ? extensions.includes(ext) : false;
}

/**
 * Match a file against a glob by its path RELATIVE to the search root, ripgrep-
 * style: a slash-less glob (*.ts) matches the basename at any depth; a glob with
 * a slash (src/**\/*.ts) matches the relative path. The old matchesGlob tested the
 * ABSOLUTE path against an anchored pattern, so *.ts (→ ^[^/]*\.ts$) matched
 * nothing — Search's glob filter silently returned no results.
 */
export function matchesFileGlob(relPath: string, pattern: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? normalized;
  return globToRegexes(pattern).some((r) => r.test(normalized) || r.test(base));
}

function isBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function isCodeFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  const codeExts = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.swift', '.kt'];
  return codeExts.includes(ext);
}

// Legacy exports for backward compatibility
export { createSearchTools as createGrepTools };
