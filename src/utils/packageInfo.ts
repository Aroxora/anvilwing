import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PackageInfo {
  name?: string;
  version?: string;
}

/**
 * Locate and read the nearest package.json starting from the caller's module URL.
 * This mirrors prior per-file helpers but centralizes the logic so CLI entrypoints
 * and tests stay consistent even if their relative paths change.
 */
export function readPackageInfo(
  importMetaUrl: string | URL,
  options?: { maxDepth?: number }
): PackageInfo {
  const maxDepth = options?.maxDepth ?? 6;
  const startDir = dirname(fileURLToPath(importMetaUrl));
  const packagePath = findNearestPackageJson(startDir, maxDepth);
  if (!packagePath) {
    return {};
  }

  try {
    const payload = JSON.parse(readFileSync(packagePath, 'utf8')) as PackageInfo;
    return {
      name: typeof payload.name === 'string' ? payload.name : undefined,
      version: typeof payload.version === 'string' ? payload.version : undefined,
    };
  } catch {
    return {};
  }
}

export function readPackageVersion(importMetaUrl: string | URL, fallback = '0.0.0'): string {
  return readPackageInfo(importMetaUrl).version ?? fallback;
}

function findNearestPackageJson(startDir: string, maxDepth: number): string | null {
  let current = startDir;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = resolve(current, 'package.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}
