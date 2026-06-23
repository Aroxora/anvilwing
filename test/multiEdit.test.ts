/**
 * MultiEdit — apply N edits to one file atomically. If any edit
 * fails, the whole batch rolls back so the file never ends up
 * half-edited.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEditTools } from '../src/tools/editTools.js';

describe('MultiEdit', () => {
  let workingDir: string;
  let handler: (args: Record<string, unknown>) => Promise<string>;
  // Read tool result is required before editing — we mark the file
  // as read manually since the editTools test bypasses the renderer.
  let prepareFile: (path: string, content: string) => void;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-multiedit-'));
    const tool = createEditTools(workingDir).find((t) => t.name === 'MultiEdit');
    if (!tool) throw new Error('MultiEdit tool not found');
    handler = tool.handler as (args: Record<string, unknown>) => Promise<string>;

    prepareFile = (path, content) => {
      writeFileSync(path, content, 'utf-8');
      // Mark as read so the read-before-edit validator passes.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
      const tracker: any = require('../src/tools/fileReadTracker.js');
      if (typeof tracker.recordFileRead === 'function') {
        tracker.recordFileRead(path, content);
      }
    };
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('applies multiple edits in order to one file', async () => {
    const filePath = join(workingDir, 'src.ts');
    prepareFile(filePath, 'function alpha() { return 1; }\nfunction beta() { return 2; }\nfunction gamma() { return 3; }');

    const out = await handler({
      file_path: filePath,
      edits: [
        { old_string: 'return 1;', new_string: 'return 10;' },
        { old_string: 'return 2;', new_string: 'return 20;' },
        { old_string: 'return 3;', new_string: 'return 30;' },
      ],
    });
    expect(out).toContain('3 edits applied');
    const after = readFileSync(filePath, 'utf-8');
    expect(after).toContain('return 10;');
    expect(after).toContain('return 20;');
    expect(after).toContain('return 30;');
    expect(after).not.toContain('return 1;');
  });

  it('subsequent edits see prior edits\' results', async () => {
    const filePath = join(workingDir, 'chain.ts');
    prepareFile(filePath, 'foo');

    const out = await handler({
      file_path: filePath,
      edits: [
        { old_string: 'foo', new_string: 'bar' },
        { old_string: 'bar', new_string: 'baz' },
      ],
    });
    expect(out).not.toContain('Error');
    expect(readFileSync(filePath, 'utf-8')).toBe('baz');
  });

  it('rolls back ALL edits if any one fails', async () => {
    const filePath = join(workingDir, 'rollback.ts');
    const original = 'one\ntwo\nthree';
    prepareFile(filePath, original);

    const out = await handler({
      file_path: filePath,
      edits: [
        { old_string: 'one', new_string: 'ONE' },
        { old_string: 'two', new_string: 'TWO' },
        // This third edit fails — text doesn't exist in file.
        { old_string: 'this-text-is-not-in-the-file', new_string: 'never' },
      ],
    });
    expect(out).toContain('Error');
    expect(out).toMatch(/edit 3\/3/);
    // File restored to original.
    expect(readFileSync(filePath, 'utf-8')).toBe(original);
  });

  it('rejects empty edits array', async () => {
    const out = await handler({ file_path: join(workingDir, 'x.ts'), edits: [] });
    expect(out).toContain('Error: edits must be a non-empty array');
  });

  it('rejects malformed edit entries before touching the file', async () => {
    const filePath = join(workingDir, 'bad.ts');
    prepareFile(filePath, 'untouched');
    const out = await handler({
      file_path: filePath,
      edits: [{ old_string: 'untouched' /* missing new_string */ }],
    });
    expect(out).toContain('new_string must be a string');
    expect(readFileSync(filePath, 'utf-8')).toBe('untouched');
  });

  it('caps at 50 edits per call', async () => {
    const tooMany = Array.from({ length: 51 }, () => ({ old_string: 'x', new_string: 'y' }));
    const out = await handler({ file_path: join(workingDir, 'cap.ts'), edits: tooMany });
    expect(out).toContain('max 50 edits');
  });

  it('a single-edit MultiEdit is equivalent to Edit', async () => {
    const filePath = join(workingDir, 'single.ts');
    prepareFile(filePath, 'before');
    await handler({
      file_path: filePath,
      edits: [{ old_string: 'before', new_string: 'after' }],
    });
    expect(readFileSync(filePath, 'utf-8')).toBe('after');
  });

  it('rolling back when the file did NOT exist at start means file stays absent', async () => {
    const filePath = join(workingDir, 'newfile.ts');
    expect(existsSync(filePath)).toBe(false);
    // First edit creates the file (empty old_string), second fails.
    const out = await handler({
      file_path: filePath,
      edits: [
        { old_string: '', new_string: 'created\n' },
        { old_string: 'this-does-not-exist', new_string: 'unreachable' },
      ],
    });
    expect(out).toContain('Error');
    // Rollback removed the newly-created file.
    expect(existsSync(filePath)).toBe(false);
  });
});
