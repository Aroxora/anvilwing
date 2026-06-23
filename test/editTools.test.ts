/* eslint-disable no-control-regex */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEditTools } from '../src/tools/editTools.js';

describe('Edit tool', () => {
  let workingDir: string;
  let editHandler: (args: Record<string, unknown>) => Promise<string>;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-edit-'));
    const editTool = createEditTools(workingDir).find((tool) => tool.name === 'Edit');
    if (!editTool) {
      throw new Error('Edit tool not found');
    }
    editHandler = editTool.handler as (args: Record<string, unknown>) => Promise<string>;
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('creates a new file and shows green diff lines', async () => {
    const filePath = join(workingDir, 'new-file.txt');

    const output = await editHandler({
      file_path: filePath,
      old_string: '',
      new_string: 'hello world',
    });

    // Claude Code style: ⏺ Create(filepath)
    expect(output).toContain('⏺ Create(new-file.txt)');
    expect(output).toContain('with 1 additions');
    expect(output).toMatch(/\x1b\[(?:1;)?32m.*hello world/);
  });

  it('deletes text when new_string is omitted and shows red diff lines', async () => {
    const filePath = join(workingDir, 'remove-file.txt');
    writeFileSync(filePath, 'remove me', 'utf-8');

    const output = await editHandler({
      file_path: filePath,
      old_string: 'remove me',
    });

    // Claude Code style: ⏺ Update(filepath) with removals
    expect(output).toContain('⏺ Update(remove-file.txt)');
    expect(output).toContain('with 1 removal');
    // Check for the removal marker (red line with -)
    expect(output).toMatch(/\x1b\[(?:1;)?31m.*remove me/);
  });

  it('normalizes escaped newline sequences in old_string to avoid false mismatches', async () => {
    const filePath = join(workingDir, 'escape.txt');
    writeFileSync(filePath, 'first\nsecond\n', 'utf-8');

    const output = await editHandler({
      file_path: filePath,
      old_string: 'first\\nsecond',
      new_string: 'first\nupdated',
      replace_all: true,
    });

    expect(output).toContain('normalized escaped old_string');
    expect(readFileSync(filePath, 'utf-8')).toBe('first\nupdated\n');
  });

  it('tolerates indentation differences via flexible whitespace matching', async () => {
    const filePath = join(workingDir, 'whitespace.txt');
    writeFileSync(filePath, '    alpha\n        beta\n', 'utf-8');

    const output = await editHandler({
      file_path: filePath,
      old_string: 'alpha\n  beta',
      new_string: 'alpha\n  gamma',
      replace_all: true,
    });

    expect(output).toContain('normalized whitespace');
    expect(readFileSync(filePath, 'utf-8')).toBe('    alpha\n        gamma\n');
  });

  describe('sequential edits (surgical precision)', () => {
    it('handles multiple sequential edits to the same file correctly', async () => {
      const filePath = join(workingDir, 'sequential.ts');
      writeFileSync(
        filePath,
        `function add(a: number, b: number): number {
  return a + b;
}

function subtract(a: number, b: number): number {
  return a - b;
}
`,
        'utf-8'
      );

      // Edit 1: Change add function
      const edit1 = await editHandler({
        file_path: filePath,
        old_string: 'function add(a: number, b: number): number {\n  return a + b;\n}',
        new_string: 'function add(a: number, b: number): number {\n  // Sum two numbers\n  return a + b;\n}',
      });
      // Claude Code style
      expect(edit1).toContain('⏺ Update(sequential.ts)');

      // Edit 2: Change subtract function (line numbers have shifted!)
      const edit2 = await editHandler({
        file_path: filePath,
        old_string: 'function subtract(a: number, b: number): number {\n  return a - b;\n}',
        new_string: 'function subtract(a: number, b: number): number {\n  // Subtract b from a\n  return a - b;\n}',
      });
      expect(edit2).toContain('⏺ Update(sequential.ts)');

      // Verify final content
      const final = readFileSync(filePath, 'utf-8');
      expect(final).toContain('// Sum two numbers');
      expect(final).toContain('// Subtract b from a');
    });

    it('handles edits that add multiple lines then target new content', async () => {
      const filePath = join(workingDir, 'grow.ts');
      writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

      // Edit 1: Add more lines
      await editHandler({
        file_path: filePath,
        old_string: 'const x = 1;',
        new_string: 'const x = 1;\nconst y = 2;\nconst z = 3;',
      });

      // Edit 2: Modify the newly added line
      const edit2 = await editHandler({
        file_path: filePath,
        old_string: 'const y = 2;',
        new_string: 'const y = 20; // modified',
      });
      expect(edit2).toContain('⏺ Update(grow.ts)');

      expect(readFileSync(filePath, 'utf-8')).toBe('const x = 1;\nconst y = 20; // modified\nconst z = 3;\n');
    });

    it('handles edits that remove lines then target remaining content', async () => {
      const filePath = join(workingDir, 'shrink.ts');
      writeFileSync(
        filePath,
        `line1
line2
line3
line4
line5
`,
        'utf-8'
      );

      // Edit 1: Remove lines 2-3
      await editHandler({
        file_path: filePath,
        old_string: 'line2\nline3\n',
        new_string: '',
      });

      // Edit 2: Modify line4 (which is now at a different position)
      const edit2 = await editHandler({
        file_path: filePath,
        old_string: 'line4',
        new_string: 'line4_modified',
      });
      expect(edit2).toContain('⏺ Update(shrink.ts)');

      expect(readFileSync(filePath, 'utf-8')).toBe('line1\nline4_modified\nline5\n');
    });

    it('handles complex real-world edit sequence like Claude Code', async () => {
      // Simulate the example from user: multiple edits to editTools.ts-like content
      const filePath = join(workingDir, 'complex.ts');
      writeFileSync(
        filePath,
        `export async function performEdit(args: EditArgs): Promise<string> {
  const oldString = args.old_string;
  const newStringRaw = args.new_string;
  const newString = typeof newStringRaw === 'string' ? newStringRaw : '';

  // Normalize escaped literals to reduce mismatch errors (e.g., "\\n" vs actual newline)
  let targetString = oldString;
  let normalizedFromEscapes = false;
  if (!content.includes(targetString)) {
    const unescaped = unescapeLiteral(oldString);
    if (unescaped !== oldString && content.includes(unescaped)) {
      targetString = unescaped;
      normalizedFromEscapes = true;
    }
  }

  // Perform replacement
  const result = content.replace(targetString, newString);
  return \`✓ Edited \${displayPath}\${normalizedFromEscapes ? ' [normalized escaped old_string]' : ''}\`;
}
`,
        'utf-8'
      );

      // Edit 1: Change comment and variable name
      const edit1 = await editHandler({
        file_path: filePath,
        old_string: `  // Normalize escaped literals to reduce mismatch errors (e.g., "\\n" vs actual newline)
  let targetString = oldString;
  let normalizedFromEscapes = false;`,
        new_string: `  // Normalize escaped literals and whitespace differences to reduce mismatch errors
  let targetString = oldString;
  let matchNote: string | null = null;`,
      });
      expect(edit1).toContain('⏺ Update(complex.ts)');

      // Edit 2: Change the inner logic
      const edit2 = await editHandler({
        file_path: filePath,
        old_string: `      targetString = unescaped;
      normalizedFromEscapes = true;`,
        new_string: `      targetString = unescaped;
      matchNote = 'normalized escaped old_string';`,
      });
      expect(edit2).toContain('⏺ Update(complex.ts)');

      // Edit 3: Update the return statement
      const edit3 = await editHandler({
        file_path: filePath,
        old_string: "return `✓ Edited ${displayPath}${normalizedFromEscapes ? ' [normalized escaped old_string]' : ''}`;",
        new_string: "return `✓ Edited ${displayPath}${matchNote ? ` [${matchNote}]` : ''}`;",
      });
      expect(edit3).toContain('⏺ Update(complex.ts)');

      // Edit 4: Rename newString to replacementString
      const edit4 = await editHandler({
        file_path: filePath,
        old_string: "const newString = typeof newStringRaw === 'string' ? newStringRaw : '';",
        new_string: "let replacementString = typeof newStringRaw === 'string' ? newStringRaw : '';",
      });
      expect(edit4).toContain('⏺ Update(complex.ts)');

      const edit5 = await editHandler({
        file_path: filePath,
        old_string: 'const result = content.replace(targetString, newString);',
        new_string: 'const result = content.replace(targetString, replacementString);',
      });
      expect(edit5).toContain('⏺ Update(complex.ts)');

      // Verify final content has all changes
      const final = readFileSync(filePath, 'utf-8');
      expect(final).toContain('let matchNote: string | null = null;');
      expect(final).toContain("matchNote = 'normalized escaped old_string';");
      expect(final).toContain('let replacementString =');
      expect(final).toContain('replace(targetString, replacementString)');
      expect(final).toContain('${matchNote ?');
      expect(final).not.toContain('normalizedFromEscapes');
      expect(final).not.toContain('const newString =');
    });

    it('handles edits with varying indentation levels in sequence', async () => {
      const filePath = join(workingDir, 'indent.ts');
      writeFileSync(
        filePath,
        `class Example {
  constructor() {
    this.value = 0;
  }

  method() {
    if (true) {
      // TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
      console.log('nested');
      }
  }
}
`,
        'utf-8'
      );

      // Edit 1: Change constructor
      await editHandler({
        file_path: filePath,
        old_string: '  constructor() {\n    this.value = 0;\n  }',
        new_string: '  constructor(initial: number) {\n    this.value = initial;\n  }',
      });

      // Edit 2: Change deeply nested content
      await editHandler({
        file_path: filePath,
        old_string: "      console.log('nested');",
        new_string: "      console.log('deeply nested');\n      console.log('extra line');",
      });

      const final = readFileSync(filePath, 'utf-8');
      expect(final).toContain('constructor(initial: number)');
      expect(final).toContain('this.value = initial');
      expect(final).toContain("console.log('deeply nested')");
      expect(final).toContain("console.log('extra line')");
    });

    it('handles flexible whitespace matching across sequential edits', async () => {
      const filePath = join(workingDir, 'flex-sequence.ts');
      // File with 4-space indentation
      writeFileSync(
        filePath,
        `function test() {
    const a = 1;
    const b = 2;
    return a + b;
}
`,
        'utf-8'
      );

      // Edit 1: Use 2-space indentation in old_string (should still match via flexible whitespace)
      const edit1 = await editHandler({
        file_path: filePath,
        old_string: 'const a = 1;\n  const b = 2;',
        new_string: 'const a = 10;\n  const b = 20;',
        replace_all: true,
      });
      expect(edit1).toContain('normalized whitespace');

      // Verify indentation was preserved
      const afterEdit1 = readFileSync(filePath, 'utf-8');
      expect(afterEdit1).toContain('    const a = 10;'); // 4-space indent preserved
      expect(afterEdit1).toContain('    const b = 20;'); // 4-space indent preserved

      // Edit 2: Another edit on the modified content
      const edit2 = await editHandler({
        file_path: filePath,
        old_string: '    return a + b;',
        new_string: '    return a * b; // multiplied',
      });
      expect(edit2).toContain('⏺ Update(flex-sequence.ts)');

      const final = readFileSync(filePath, 'utf-8');
      expect(final).toContain('    const a = 10;');
      expect(final).toContain('    const b = 20;');
      expect(final).toContain('    return a * b; // multiplied');
    });

    it('rejects flexible whitespace matching that crosses line boundaries incorrectly', async () => {
      const filePath = join(workingDir, 'cross-line.ts');
      // File has specific structure
      writeFileSync(
        filePath,
        `/**
 * Format any error as a structured error
 */
export function toStructuredError(error: unknown): StructuredError {
  return error;
}
`,
        'utf-8'
      );

      // AI tries to match with wrong line structure (fabricated content)
      const result = await editHandler({
        file_path: filePath,
        old_string: `* Format any error
*/
export class ValidationError`,  // Wrong - tries to match across different lines
        new_string: 'replaced',
      });

      // Should fail - not find a match
      expect(result).toContain('Error: old_string not found');
      // File should be unchanged
      expect(readFileSync(filePath, 'utf-8')).toContain('export function toStructuredError');
    });
  });
});
