/**
 * Notebook tools — Claude-Code-parity for .ipynb editing.
 *
 * Jupyter notebooks are JSON files where the bulk of useful content
 * lives in `cells: [{ cell_type, source: string|string[], … }]`. Doing
 * source edits via the generic Edit tool is brittle because the
 * `source` field is sometimes a string and sometimes a string[],
 * and surrounding JSON whitespace varies. This module exposes a
 * structured tool — `NotebookEdit` — that addresses cells by index
 * and rewrites just that cell's source while preserving everything
 * else.
 *
 * Capabilities:
 *   NotebookEdit({ notebook_path, cell_index, new_source, mode? })
 *     mode: "replace" (default), "insert", "delete"
 *     Returns a short summary of the change.
 */

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ToolDefinition } from '../core/toolRuntime.js';
import { expandHome } from '../utils/pathUtils.js';

interface IpynbCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string | string[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
  [k: string]: unknown;
}

interface IpynbNotebook {
  cells: IpynbCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
  [k: string]: unknown;
}

function resolvePath(workingDir: string, p: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : join(workingDir, expanded);
}

function sourceToString(src: string | string[] | undefined): string {
  if (typeof src === 'string') return src;
  if (Array.isArray(src)) return src.join('');
  return '';
}

function stringToSource(text: string): string[] {
  // Jupyter convention: source is an array of lines, each ending
  // with \n EXCEPT the last (matching how nb-format JSON serializes).
  if (!text) return [];
  const parts = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    out.push(isLast ? parts[i]! : `${parts[i]}\n`);
  }
  // Trim trailing empty entry if text ended with \n.
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

export function createNotebookTools(workingDir: string): ToolDefinition[] {
  return [
    {
      name: 'NotebookEdit',
      description:
        'Edit a Jupyter notebook (.ipynb) cell by index. Use mode "replace" (default) to rewrite a cell\'s source, "insert" to add a new cell at the index (existing cells shift down), or "delete" to remove the cell. The notebook\'s structure (metadata, nbformat, other cells) is preserved exactly. PREFER this over Edit for .ipynb files — generic string edits break on the string|string[] source format.',
      parameters: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Path to the .ipynb file (relative to working dir or absolute).' },
          cell_index: { type: 'number', description: '0-based index of the cell to operate on.' },
          new_source: { type: 'string', description: 'New cell source (text). Required for replace/insert; ignored for delete.' },
          cell_type: {
            type: 'string',
            enum: ['code', 'markdown', 'raw'],
            description: 'Cell type for insert mode. Default: code.',
          },
          mode: {
            type: 'string',
            enum: ['replace', 'insert', 'delete'],
            description: 'Operation. Default: replace.',
          },
        },
        required: ['notebook_path', 'cell_index'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const pathArg = args['notebook_path'];
        if (typeof pathArg !== 'string' || !pathArg.trim()) {
          return 'Error: notebook_path must be a non-empty string.';
        }
        const absPath = resolvePath(workingDir, pathArg);
        if (!existsSync(absPath)) return `Error: notebook not found: ${absPath}`;
        if (!absPath.toLowerCase().endsWith('.ipynb')) {
          return `Error: notebook_path must end in .ipynb (got ${absPath}).`;
        }
        const stats = statSync(absPath);
        if (stats.size > 5 * 1024 * 1024) {
          return `Error: notebook too large for direct edit (${Math.round(stats.size / 1024)}KB > 5MB cap).`;
        }

        const mode = (typeof args['mode'] === 'string' ? args['mode'] : 'replace') as 'replace' | 'insert' | 'delete';
        const cellIndex = typeof args['cell_index'] === 'number' ? args['cell_index'] : -1;
        const newSource = typeof args['new_source'] === 'string' ? args['new_source'] : '';
        const cellType = (typeof args['cell_type'] === 'string' ? args['cell_type'] : 'code') as 'code' | 'markdown' | 'raw';

        let nb: IpynbNotebook;
        try {
          nb = JSON.parse(readFileSync(absPath, 'utf-8'));
        } catch (err) {
          return `Error: notebook JSON parse failed (${(err as Error).message}).`;
        }
        if (!Array.isArray(nb.cells)) {
          return 'Error: notebook has no cells[] array.';
        }
        if (cellIndex < 0 || cellIndex > nb.cells.length) {
          return `Error: cell_index ${cellIndex} out of range (0..${nb.cells.length}).`;
        }

        if (mode === 'replace') {
          if (cellIndex >= nb.cells.length) {
            return `Error: replace mode needs an existing cell. Use insert for cell_index ${cellIndex}.`;
          }
          const before = sourceToString(nb.cells[cellIndex]!.source);
          nb.cells[cellIndex]!.source = stringToSource(newSource);
          // Reset outputs + execution count for code cells when source changes.
          if (nb.cells[cellIndex]!.cell_type === 'code') {
            nb.cells[cellIndex]!.outputs = [];
            nb.cells[cellIndex]!.execution_count = null;
          }
          writeFileSync(absPath, JSON.stringify(nb, null, 1) + '\n', 'utf-8');
          const beforeLines = before.split('\n').length;
          const afterLines = newSource.split('\n').length;
          return `⏺ NotebookEdit(${pathArg}) — replaced cell ${cellIndex} (${beforeLines} → ${afterLines} lines, ${nb.cells[cellIndex]!.cell_type})`;
        }

        if (mode === 'insert') {
          const newCell: IpynbCell =
            cellType === 'code'
              ? { cell_type: 'code', source: stringToSource(newSource), metadata: {}, execution_count: null, outputs: [] }
              : { cell_type: cellType, source: stringToSource(newSource), metadata: {} };
          nb.cells.splice(cellIndex, 0, newCell);
          writeFileSync(absPath, JSON.stringify(nb, null, 1) + '\n', 'utf-8');
          return `⏺ NotebookEdit(${pathArg}) — inserted ${cellType} cell at index ${cellIndex} (${newSource.split('\n').length} lines)`;
        }

        if (mode === 'delete') {
          if (cellIndex >= nb.cells.length) {
            return `Error: cell_index ${cellIndex} out of range for delete (have ${nb.cells.length} cells).`;
          }
          const removed = nb.cells.splice(cellIndex, 1)[0]!;
          writeFileSync(absPath, JSON.stringify(nb, null, 1) + '\n', 'utf-8');
          return `⏺ NotebookEdit(${pathArg}) — deleted cell ${cellIndex} (${removed.cell_type})`;
        }

        return `Error: unknown mode "${mode}".`;
      },
    },
  ];
}
