/**
 * Persistent memory tools — save/recall facts across CLI sessions.
 * Mirrors the Claude Agent SDK memory pattern: a per-project
 * directory of markdown files, each with a name + brief description,
 * indexed so the agent can browse and selectively load.
 *
 * Storage layout (all paths relative to the working directory):
 *   .anvilwing/memory/
 *     MEMORY.md         — index file the agent maintains
 *     <name>.md         — individual memory entries
 *
 * Tools provided:
 *   memory_save(name, content, description?)
 *   memory_list()
 *   memory_load(name)
 *   memory_delete(name)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '../core/toolRuntime.js';

function memoryDir(workingDir: string): string {
  return join(workingDir, '.anvilwing', 'memory');
}

function ensureDir(workingDir: string): string {
  const dir = memoryDir(workingDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Sanitize a memory name for use as a filename. Strict allow-list. */
function safeName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  // Allow letters, digits, underscore, hyphen. Reject path traversal,
  // dots (so the name can't escape .md), spaces.
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  if (trimmed.length > 80) return null;
  return trimmed;
}

/**
 * Append a one-line note to the project's `notes` memory entry — the `#<note>`
 * quick-capture shortcut (Claude Code parity). Lands in the same store the
 * agent reads (.anvilwing/memory/), so captured notes survive across sessions
 * and show up in the index. Returns false for a blank note.
 */
export function appendMemoryNote(workingDir: string, note: string): boolean {
  const text = (note || '').trim();
  if (!text) return false;
  const dir = ensureDir(workingDir);
  const file = join(dir, 'notes.md');
  const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '> Quick notes captured with #';
  writeFileSync(file, `${existing.replace(/\s+$/, '')}\n- ${text}\n`, 'utf-8');
  rebuildIndex(dir);
  return true;
}

export function createMemoryTools(workingDir: string): ToolDefinition[] {
  return [
    {
      name: 'memory_save',
      description:
        'Save a piece of context (project facts, user preferences, prior decisions) to persistent memory so it survives across CLI sessions. Use for non-obvious facts the user shares OR validated approaches you want to repeat. Overwrites any existing entry with the same name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique short identifier ([A-Za-z0-9_-]+, max 80 chars). Becomes the filename.' },
          content: { type: 'string', description: 'The memory body. Markdown is fine.' },
          description: { type: 'string', description: 'One-line summary used for the index. Optional but recommended.' },
        },
        required: ['name', 'content'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const name = safeName((args as Record<string, unknown>)['name']);
        if (!name) return 'Error: name must match [A-Za-z0-9_-]+ (letters, digits, _, -).';
        const content = (args as Record<string, unknown>)['content'];
        if (typeof content !== 'string') return 'Error: content must be a string.';
        const description = (args as Record<string, unknown>)['description'];
        const dir = ensureDir(workingDir);
        const filePath = join(dir, `${name}.md`);
        const body = description && typeof description === 'string'
          ? `> ${description.trim()}\n\n${content}`
          : content;
        writeFileSync(filePath, body, 'utf-8');
        // Update MEMORY.md index — append/replace this entry.
        rebuildIndex(dir);
        return `⏺ memory_save(${name}) — saved (${Buffer.byteLength(body, 'utf8')} bytes)`;
      },
    },
    {
      name: 'memory_list',
      description: 'List all saved memories with their one-line descriptions. Use BEFORE memory_load to see what\'s available.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const dir = memoryDir(workingDir);
        if (!existsSync(dir)) return 'No memories saved yet.';
        const entries = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
        if (entries.length === 0) return 'No memories saved yet.';
        const lines: string[] = [`Memories (${entries.length}):`];
        for (const file of entries.sort()) {
          const name = file.slice(0, -3);
          let desc = '';
          try {
            const body = readFileSync(join(dir, file), 'utf-8');
            const firstLine = body.split('\n')[0]?.trim() ?? '';
            if (firstLine.startsWith('>')) {
              desc = firstLine.slice(1).trim();
            }
          } catch { /* skip */ }
          lines.push(`  - ${name}${desc ? ` — ${desc}` : ''}`);
        }
        return lines.join('\n');
      },
    },
    {
      name: 'memory_load',
      description: 'Load the full content of a previously saved memory by name. Use after memory_list to pull in relevant context.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The memory identifier passed to memory_save.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const name = safeName((args as Record<string, unknown>)['name']);
        if (!name) return 'Error: name must match [A-Za-z0-9_-]+.';
        const filePath = join(memoryDir(workingDir), `${name}.md`);
        if (!existsSync(filePath)) return `Memory not found: ${name}. Use memory_list to see what's saved.`;
        return readFileSync(filePath, 'utf-8');
      },
    },
    {
      name: 'memory_delete',
      description: 'Delete a memory permanently. Use sparingly — prefer overwriting via memory_save with the same name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The memory identifier to remove.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const name = safeName((args as Record<string, unknown>)['name']);
        if (!name) return 'Error: name must match [A-Za-z0-9_-]+.';
        const dir = memoryDir(workingDir);
        const filePath = join(dir, `${name}.md`);
        if (!existsSync(filePath)) return `Memory not found: ${name}.`;
        unlinkSync(filePath);
        rebuildIndex(dir);
        return `⏺ memory_delete(${name}) — removed.`;
      },
    },
  ];
}

/**
 * Rebuild MEMORY.md from the current set of entries. The index is a
 * simple bulleted list — agents that load all of MEMORY.md at the
 * start of a session see the catalogue without reading every entry.
 */
function rebuildIndex(dir: string): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
  const lines: string[] = ['# Memory index', '', 'Saved entries:', ''];
  for (const file of entries) {
    const name = file.slice(0, -3);
    let desc = '';
    try {
      const body = readFileSync(join(dir, file), 'utf-8');
      const firstLine = body.split('\n')[0]?.trim() ?? '';
      if (firstLine.startsWith('>')) desc = firstLine.slice(1).trim();
    } catch { /* skip */ }
    lines.push(`- [${name}](./${name}.md)${desc ? ` — ${desc}` : ''}`);
  }
  if (entries.length === 0) lines.push('_(empty)_');
  writeFileSync(join(dir, 'MEMORY.md'), lines.join('\n') + '\n', 'utf-8');
}
