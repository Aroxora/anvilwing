import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  TaskCompletionDetector,
  getTaskCompletionDetector,
  resetTaskCompletionDetector,
} from '../src/core/taskCompletionDetector.js';
import { TASK_FULLY_COMPLETE } from '../src/core/constants.js';

describe('TaskCompletionDetector', () => {
  let detector: TaskCompletionDetector;

  beforeEach(() => {
    detector = new TaskCompletionDetector();
  });

  describe('analyzeCompletion', () => {
    it('should detect high confidence completion', () => {
      const response = 'All tasks are now complete. Everything has been implemented and tested.';
      const analysis = detector.analyzeCompletion(response, []);

      assert.ok(analysis.confidence >= 0.7);
      assert.ok(analysis.signals.hasExplicitCompletionStatement);
    });

    it('should detect incomplete work indicators', () => {
      const response = 'Let me continue working on the next step. I will implement the feature now.';
      const analysis = detector.analyzeCompletion(response, []);

      assert.ok(analysis.signals.hasIncompleteWorkIndicators);
      assert.strictEqual(analysis.isComplete, false);
    });

    it('should lower confidence when errors are mentioned', () => {
      const response = 'The task is complete but there are some errors that need fixing.';
      const analysis = detector.analyzeCompletion(response, []);

      assert.ok(analysis.signals.hasErrorIndicators);
      assert.ok(analysis.confidence < 0.8);
    });
  });

  describe('isVerificationConfirmed', () => {
    it('should confirm when TASK_FULLY_COMPLETE is present', () => {
      const response = TASK_FULLY_COMPLETE;
      assert.strictEqual(detector.isVerificationConfirmed(response), true);
    });

    it('should confirm when response starts with "yes"', () => {
      const response = 'Yes, all tasks are complete.';
      assert.strictEqual(detector.isVerificationConfirmed(response), true);
    });

    it('should confirm when response starts with "all done"', () => {
      const response = 'All done! Everything is working.';
      assert.strictEqual(detector.isVerificationConfirmed(response), true);
    });

    it('should NOT confirm when response has TASK_FULLY_COMPLETE but indicates incomplete work', () => {
      // This is the critical test for the bug fix
      const response = `TASK_FULLY_COMPLETE for the encryption infrastructure implementation.

IMPORTANT: The current deployment still stores data unencrypted because the credential
encryption service hasn't been integrated into the main workspace component yet.`;

      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm when response says complete but work is "not yet integrated"', () => {
      const response = `Everything is complete. TASK_FULLY_COMPLETE

However, the feature is not yet integrated into the main application.`;

      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm when response says "ready for integration"', () => {
      const response = `TASK_FULLY_COMPLETE - the module is ready for integration into the main app.`;

      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm when response says "still stores/uses"', () => {
      const response = `TASK_FULLY_COMPLETE. Note: The system still stores data in the old format.`;

      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm when response says "needs to be integrated"', () => {
      const response = `TASK_FULLY_COMPLETE. The service is built but needs to be integrated into the UI.`;

      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm when "however" introduces incomplete work', () => {
      const response = `TASK_FULLY_COMPLETE. However, it hasn't been tested in production yet.`;

      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should confirm genuine completion without contradictions', () => {
      const response = `TASK_FULLY_COMPLETE

All requested features have been implemented:
- User authentication added
- Database migrations run
- Tests passing
- Deployed to production

Everything is working correctly.`;

      assert.strictEqual(detector.isVerificationConfirmed(response), true);
    });

    // === UNCONVENTIONAL EDGE CASES ===

    it('should NOT confirm with passive voice evasion: "was not performed"', () => {
      const response = `TASK_FULLY_COMPLETE. The integration was not performed due to time constraints.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with euphemisms: "deferred"', () => {
      const response = `TASK_FULLY_COMPLETE. Error handling was deferred to a future sprint.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with euphemisms: "left as an exercise"', () => {
      const response = `TASK_FULLY_COMPLETE. Advanced configuration left as an exercise for the reader.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with euphemisms: "out of scope"', () => {
      const response = `TASK_FULLY_COMPLETE. Testing was out of scope for this task.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with partial completion: "partially complete"', () => {
      const response = `TASK_FULLY_COMPLETE. The feature is partially complete.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with partial completion: "mostly done"', () => {
      const response = `TASK_FULLY_COMPLETE. Everything is mostly done, just a few edge cases left.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with partial completion: "almost working"', () => {
      const response = `TASK_FULLY_COMPLETE. The system is almost working correctly now.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with qualifier words: "should be complete"', () => {
      const response = `TASK_FULLY_COMPLETE. Everything should be complete now.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with qualifier words: "theoretically working"', () => {
      const response = `TASK_FULLY_COMPLETE. The feature is theoretically working.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with self-contradiction: "done but"', () => {
      const response = `TASK_FULLY_COMPLETE. The implementation is done but needs more testing.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with self-contradiction: "complete except"', () => {
      const response = `TASK_FULLY_COMPLETE. Everything is complete except for the UI styling.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with remaining work: "remaining tasks"', () => {
      const response = `TASK_FULLY_COMPLETE. There are some remaining tasks for polish.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with remaining work: "outstanding issues"', () => {
      const response = `TASK_FULLY_COMPLETE. A few outstanding issues need attention.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with error state: "tests failing"', () => {
      const response = `TASK_FULLY_COMPLETE. Note: 3 tests are still failing.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with error state: "doesn\'t work"', () => {
      const response = `TASK_FULLY_COMPLETE. The login feature doesn't work yet.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with error state: "broken tests"', () => {
      const response = `TASK_FULLY_COMPLETE. There are some broken tests to fix.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with manual steps: "you\'ll need to"', () => {
      const response = `TASK_FULLY_COMPLETE. You'll need to run the migration manually.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with manual steps: "manually configure"', () => {
      const response = `TASK_FULLY_COMPLETE. Remember to manually configure the API keys.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with TODO in prose: "TODO:"', () => {
      const response = `TASK_FULLY_COMPLETE. TODO: Add error handling for edge cases.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with scope limitation: "didn\'t have time"', () => {
      const response = `TASK_FULLY_COMPLETE. I didn't have time to add unit tests.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with future work needed: "will need to integrate"', () => {
      const response = `TASK_FULLY_COMPLETE. You will need to integrate this with the main app.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with blocker: "blocked by"', () => {
      const response = `TASK_FULLY_COMPLETE. Final deployment is blocked by API credentials.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with time-dependent: "after restart"', () => {
      const response = `TASK_FULLY_COMPLETE. Changes take effect after restart.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with "but not" pattern', () => {
      const response = `TASK_FULLY_COMPLETE. The API is ready but not all endpoints are tested.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with "need to add"', () => {
      const response = `TASK_FULLY_COMPLETE. We still need to add validation logic.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with "should implement"', () => {
      const response = `TASK_FULLY_COMPLETE. We should implement caching for performance.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with "assuming everything works"', () => {
      const response = `TASK_FULLY_COMPLETE, assuming everything works correctly in production.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with "part of the task"', () => {
      const response = `TASK_FULLY_COMPLETE. Only part of the task was implemented.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with "errors to fix"', () => {
      const response = `TASK_FULLY_COMPLETE. There are a few errors to fix in the UI.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });

    it('should NOT confirm with "for now... without"', () => {
      const response = `TASK_FULLY_COMPLETE. For now, the system runs without validation.`;
      assert.strictEqual(detector.isVerificationConfirmed(response), false);
    });
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = getTaskCompletionDetector();
      const instance2 = getTaskCompletionDetector();
      assert.strictEqual(instance1, instance2);
    });

    it('should reset properly', () => {
      const instance = getTaskCompletionDetector();
      instance.recordToolCall('bash', true, true);
      resetTaskCompletionDetector();
      // After reset, internal state should be cleared
      // (We can't directly check private state, but this ensures no errors)
      const analysis = instance.analyzeCompletion('test', []);
      assert.ok(analysis);
    });
  });
});
