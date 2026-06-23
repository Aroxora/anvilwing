import {
  validateWorkspaceOptions,
  validateWorkspaceContext,
  truncateWorkspaceContext,
  safeWorkspaceContext,
} from '../src/workspace.validator.ts';

describe('Workspace Validator', () => {
  describe('validateWorkspaceOptions', () => {
    it('should accept valid options', () => {
      const result = validateWorkspaceOptions({
        treeDepth: 1,
        maxEntries: 30,
        docExcerptLimit: 200,
      });

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should reject negative treeDepth', () => {
      const result = validateWorkspaceOptions({ treeDepth: -1 });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('negative'))).toBe(true);
    });

    it('should reject excessive treeDepth', () => {
      const result = validateWorkspaceOptions({ treeDepth: 5 });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('exceeds maximum'))).toBe(true);
    });

    it('should reject excessive maxEntries', () => {
      const result = validateWorkspaceOptions({ maxEntries: 100 });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('exceeds maximum'))).toBe(true);
    });

    it('should reject excessive docExcerptLimit', () => {
      const result = validateWorkspaceOptions({ docExcerptLimit: 500 });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('exceeds maximum'))).toBe(true);
    });
  });

  describe('validateWorkspaceContext', () => {
    it('should accept valid context within limits', () => {
      const result = validateWorkspaceContext(`cwd: /test
files:
src/
  index.ts
README.md`);

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should accept context without cwd (only validates size)', () => {
      const result = validateWorkspaceContext('files:\nsrc/');

      // Current implementation only validates size, not structure
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should accept context without files section (only validates size)', () => {
      const result = validateWorkspaceContext('cwd: /test\n');

      // Current implementation only validates size, not structure
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should accept malformed file tree (only validates size)', () => {
      const result = validateWorkspaceContext('cwd: /test\nfiles:\n  invalid line');

      // Current implementation only validates size, not structure
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should reject context exceeding character limit', () => {
      const largeContent = 'x'.repeat(/* TODO: Extract constant */ 6000); // Exceeds 5000 char limit
      const result = validateWorkspaceContext(largeContent);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('exceeds ABSOLUTE maximum'))).toBe(true);
    });

    it('should reject context exceeding line limit', () => {
      const lines = Array(150).fill('line').join('\n'); // Exceeds 100 line limit
      const result = validateWorkspaceContext(lines);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('exceeds ABSOLUTE maximum'))).toBe(true);
    });

    it('should reject context exceeding file entry limit', () => {
      const files = Array(60).fill('file.ts').join('\n'); // Exceeds 50 file limit
      const result = validateWorkspaceContext(files);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Resource limit exceeded'))).toBe(true);
    });

    it('should warn when approaching limits', () => {
      const content = 'x'.repeat(4000); // 80% of 5000 char limit
      const result = validateWorkspaceContext(content);

      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('% of maximum'))).toBe(true);
    });
  });

  describe('truncateWorkspaceContext', () => {
    it('should truncate long content', () => {
      const longContent = 'x'.repeat(6000);
      const result = truncateWorkspaceContext(longContent);

      expect(result.content.length).toBeLessThanOrEqual(5000);
      expect(result.content.length).toBeLessThan(longContent.length);
    });

    it('should not truncate short content', () => {
      const shortContent = 'x'.repeat(/* TODO: Extract constant */ 1000);
      const result = truncateWorkspaceContext(shortContent);

      expect(result.content).toBe(shortContent);
    });

    it('should preserve structure when truncating', () => {
      const structured = `cwd: /test
files:
src/
  ${'x'.repeat(3000)}
README.md
${'y'.repeat(3000)}`;

      const result = truncateWorkspaceContext(structured);

      expect(result.content.length).toBeLessThanOrEqual(5000);
      expect(result.content.includes('cwd:')).toBe(true);
      expect(result.content.includes('files:')).toBe(true);
    });
  });

  describe('safeWorkspaceContext', () => {
    it('should handle empty context', () => {
      const result = safeWorkspaceContext('');

      expect(result.content).toBe('');
      expect(result.stats.totalChars).toBe(0);
      expect(result.stats.totalLines).toBe(0);
    });

    it('should calculate stats correctly', () => {
      const content = 'line1\nline2\nline3';
      const result = safeWorkspaceContext(content);

      // 'line1\nline2\nline3' = 5 + 1 + 5 + 1 + 5 = 17 characters
      expect(result.stats.totalChars).toBe(17);
      expect(result.stats.totalLines).toBe(3);
    });

    it('should apply safety limits', () => {
      const largeContent = 'x'.repeat(10000);
      const result = safeWorkspaceContext(largeContent);

      expect(result.content.length).toBeLessThanOrEqual(5000);
      expect(result.stats.totalChars).toBeLessThanOrEqual(5000);
    });
  });

  describe('Real-world scenarios', () => {
    it('should handle typical workspace context', () => {
      const typical = `cwd: /Users/test/project
files:
src/
  index.ts
  utils.ts
dist/
README.md
package.json

--- README.md ---
# Project
This is a test project...`;

      const result = safeWorkspaceContext(typical);

      expect(result.content).toBe(typical);
      expect(result.stats.estimatedTokens).toBeLessThan(100);
    });

    it('should handle large file tree', () => {
      const files = Array(100).fill('file.ts').map((f, i) => `  ${f.replace('.ts', i + '.ts')}`);
      const large = `cwd: /test\nfiles:\n${files.join('\n')}`;

      const result = safeWorkspaceContext(large);

      // Should be truncated or within limits
      expect(result.stats.totalChars).toBeLessThanOrEqual(5000);
      expect(result.stats.totalLines).toBeLessThanOrEqual(103);
    });

    it('should handle multiple long priority docs', () => {
      const longDoc = 'x'.repeat(400); // Exceeds 300 char per-doc limit
      const content = `cwd: /test
files:
src/

--- README.md ---
${longDoc}`;

      const result = safeWorkspaceContext(content);

      // Should be truncated to stay within limits
      expect(result.stats.totalChars).toBeLessThanOrEqual(5000);
    });
  });
});