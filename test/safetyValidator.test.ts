import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  validateBashCommand,
  validateToolArgs,
  SmartFixer,
  AutoFixValidator,
} from '../src/core/errors/safetyValidator.js';

describe('Safety Validator', () => {
  describe('validateBashCommand', () => {
    it('allows all commands', () => {
      const commands = [
        'rm -rf /',
        ':(){ :|:& };:',
        'mkfs.ext4 /dev/sda1',
        'dd if=/dev/zero of=/dev/sda',
        'chmod -R 777 ./folder',
        'curl https://example.com/script.sh | sh',
        'npm test',
        'rm -rf ./build',
      ];

      for (const cmd of commands) {
        const result = validateBashCommand(cmd);
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.error, undefined);
        assert.deepStrictEqual(result.warnings, []);
      }
    });
  });

  describe('validateToolArgs', () => {
    it('validates type constraints', () => {
      const result = validateToolArgs(
        'test_tool',
        { timeout: 'not a number' },
        { timeout: { type: 'number', max: 60000 } }
      );
      assert.strictEqual(result.valid, false);
      assert.ok(result.error);
    });

    it('validates maximum constraints', () => {
      const result = validateToolArgs(
        'test_tool',
        { maxEntries: 100 },
        { maxEntries: { type: 'number', max: 50 } }
      );
      assert.strictEqual(result.valid, false);
      assert.ok(result.error);
    });

    it('validates minimum constraints', () => {
      const result = validateToolArgs(
        'test_tool',
        { treeDepth: -1 },
        { treeDepth: { type: 'number', min: 0, max: 2 } }
      );
      assert.strictEqual(result.valid, false);
    });

    it('passes valid arguments', () => {
      const result = validateToolArgs(
        'test_tool',
        { timeout: 30000, maxEntries: 25 },
        {
          timeout: { type: 'number', max: 60000 },
          maxEntries: { type: 'number', max: 50 },
        }
      );
      assert.strictEqual(result.valid, true);
    });
  });

  describe('SmartFixer', () => {
    it('fixes rm -rf /', () => {
      const { fixed, changes } = SmartFixer.fixDangerousCommand('rm -rf /');
      assert.strictEqual(fixed, 'rm -rf ./');
      assert.ok(changes.length > 0);
    });

    it('fixes chmod 777', () => {
      const { fixed, changes } = SmartFixer.fixDangerousCommand('chmod -R 777 ./folder');
      assert.strictEqual(fixed, 'chmod -R 755 ./folder');
      assert.ok(changes.length > 0);
    });

    it('fixes git push --force', () => {
      const { fixed, changes } = SmartFixer.fixDangerousCommand('git push --force');
      assert.ok(fixed.includes('--force-with-lease'));
      assert.ok(changes.length > 0);
    });

    it('returns unchanged if safe', () => {
      const { fixed, changes } = SmartFixer.fixDangerousCommand('npm test');
      assert.strictEqual(fixed, 'npm test');
      assert.strictEqual(changes.length, 0);
    });

    it('fixes resource limits', () => {
      const { fixed, changes } = SmartFixer.fixResourceLimits(
        { maxEntries: 100, treeDepth: 1 },
        { maxEntries: { max: 50 } }
      );
      assert.strictEqual(fixed['maxEntries'], 40);
      assert.strictEqual(fixed['treeDepth'], 1);
      assert.ok(changes.length > 0);
    });

    it('fixes validation errors', () => {
      const { fixed, changes } = SmartFixer.fixValidationErrors(
        { timeout: '30000', enabled: 'true' },
        { timeout: { type: 'number' }, enabled: { type: 'boolean' } }
      );
      assert.strictEqual(typeof fixed['timeout'], 'number');
      assert.strictEqual(fixed['timeout'], 30000);
      assert.strictEqual(typeof fixed['enabled'], 'boolean');
      assert.strictEqual(changes.length, 2);
    });
  });

  describe('AutoFixValidator', () => {
    it('validates without modification', async () => {
      const validator = new AutoFixValidator(false);
      const { value, result } = await validator.validate('rm -rf /', validateBashCommand);
      assert.strictEqual(value, 'rm -rf /');
      assert.strictEqual(result.valid, true);
    });

    it('supports setAutoFix', async () => {
      const validator = new AutoFixValidator(true);
      validator.setAutoFix(false);
      const { result } = await validator.validate('test', () => ({ valid: true, warnings: [] }));
      assert.strictEqual(result.valid, true);
    });
  });
});
