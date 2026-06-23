import {
  DangerousOperationError,
  BlockedOperationError,
  ContextOverflowError,
  ValidationError,
  ResourceLimitError,
  toStructuredError,
  ErrorSeverity,
  ErrorCategory,
} from '../src/core/errors/errorTypes.ts';

describe('Structured Error System', () => {
  describe('DangerousOperationError', () => {
    it('should create error with suggestions', () => {
      const error = new DangerousOperationError(
        'rm -rf /',
        'Deletes entire filesystem',
        'rm -rf ./directory'
      );

      expect(error.severity).toBe(ErrorSeverity.CRITICAL);
      expect(error.category).toBe(ErrorCategory.DANGEROUS);
      expect(error.message.includes('Dangerous operation blocked')).toBe(true);
      expect(error.suggestions.length).toBeGreaterThan(0);
      expect(error.recoverable).toBe(true);
    });

    it('should indicate non-recoverable if no alternative', () => {
      const error = new DangerousOperationError(
        ':(){ :|:& };:',
        'Fork bomb'
      );

      expect(error.recoverable).toBe(false);
      expect(error.suggestions.length).toBeGreaterThan(0);
      const first = error.suggestions[0]!;
      expect(first.autoFixable).toBe(false);
    });

    it('should format display string with suggestions', () => {
      const error = new DangerousOperationError(
        'rm -rf /',
        'Destroys root',
        'rm -rf ./folder'
      );

      const display = error.toDisplayString();
      expect(display.includes('Dangerous operation blocked')).toBe(true);
      expect(display.includes('rm -rf ./folder')).toBe(true);
    });

    it('should include operation in originalInput', () => {
      const error = new DangerousOperationError(
        'chmod 777 /etc/passwd',
        'Modifies system file permissions'
      );

      expect(error.originalInput).toBe('chmod 777 /etc/passwd');
    });
  });

  describe('BlockedOperationError', () => {
    it('should create error with policy reference', () => {
      const error = new BlockedOperationError(
        'git push --force origin main',
        'force-push-policy',
        'Use git push --force-with-lease instead'
      );

      expect(error.severity).toBe(ErrorSeverity.ERROR);
      expect(error.category).toBe(ErrorCategory.BLOCKED);
      expect(error.message.includes('Operation blocked')).toBe(true);
      expect(error.message.includes('force-push-policy')).toBe(true);
      expect(error.recoverable).toBe(true);
    });

    it('should include operation in originalInput', () => {
      const error = new BlockedOperationError(
        'curl http://malicious.com',
        'external-network-policy'
      );

      expect(error.originalInput).toBe('curl http://malicious.com');
    });
  });

  describe('ContextOverflowError', () => {
    it('should create error with context metrics', () => {
      const error = new ContextOverflowError(15000, 10000);

      expect(error.severity).toBe(ErrorSeverity.CRITICAL);
      expect(error.category).toBe(ErrorCategory.CONTEXT_OVERFLOW);
      expect(error.message.includes('Context overflow')).toBe(true);
      expect(error.message.includes('15000')).toBe(true);
      expect(error.message.includes('10000')).toBe(true);
    });

    it('should include actual and limit in message', () => {
      const error = new ContextOverflowError(12000, 8000);

      expect(error.message.includes('12000')).toBe(true);
      expect(error.message.includes('8000')).toBe(true);
    });
  });

  describe('ValidationError', () => {
    it('should create error with field details', () => {
      const error = new ValidationError(
        'email',
        'invalid-format',
        'Email must be valid format'
      );

      expect(error.severity).toBe(ErrorSeverity.ERROR);
      expect(error.category).toBe(ErrorCategory.VALIDATION);
      expect(error.message.includes('Validation failed')).toBe(true);
      expect(error.message.includes('email')).toBe(true);
    });

    it('should include value in originalInput', () => {
      const error = new ValidationError(
        'password',
        'too-short',
        'Password must be at least 8 characters'
      );

      expect(error.originalInput).toBe('too-short');
    });
  });

  describe('ResourceLimitError', () => {
    it('should create error with resource details', () => {
      const error = new ResourceLimitError('files', 150, 100);

      expect(error.severity).toBe(ErrorSeverity.ERROR);
      expect(error.category).toBe(ErrorCategory.RESOURCE);
      expect(error.message.includes('Resource limit exceeded')).toBe(true);
      expect(error.message.includes('files')).toBe(true);
      expect(error.message.includes('150')).toBe(true);
      expect(error.message.includes('100')).toBe(true);
    });

    it('should include resource details in message', () => {
      const error = new ResourceLimitError('memory', 800, 500);

      expect(error.message.includes('memory')).toBe(true);
      expect(error.message.includes('800')).toBe(true);
      expect(error.message.includes('500')).toBe(true);
    });
  });

  describe('toStructuredError', () => {
    it('should wrap regular errors', () => {
      const original = new Error('Something went wrong');
      const structured = toStructuredError(original);

      expect(structured.severity).toBe(ErrorSeverity.ERROR);
      expect(structured.category).toBe(ErrorCategory.UNKNOWN);
      expect(structured.message.includes('Something went wrong')).toBe(true);
    });

    it('should preserve structured errors', () => {
      const original = new DangerousOperationError('rm -rf /', 'Bad');
      const structured = toStructuredError(original);

      expect(structured.severity).toBe(ErrorSeverity.CRITICAL);
      expect(structured.category).toBe(ErrorCategory.DANGEROUS);
    });

    it('should detect blocked errors from message', () => {
      const error = new Error('Operation blocked by policy');
      const structured = toStructuredError(error);

      expect(structured.category).toBe(ErrorCategory.BLOCKED);
    });

    it('should detect context overflow from message', () => {
      const error = new Error('Context overflow: 10000 tokens');
      const structured = toStructuredError(error);

      expect(structured.category).toBe(ErrorCategory.CONTEXT_OVERFLOW);
      expect(structured.severity).toBe(ErrorSeverity.CRITICAL);
    });

    it('should default to unknown category', () => {
      const error = new Error('Something weird happened');
      const structured = toStructuredError(error);

      expect(structured.category).toBe(ErrorCategory.UNKNOWN);
    });
  });

  describe('Error serialization', () => {
    it('should convert to JSON', () => {
      const error = new DangerousOperationError('rm -rf /', 'Bad', 'rm -rf ./');
      const json = error.toJSON() as Record<string, unknown>;

      expect(json['name']).toBeDefined();
      expect(json['severity']).toBe(ErrorSeverity.CRITICAL);
      expect(json['category']).toBe(ErrorCategory.DANGEROUS);
      expect(json['message']).toBeDefined();
      expect(Array.isArray(json['suggestions'])).toBe(true);
      expect(json['timestamp']).toBeDefined();
    });

    it('should include originalInput in JSON when available', () => {
      const error = new DangerousOperationError('rm -rf /', 'Bad');
      const json = error.toJSON() as Record<string, unknown>;

      expect(json['originalInput']).toBe('rm -rf /');
    });
  });
});