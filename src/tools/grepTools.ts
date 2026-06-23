import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import type { ToolDefinition } from '../core/toolRuntime.js';
import { matchesFileGlob, matchesFileType } from './searchTools.js';
import { loadGitignore, isPathIgnored } from './gitignore.js';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  'build',
  'coverage',
  '.turbo',
  '.cache',
]);


export function createGrepTools(workingDir: string): ToolDefinition[] {
  return [
    {
      name: 'Grep',
      // Short cache TTL (like list_files/read_file): dedup tight-loop re-greps
      // without serving 5-minute-stale matches after files change externally.
      cacheTtlMs: 4000,
      description: 'Search file contents for a pattern. Supports case-insensitive search, line numbers, and context lines (-A/-B/-C) like ripgrep — use -C to see code around a match without a separate Read.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or plain text pattern to search for.' },
          path: { type: 'string', description: 'Directory or file to search (defaults to working directory).' },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: 'How to return results: full content, file list, or match count.',
          },
          ignore_case: { type: 'boolean', description: 'Case-insensitive search (alias: i).' },
          i: { type: 'boolean', description: 'Alias for ignore_case.' },
          line_numbers: { type: 'boolean', description: 'Include line numbers (alias: n).' },
          n: { type: 'boolean', description: 'Alias for line_numbers.' },
          '-C': { type: 'number', description: 'Show N lines of context before AND after each match (content mode).' },
          '-A': { type: 'number', description: 'Show N lines after each match (content mode); overrides -C for "after".' },
          '-B': { type: 'number', description: 'Show N lines before each match (content mode); overrides -C for "before".' },
          glob: { type: 'string', description: 'Only search files whose path matches this glob (e.g. "*.ts", "src/**/*.js", "*.{ts,tsx}").' },
          type: { type: 'string', description: 'Only search files of this language type (js, ts, py, go, rust, java, c, cpp, ruby, php, html, css, json, yaml, md, ...).' },
          head_limit: { type: 'number', description: 'Max output lines/files to display (default 50).' },
        },
        required: ['pattern'],
        additionalProperties: true,
      },
      handler: async (args) => {
        const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : '';
        if (!pattern.trim()) {
          return 'Error: pattern is required';
        }

        const outputMode = (args['output_mode'] as string) || 'content';
        const ignoreCase = args['ignore_case'] === true || args['i'] === true;
        const includeLineNumbers = args['line_numbers'] === true || args['n'] === true;

        // Context lines, ripgrep semantics: -C sets both sides; -A/-B override
        // each side. Capped so a stray huge value can't dump a whole file.
        const ctxNum = (v: unknown): number => {
          const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN);
          return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : 0;
        };
        const bothCtx = ctxNum(args['-C'] ?? args['C'] ?? args['context']);
        const afterCtx = ctxNum(args['-A'] ?? args['A'] ?? args['after_context']) || bothCtx;
        const beforeCtx = ctxNum(args['-B'] ?? args['B'] ?? args['before_context']) || bothCtx;
        const withContext = (afterCtx > 0 || beforeCtx > 0) && outputMode === 'content';

        const searchRootInput = typeof args['path'] === 'string' && args['path'].trim()
          ? args['path'].trim()
          : workingDir;
        const searchRoot = isAbsolute(searchRootInput)
          ? searchRootInput
          : join(workingDir, searchRootInput);

        let regex: RegExp;
        try {
          regex = new RegExp(pattern, ignoreCase ? 'i' : undefined);
        } catch (e) {
          // Return a model-recoverable error string (matching Search's graceful
          // handling) instead of letting the SyntaxError escape to the generic
          // toolRuntime "Failed to run" wrapper.
          return `Error: invalid regex pattern: ${(e as Error).message}`;
        }
        // File scoping (Claude Code Grep parity): --type by language, --glob by
        // path. A slash-less glob (*.ts) matches the basename at any depth; a
        // glob with a slash (src/**/*.ts) matches the relative path — ripgrep
        // semantics, and unlike Search's filter it doesn't test the absolute path.
        const typeFilter = typeof args['type'] === 'string' && args['type'].trim() ? args['type'].trim() : null;
        const globArg = typeof args['glob'] === 'string' && args['glob'].trim() ? args['glob'].trim() : null;
        function fileAllowed(fullPath: string): boolean {
          if (typeFilter && !matchesFileType(fullPath, typeFilter)) return false;
          if (globArg && !matchesFileGlob(relative(workingDir, fullPath), globArg)) return false;
          return true;
        }

        const ig = loadGitignore(workingDir);
        const outputLines: string[] = [];
        const filesWithMatches = new Set<string>();
        let matchCount = 0;

        function searchFile(fullPath: string): void {
          if (!fileAllowed(fullPath)) return;
          let content: string;
          try {
            content = readFileSync(fullPath, 'utf-8');
          } catch {
            return;
          }

          const lines = content.split(/\r?\n/);
          const relativePath = relative(workingDir, fullPath);

          // files_with_matches: stop at the first hit — no need to scan the rest.
          if (outputMode === 'files_with_matches') {
            for (const line of lines) {
              if (regex.test(line)) { filesWithMatches.add(relativePath); return; }
            }
            return;
          }

          const matchedIdx: number[] = [];
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i] ?? '')) matchedIdx.push(i);
          }
          if (!matchedIdx.length) return;
          filesWithMatches.add(relativePath);

          if (outputMode === 'count') { matchCount += matchedIdx.length; return; }

          // content mode, no context: one line per match (the original behaviour).
          if (!withContext) {
            for (const i of matchedIdx) {
              const ln = includeLineNumbers ? `${i + 1}:` : '';
              outputLines.push(`${relativePath}:${ln}${lines[i] ?? ''}`);
            }
            return;
          }

          // content mode with context: merge overlapping/adjacent windows into
          // ranges; match lines use ':' and context lines use '-' (ripgrep), with
          // '--' between non-contiguous groups.
          const matchSet = new Set(matchedIdx);
          const ranges: Array<{ start: number; end: number }> = [];
          for (const i of matchedIdx) {
            const start = Math.max(0, i - beforeCtx);
            const end = Math.min(lines.length - 1, i + afterCtx);
            const last = ranges[ranges.length - 1];
            if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
            else ranges.push({ start, end });
          }
          for (const { start, end } of ranges) {
            if (outputLines.length) outputLines.push('--');
            for (let i = start; i <= end; i++) {
              const sep = matchSet.has(i) ? ':' : '-';
              const ln = includeLineNumbers ? `${i + 1}${sep}` : '';
              outputLines.push(`${relativePath}${sep}${ln}${lines[i] ?? ''}`);
            }
          }
        }

        function walk(dir: string): void {
          let entries;
          try {
            entries = readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }

          for (const entry of entries) {
            if (IGNORED_DIRS.has(entry.name)) continue;
            const fullPath = join(dir, entry.name);
            if (isPathIgnored(ig, workingDir, fullPath, entry.isDirectory())) continue;
            if (entry.isDirectory()) {
              walk(fullPath);
              continue;
            }

            let stats;
            try {
              stats = statSync(fullPath);
            } catch {
              continue;
            }

            if (!stats.isFile()) {
              continue;
            }

            searchFile(fullPath);
          }
        }

        // The `path` param accepts a file OR a directory (per the schema). A
        // file must be searched directly — feeding it to walk()'s readdirSync
        // throws ENOTDIR and used to surface as a misleading "No matches found".
        let rootStats;
        try {
          rootStats = statSync(searchRoot);
        } catch {
          rootStats = null;
        }
        if (rootStats?.isFile()) {
          searchFile(searchRoot);
        } else {
          walk(searchRoot);
        }

        // Display cap: honour head_limit/limit, default 50. The old fixed 5 was
        // far too small for the 1M-token window — "find all usages of X" showed
        // 5 of N and forced repeated narrower searches.
        const headLimitArg = args['head_limit'] ?? args['limit'];
        const MAX_DISPLAY_LINES = typeof headLimitArg === 'number' && headLimitArg > 0
          ? Math.floor(headLimitArg)
          : 50;

        if (outputMode === 'files_with_matches') {
          if (!filesWithMatches.size) {
            return 'No matches found';
          }
          const files = Array.from(filesWithMatches).sort();
          if (files.length <= MAX_DISPLAY_LINES) {
            return files.join('\n');
          }
          return `${files.slice(0, MAX_DISPLAY_LINES).join('\n')}\n... +${files.length - MAX_DISPLAY_LINES} more files`;
        }

        if (outputMode === 'count') {
          return `Matches: ${matchCount}`;
        }

        if (!outputLines.length) return 'No matches found';
        const unit = withContext ? 'lines' : 'matches';
        if (outputLines.length <= MAX_DISPLAY_LINES) {
          return outputLines.join('\n');
        }
        return `${outputLines.slice(0, MAX_DISPLAY_LINES).join('\n')}\n... +${outputLines.length - MAX_DISPLAY_LINES} more ${unit}`;
      },
    },
  ];
}
