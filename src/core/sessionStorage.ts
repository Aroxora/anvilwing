import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SessionStorage {
  ensureDir(path: string): void;
  writeFile(path: string, content: string): void;
  readFile(path: string): string;
  exists(path: string): boolean;
}

const fsStorage: SessionStorage = {
  ensureDir(path: string): void {
    mkdirSync(path, { recursive: true });
  },
  writeFile(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  },
  readFile(path: string): string {
    return readFileSync(path, 'utf8');
  },
  exists(path: string): boolean {
    return existsSync(path);
  },
};

let activeStorage: SessionStorage = fsStorage;

export function setSessionStorage(storage: SessionStorage): void {
  activeStorage = storage;
}

export function getSessionStorage(): SessionStorage {
  return activeStorage;
}

export function createInMemorySessionStorage(): SessionStorage {
  const files = new Map<string, string>();
  return {
    ensureDir(_path: string): void {
      // no-op for memory
    },
    writeFile(path: string, content: string): void {
      files.set(path, content);
    },
    readFile(path: string): string {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return content;
    },
    exists(path: string): boolean {
      return files.has(path);
    },
  };
}
