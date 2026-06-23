// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\u001B\[[0-9;]*m/g;
const DEFAULT_WIDTH = 78;
const MIN_WIDTH = 42;
const MAX_WIDTH = 100;

export type PlanStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanItem {
  step: string;
  status?: PlanStatus;
}

export type NormalizedPlanItem = PlanItem & { status: PlanStatus };
export type PlanInput = Array<PlanItem | string | number | boolean | null | undefined>;

export interface PlanFormatOptions {
  heading?: string;
  bullet?: string;
  width?: number;
  statusSymbols?: Partial<Record<PlanStatus, string>>;
}

/**
 * Format a structured plan for display with compact tree-like layout.
 */
export function formatPlan(plan: PlanInput, options?: PlanFormatOptions): string;
export function formatPlan(plan: unknown, options?: PlanFormatOptions): string;
export function formatPlan(plan: unknown, options: PlanFormatOptions = {}): string {
  const width = clampWidth(options.width);
  const heading = (options.heading ?? 'Updated Plan').trim() || 'Updated Plan';
  const bullet = (options.bullet ?? '•').trim() || '•';
  const items = normalizePlanItems(plan);
  const lines: string[] = [`${bullet} ${heading}`];

  if (!items.length) {
    lines.push('  (no steps provided)');
    return lines.join('\n');
  }

  const statusSymbols = buildStatusSymbols(options.statusSymbols);

  items.forEach((item, index) => {
    const prefix = `${index === 0 ? '  └ ' : '    '}${statusSymbols[item.status]} `;
    lines.push(...wrapPlanText(item.step, prefix, width));
  });

  return lines.join('\n');
}

/**
 * Normalize plan input into a typed list of steps with default statuses.
 */
export function normalizePlanItems(plan: PlanInput): NormalizedPlanItem[];
export function normalizePlanItems(plan: unknown): NormalizedPlanItem[];
export function normalizePlanItems(plan: unknown): NormalizedPlanItem[] {
  if (!Array.isArray(plan)) {
    return [];
  }

  const items: NormalizedPlanItem[] = [];

  for (const entry of plan) {
    if (entry === null || entry === undefined) {
      continue;
    }

    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      const step = String(entry).trim();
      if (!step) {
        continue;
      }
      items.push({ step, status: 'pending' });
      continue;
    }

    if (typeof entry === 'object') {
      const rawStep = (entry as PlanItem).step;
      const step =
        typeof rawStep === 'string'
          ? rawStep.trim()
          : typeof rawStep === 'number' || typeof rawStep === 'boolean'
            ? String(rawStep).trim()
            : '';
      if (!step) {
        continue;
      }
      const status = normalizeStatus((entry as PlanItem).status);
      items.push({ step, status });
    }
  }

  return items;
}

/**
 * Wrap plan text with a prefix, preserving indentation for continuations.
 */
export function wrapPlanText(text: string, prefix: string, width?: number): string[] {
  const normalizedWidth = clampWidth(width);
  const cleanPrefix = prefix ?? '';
  const prefixLength = visibleLength(cleanPrefix);
  const available = Math.max(12, normalizedWidth - prefixLength);
  const wrapped = wrapText(text, available);

  if (!wrapped.length) {
    return [cleanPrefix.trimEnd()];
  }

  const indent = ' '.repeat(prefixLength);
  return wrapped.map((line, index) => (index === 0 ? `${cleanPrefix}${line}` : `${indent}${line}`));
}

/**
 * Determine the available plan width using the terminal size if available.
 */
export function resolvePlanWidth(padding: number = 4): number | undefined {
  if (
    typeof process !== 'undefined' &&
    typeof process.stdout?.columns === 'number' &&
    Number.isFinite(process.stdout.columns)
  ) {
    return Math.max(0, process.stdout.columns - padding);
  }
  return undefined;
}

function buildStatusSymbols(overrides?: Partial<Record<PlanStatus, string>>): Record<PlanStatus, string> {
  return {
    pending: overrides?.pending?.trim() || '□',
    in_progress: overrides?.in_progress?.trim() || '◐',
    completed: overrides?.completed?.trim() || '✔',
  };
}

function normalizeStatus(status: unknown): PlanStatus {
  if (typeof status !== 'string') {
    return 'pending';
  }

  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, '_');

  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') {
    return 'completed';
  }
  if (normalized === 'in_progress' || normalized === 'inprogress') {
    return 'in_progress';
  }
  return 'pending';
}

function wrapText(text: string, width: number): string[] {
  const normalized = (text || '').trim();
  if (!normalized) {
    return [];
  }

  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let current = words.shift() ?? '';

  for (const word of words) {
    const candidate = `${current} ${word}`;
    if (visibleLength(candidate) > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function clampWidth(width?: number): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return DEFAULT_WIDTH;
  }
  const normalized = Math.floor(width);
  if (normalized < MIN_WIDTH) {
    return MIN_WIDTH;
  }
  if (normalized > MAX_WIDTH) {
    return MAX_WIDTH;
  }
  return normalized;
}

function visibleLength(value: string): number {
  return value.replace(ANSI_REGEX, '').length;
}
