import { stdout } from 'node:process';

type StatusSink = (message: string) => void;

let statusSink: StatusSink | null = null;

const normalizeStatusMessage = (message: string): string =>
  message.replace(/\s+/g, ' ').trim();

export function setStatusSink(sink: StatusSink | null): void {
  statusSink = sink;
}

export function reportStatus(message: string): void {
  const normalized = normalizeStatusMessage(message);
  if (!normalized) {
    return;
  }
  if (statusSink) {
    statusSink(normalized);
    return;
  }
  stdout.write(`${normalized}\n`);
}

export function reportStatusError(error: unknown, prefix: string = 'Error'): void {
  const message = error instanceof Error ? error.message : String(error);
  const safePrefix = prefix.trim();
  const text = safePrefix
    ? `${safePrefix}${safePrefix.endsWith(':') ? '' : ':'} ${message}`
    : message;
  reportStatus(text);
}
