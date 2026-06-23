/**
 * /rewind preview + result text. Pure + emoji-free (the UX contract §9 bans
 * chrome emoji, and the legacy fileChangeTracker.getRevertSummary/revertAllChanges
 * strings use 📋/⏪ + hardcode "/revert confirm" — so the Ink shell builds its
 * own copy here and only calls revertAllChanges for the actual file restore).
 */

export interface RewindItem {
  relPath: string;
  /** true if the file existed before this run (restore); false if created (delete) */
  existedBefore: boolean;
}

export function rewindPreviewLines(items: RewindItem[]): string[] {
  const n = items.length;
  const lines = [`Rewind restores ${n} file${n === 1 ? '' : 's'} to the state before this run:`, ''];
  for (const it of items) {
    lines.push(it.existedBefore ? `  ${it.relPath} (restore)` : `  ${it.relPath} (delete — created this run)`);
  }
  lines.push('');
  lines.push('Run /rewind confirm to restore them.');
  return lines;
}

export function rewindResultLine(restored: number, deleted: number): string {
  const parts: string[] = [];
  if (restored > 0) parts.push(`${restored} file${restored === 1 ? '' : 's'} restored`);
  if (deleted > 0) parts.push(`${deleted} file${deleted === 1 ? '' : 's'} deleted`);
  return parts.length ? `Rewound: ${parts.join(', ')}.` : 'Nothing to rewind.';
}
