import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EDIT_WITHOUT_READ, validateAIFlowPatterns } from '../src/core/toolPreconditions.js';

describe('validateAIFlowPatterns edit/read requirements', () => {
  it('does not warn when creating a new file without a prior read', () => {
    const warnings = validateAIFlowPatterns(
      'Edit',
      { file_path: '/tmp/new-file.txt', old_string: '' },
      []
    );

    expect(warnings.some((warning) => warning.code === EDIT_WITHOUT_READ)).toBe(false);
  });

  it('recognizes a prior read when paths differ only by relative vs absolute', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'preconditions-'));
    const originalCwd = process.cwd();

    try {
      process.chdir(tempDir);
      const relativePath = 'src/example.ts';
      const warnings = validateAIFlowPatterns(
        'Edit',
        { file_path: join(tempDir, relativePath), old_string: 'const x = 1;' },
        [
          { toolName: 'read_file', args: { path: relativePath }, timestamp: Date.now() },
        ]
      );

      expect(warnings.some((warning) => warning.code === EDIT_WITHOUT_READ)).toBe(false);
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('recognizes a prior read when history uses file_path key', () => {
    const warnings = validateAIFlowPatterns(
      'Edit',
      { file_path: '/tmp/file-path-key.ts', old_string: 'const y = 2;' },
      [
        { toolName: 'read_file', args: { file_path: '/tmp/file-path-key.ts' }, timestamp: Date.now() },
      ]
    );

    expect(warnings.some((warning) => warning.code === EDIT_WITHOUT_READ)).toBe(false);
  });

  it('warns when editing an existing file without any prior read', () => {
    const warnings = validateAIFlowPatterns(
      'Edit',
      { file_path: '/tmp/existing-file.ts', old_string: 'const value = 1;' },
      []
    );

    expect(warnings.some((warning) => warning.code === EDIT_WITHOUT_READ)).toBe(true);
  });
});
