import { ensureNextSteps } from '../src/core/finalResponseFormatter.ts';

describe('ensureNextSteps', () => {
  it('returns original content when Next steps already present', () => {
    const input = 'Work done.\n\nNext steps:\n- Ship it';
    const { output, appended } = ensureNextSteps(input);

    expect(output).toBe(input);
    expect(appended).toBeNull();
  });

  it('returns content as-is when no Next steps present (no auto-append)', () => {
    const input = 'Implemented the feature.';
    const { output, appended } = ensureNextSteps(input);

    expect(output).toBe(input);
    expect(appended).toBeNull();
  });

  it('handles empty content gracefully', () => {
    const { output, appended } = ensureNextSteps('');
    expect(output).toBe('');
    expect(appended).toBeNull();
  });
});
