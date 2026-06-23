/**
 * Renders the /diff review panel — the colored, capped diff of every file the
 * agent changed this run. Pure (takes already-read before/after content, no
 * disk or module state) so it's unit-testable; the shell maps the
 * fileChangeTracker's getChangedFiles() into ChangeItem[] and prepends the
 * dismissable-panel header. Diff bodies use the same formatDiffClaudeStyle the
 * post-write inline diffs use, so /diff matches what scrolled by during the turn.
 */

import chalk from 'chalk';
import { buildDiffSegments, formatDiffClaudeStyle } from '../tools/diffUtils.js';

export interface ChangeItem {
  relPath: string;
  /** content before this run (—'' for a newly created file) */
  previous: string;
  /** content now on disk ('' when deleted) */
  current: string;
  existedBefore: boolean;
  deleted: boolean;
}

export interface ChangePanelOptions {
  maxFiles?: number;
  maxLinesPerFile?: number;
  /** formatDiffClaudeStyle emits raw ANSI; tests pass false for plain output */
  useColors?: boolean;
}

export interface ChangePanel {
  lines: string[];
  totalAdditions: number;
  totalRemovals: number;
}

export function renderChangePanel(items: ChangeItem[], opts: ChangePanelOptions = {}): ChangePanel {
  const maxFiles = opts.maxFiles ?? 6;
  const maxLinesPerFile = opts.maxLinesPerFile ?? 14;
  const useColors = opts.useColors ?? true;
  const dim = (s: string) => chalk.dim(s);

  const lines: string[] = [];
  let totalAdditions = 0;
  let totalRemovals = 0;
  let shown = 0;

  for (const item of items) {
    const after = item.deleted ? '' : item.current;
    const segments = buildDiffSegments(item.previous, after);
    const adds = segments.filter((s) => s.type === 'added').length;
    const dels = segments.filter((s) => s.type === 'removed').length;
    totalAdditions += adds;
    totalRemovals += dels;

    if (shown < maxFiles) {
      const tag = !item.existedBefore ? ' (new)' : item.deleted ? ' (deleted)' : '';
      lines.push(
        chalk.hex('#ffd666')(item.relPath) + '  ' +
          chalk.green(`+${adds}`) + ' ' + chalk.hex('#EF4444')(`-${dels}`) + dim(tag),
      );
      const body = formatDiffClaudeStyle(segments, useColors);
      lines.push(...body.slice(0, maxLinesPerFile));
      if (body.length > maxLinesPerFile) {
        lines.push(dim(`      … +${body.length - maxLinesPerFile} more lines`));
      }
      lines.push('');
      shown += 1;
    }
  }

  const hidden = items.length - Math.min(items.length, maxFiles);
  if (hidden > 0) {
    lines.push(dim(`… +${hidden} more file${hidden === 1 ? '' : 's'}`));
  }
  lines.push(
    dim(`${items.length} file${items.length === 1 ? '' : 's'} changed · `) +
      chalk.green(`+${totalAdditions}`) + ' ' + chalk.hex('#EF4444')(`-${totalRemovals}`),
  );

  return { lines, totalAdditions, totalRemovals };
}
