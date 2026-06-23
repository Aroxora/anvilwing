/**
 * Lightweight frontmatter parser that supports simple YAML-style key/value fields.
 * Designed for small agent/skill metadata files without pulling in extra dependencies.
 */
export interface ParsedFrontmatter<T extends Record<string, unknown>> {
  attributes: Partial<T>;
  body: string;
}

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export function parseFrontmatter<T extends Record<string, unknown>>(content: string): ParsedFrontmatter<T> {
  if (!content.trim().startsWith('---')) {
    return { attributes: {}, body: content };
  }

  const match = FRONTMATTER_REGEX.exec(content);
  if (!match) {
    return { attributes: {}, body: content };
  }

  const [, rawFrontmatter, body] = match;
  const attributes = parseAttributes(rawFrontmatter ?? '');
  return {
    attributes: attributes as Partial<T>,
    body: body ?? '',
  };
}

function parseAttributes(raw: string): Record<string, unknown> {
  const lines = raw.split('\n');
  const result: Record<string, unknown> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    result[key] = parseAttributeValue(value);
  }

  return result;
}

function parseAttributeValue(raw: string): unknown {
  if (!raw) {
    return '';
  }

  // Quoted strings
  const singleQuoted = /^'(.*)'$/.exec(raw);
  if (singleQuoted) {
    return singleQuoted[1];
  }
  const doubleQuoted = /^"(.*)"$/.exec(raw);
  if (doubleQuoted) {
    return doubleQuoted[1];
  }

  // Boolean
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Array syntax: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1);
    return splitList(inner);
  }

  // Comma-separated list: a, b, c
  if (raw.includes(',')) {
    return splitList(raw);
  }

  // Numeric
  const numeric = Number(raw);
  if (!Number.isNaN(numeric)) {
    return numeric;
  }

  return raw;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
