import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNotebookTools } from '../src/tools/notebookTools.js';

describe('NotebookEdit tool', () => {
  let workingDir: string;
  let edit: (a: Record<string, unknown>) => Promise<string>;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-nb-'));
    edit = createNotebookTools(workingDir).find((t) => t.name === 'NotebookEdit')!.handler as never;
  });
  afterEach(() => rmSync(workingDir, { recursive: true, force: true }));

  function writeNotebook(name: string, cells: Array<{ cell_type: 'code' | 'markdown'; source: string | string[] }>): string {
    const nb = {
      cells: cells.map((c) => ({
        cell_type: c.cell_type,
        source: c.source,
        metadata: {},
        ...(c.cell_type === 'code' ? { execution_count: null, outputs: [] } : {}),
      })),
      metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
      nbformat: 4,
      nbformat_minor: 5,
    };
    const path = join(workingDir, name);
    writeFileSync(path, JSON.stringify(nb, null, 2), 'utf-8');
    return path;
  }

  it('replace mode rewrites a cell\'s source', async () => {
    const path = writeNotebook('a.ipynb', [
      { cell_type: 'code', source: 'print("hi")' },
      { cell_type: 'code', source: 'x = 1' },
    ]);
    const out = await edit({ notebook_path: path, cell_index: 1, new_source: 'x = 42', mode: 'replace' });
    expect(out).toContain('replaced cell 1');
    const nb = JSON.parse(readFileSync(path, 'utf-8'));
    expect(nb.cells[1].source).toEqual(['x = 42']);
    expect(nb.cells[0].source).toBe('print("hi")');
  });

  it('replace clears outputs + execution_count for code cells', async () => {
    const path = writeNotebook('b.ipynb', [{ cell_type: 'code', source: 'old' }]);
    const nb = JSON.parse(readFileSync(path, 'utf-8'));
    nb.cells[0].outputs = [{ output_type: 'stream', text: 'old output' }];
    nb.cells[0].execution_count = 7;
    writeFileSync(path, JSON.stringify(nb, null, 2), 'utf-8');
    await edit({ notebook_path: path, cell_index: 0, new_source: 'new', mode: 'replace' });
    const after = JSON.parse(readFileSync(path, 'utf-8'));
    expect(after.cells[0].outputs).toEqual([]);
    expect(after.cells[0].execution_count).toBe(null);
  });

  it('insert mode adds a cell at index, shifts the rest down', async () => {
    const path = writeNotebook('c.ipynb', [
      { cell_type: 'code', source: 'first' },
      { cell_type: 'code', source: 'second' },
    ]);
    await edit({ notebook_path: path, cell_index: 1, new_source: 'inserted', mode: 'insert' });
    const nb = JSON.parse(readFileSync(path, 'utf-8'));
    expect(nb.cells.length).toBe(3);
    expect(nb.cells[0].source).toBe('first');
    expect(nb.cells[1].source).toEqual(['inserted']);
    expect(nb.cells[2].source).toBe('second');
  });

  it('insert with cell_type=markdown produces a markdown cell (no outputs field)', async () => {
    const path = writeNotebook('d.ipynb', [{ cell_type: 'code', source: 'x = 1' }]);
    await edit({ notebook_path: path, cell_index: 0, new_source: '# Header', mode: 'insert', cell_type: 'markdown' });
    const nb = JSON.parse(readFileSync(path, 'utf-8'));
    expect(nb.cells[0].cell_type).toBe('markdown');
    expect(nb.cells[0]).not.toHaveProperty('outputs');
  });

  it('delete mode removes the cell at index', async () => {
    const path = writeNotebook('e.ipynb', [
      { cell_type: 'code', source: 'a' },
      { cell_type: 'code', source: 'b' },
      { cell_type: 'code', source: 'c' },
    ]);
    await edit({ notebook_path: path, cell_index: 1, mode: 'delete' });
    const nb = JSON.parse(readFileSync(path, 'utf-8'));
    expect(nb.cells.length).toBe(2);
    expect(nb.cells[0].source).toBe('a');
    expect(nb.cells[1].source).toBe('c');
  });

  it('rejects out-of-range cell_index for replace', async () => {
    const path = writeNotebook('f.ipynb', [{ cell_type: 'code', source: 'x' }]);
    expect(await edit({ notebook_path: path, cell_index: 5, new_source: 'y', mode: 'replace' })).toContain('out of range');
  });

  it('rejects non-.ipynb files', async () => {
    const path = join(workingDir, 'not-a-notebook.py');
    writeFileSync(path, 'print(1)', 'utf-8');
    expect(await edit({ notebook_path: path, cell_index: 0, new_source: 'x' })).toContain('must end in .ipynb');
  });

  it('rejects malformed JSON gracefully', async () => {
    const path = join(workingDir, 'bad.ipynb');
    writeFileSync(path, '{not valid json', 'utf-8');
    expect(await edit({ notebook_path: path, cell_index: 0, new_source: 'x' })).toContain('parse failed');
  });

  it('preserves notebook metadata (kernelspec, nbformat) across edits', async () => {
    const path = writeNotebook('g.ipynb', [{ cell_type: 'code', source: 'x' }]);
    await edit({ notebook_path: path, cell_index: 0, new_source: 'y', mode: 'replace' });
    const nb = JSON.parse(readFileSync(path, 'utf-8'));
    expect(nb.nbformat).toBe(4);
    expect(nb.metadata.kernelspec.name).toBe('python3');
  });
});
