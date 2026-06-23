const DEBUG_SNIPPET_LENGTH = 180;

let debugEnabled = false;
const listeners = new Set<(enabled: boolean) => void>();

export function isDebugModeEnabled(): boolean {
  return debugEnabled;
}

export function setDebugMode(enabled: boolean): void {
  const normalized = Boolean(enabled);
  if (normalized === debugEnabled) {
    return;
  }
  debugEnabled = normalized;
  for (const listener of listeners) {
    listener(debugEnabled);
  }
}

export function onDebugModeChange(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function logDebug(...args: unknown[]): void {
  if (!debugEnabled) {
    return;
  }
  console.error(...args);
}

export function debugSnippet(value?: string, maxLength: number = DEBUG_SNIPPET_LENGTH): string {
  if (!value) {
    return '';
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength)}…`;
}
