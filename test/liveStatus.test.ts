import { LiveStatusTracker, type LiveStatusState } from '../src/shell/liveStatus';

describe('LiveStatusTracker timing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('preserves startedAt when the base status text stays the same', () => {
    const tracker = new LiveStatusTracker();

    tracker.setBase('Ready for prompts');

    let current: LiveStatusState | null = null;
    const unsubscribe = tracker.subscribe((state) => {
      current = state;
    });

    const firstStartedAt = current?.startedAt;

    // Move time forward and update the base status with the same text but new detail
    jest.advanceTimersByTime(1500);
    tracker.setBase('Ready for prompts', { detail: 'details change without resetting timer' });

    expect(current?.startedAt).toBe(firstStartedAt);

    unsubscribe();
  });

  it('preserves startedAt when updating an existing override with the same text', () => {
    const tracker = new LiveStatusTracker();
    let current: LiveStatusState | null = null;

    tracker.subscribe((state) => {
      current = state;
    });

    tracker.pushOverride('streaming', 'Processing');
    const firstStartedAt = current?.startedAt;

    jest.advanceTimersByTime(1200);
    tracker.pushOverride('streaming', 'Processing', { detail: 'still running' });

    expect(current?.startedAt).toBe(firstStartedAt);
  });
});
