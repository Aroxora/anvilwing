export type ErrorContextValue = string | number | boolean | null | undefined;

export type ErrorContext = Record<string, ErrorContextValue>;

export function buildError(action: string, error: unknown, context?: ErrorContext): string {
  const message = error instanceof Error ? error.message : String(error);
  const contextDetails = formatContext(context);
  return contextDetails ? `Error ${action}: ${message} (${contextDetails})` : `Error ${action}: ${message}`;
}

function formatContext(context?: ErrorContext): string {
  if (!context) {
    return '';
  }
  const entries = Object.entries(context).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) {
    return '';
  }
  return entries
    .map(([key, value]) => `${formatContextKey(key)} ${formatContextValue(value)}`)
    .join(', ');
}

function formatContextKey(key: string): string {
  if (!key) {
    return key;
  }
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

function formatContextValue(value: ErrorContextValue): string {
  if (typeof value === 'string') {
    return value || '(empty)';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '(unknown)';
}
