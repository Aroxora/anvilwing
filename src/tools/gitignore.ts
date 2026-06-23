import ignore from 'ignore';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export type IgnoreInstance = ReturnType<typeof ignore>;

/**
 * Load .gitignore (+ .git/info/exclude) from the repo root (workingDir) so Grep,
 * Glob, and Search skip the same files git does — build artifacts, generated
 * code, vendored deps, and gitignored secrets like .env. This is the ripgrep/
 * Claude Code default. Root-level only: nested .gitignores aren't loaded (the
 * root file covers the common case). Returns null when there's nothing to ignore,
 * so callers fall back to just IGNORED_DIRS with zero overhead.
 */
export function loadGitignore(workingDir: string): IgnoreInstance | null {
  const ig = ignore();
  let any = false;
  for (const rel of ['.gitignore', '.git/info/exclude']) {
    try {
      ig.add(readFileSync(join(workingDir, rel), 'utf-8'));
      any = true;
    } catch { /* absent — fine */ }
  }
  return any ? ig : null;
}

/**
 * True if fullPath (under workingDir) is gitignored. Directories get a trailing
 * slash so dir-only patterns (`vendor/`) match — letting the walk prune the whole
 * subtree. Paths outside workingDir (rel starts with ..) are never ignored.
 */
export function isPathIgnored(
  ig: IgnoreInstance | null,
  workingDir: string,
  fullPath: string,
  isDir: boolean
): boolean {
  if (!ig) return false;
  const rel = relative(workingDir, fullPath).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return false;
  return ig.ignores(isDir ? `${rel}/` : rel);
}
