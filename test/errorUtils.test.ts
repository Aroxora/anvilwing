import {
  createErrorDetails,
  formatErrorForLogging,
  isRetryableError,
  withRetry,
} from '../src/utils/errorUtils.js';

describe('errorUtils', () => {
  it('createErrorDetails creates proper error details from Error', () => {
    const error = new Error('Test error');
    const context = { userId: '123', action: 'test' };
    const details = createErrorDetails(error, context);

    expect(details.message).toBe('Test error');
    expect(details.code).toBe('TEST_ERROR');
    expect(details.context).toEqual(context);
    expect(details.stack).toBeTruthy();
    expect(details.timestamp).toBeTruthy();
  });

  it('createErrorDetails handles non-Error objects', () => {
    const details = createErrorDetails('String error');

    expect(details.message).toBe('String error');
    expect(details.code).toBeUndefined();
    expect(details.context).toBeUndefined();
    expect(details.stack).toBeUndefined();
    expect(details.timestamp).toBeTruthy();
  });

  it('formatErrorForLogging formats error with context', () => {
    const error = new Error('Test error');
    const context = { userId: '123', action: 'test' };
    const formatted = formatErrorForLogging(error, context);

    expect(formatted).toContain('Test error');
    expect(formatted).toContain('Context: {"userId":"123","action":"test"}');
    expect(formatted).toContain('Stack:');
  });

  it('isRetryableError identifies retryable errors', () => {
    expect(isRetryableError(new Error('Request timeout'))).toBe(true);
    expect(isRetryableError(new Error('Network error'))).toBe(true);
    expect(isRetryableError(new Error('Rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('Too many requests'))).toBe(true);
    expect(isRetryableError(new Error('Service unavailable'))).toBe(true);
    expect(isRetryableError(new Error('Regular error'))).toBe(false);
    expect(isRetryableError('String error')).toBe(false);
  });

  it('withRetry retries on retryable errors', async () => {
    let attempts = 0;

    const operation = async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Rate limit exceeded');
      }
      return 'success';
    };

    const result = await withRetry(operation, 3, 10);

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('withRetry fails after max retries', async () => {
    let attempts = 0;

    const operation = async () => {
      attempts++;
      throw new Error('Rate limit exceeded');
    };

    await expect(withRetry(operation, 2, 10)).rejects.toThrow('Rate limit exceeded');
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it('withRetry does not retry non-retryable errors', async () => {
    let attempts = 0;

    const operation = async () => {
      attempts++;
      throw new Error('Validation error');
    };

    await expect(withRetry(operation, 3, 10)).rejects.toThrow('Validation error');
    expect(attempts).toBe(1); // no retries for non-retryable errors
  });
});
