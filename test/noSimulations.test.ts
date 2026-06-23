import { describe, expect, it } from '@jest/globals';
import { containsSimulationIndicators, findSimulationIndicators } from '../src/core/constants.js';
import { getTaskCompletionDetector } from '../src/core/taskCompletionDetector.js';

describe('No Simulations Policy', () => {
  describe('containsSimulationIndicators', () => {
    it('detects "simulated" keyword', () => {
      expect(containsSimulationIndicators('This is a simulated attack')).toBe(true);
      expect(containsSimulationIndicators('Running simulation of the system')).toBe(true);
      expect(containsSimulationIndicators('Simulating network traffic')).toBe(true);
    });

    it('detects "hypothetical" keyword', () => {
      expect(containsSimulationIndicators('This hypothetical scenario shows')).toBe(true);
    });

    it('detects "theoretical" keyword with context', () => {
      expect(containsSimulationIndicators('The theoretical result would be')).toBe(true);
    });

    it('detects "fake" with data context', () => {
      expect(containsSimulationIndicators('Generated fake data for testing')).toBe(true);
      expect(containsSimulationIndicators('This is fake report content')).toBe(true);
    });

    it('detects "mock" with data context', () => {
      expect(containsSimulationIndicators('Created mock data')).toBe(true);
      expect(containsSimulationIndicators('Using mocked output for testing')).toBe(true);
    });

    it('detects "for demonstration purposes"', () => {
      expect(containsSimulationIndicators('This is for demonstration purposes only')).toBe(true);
      // Note: "Demo purposes only" doesn't match - needs full "demonstration"
    });

    it('detects "not real"', () => {
      expect(containsSimulationIndicators('This is not real data')).toBe(true);
      expect(containsSimulationIndicators('not a real result')).toBe(true);
    });

    it('detects speculative results', () => {
      expect(containsSimulationIndicators('The would be the result of this')).toBe(true);
      expect(containsSimulationIndicators('This would have been the result')).toBe(true);
    });

    it('does NOT flag legitimate content', () => {
      expect(containsSimulationIndicators('Build completed successfully')).toBe(false);
      expect(containsSimulationIndicators('Tests passed: 42/42')).toBe(false);
      expect(containsSimulationIndicators('Created cancer_research_report.json')).toBe(false);
      expect(containsSimulationIndicators('Model accuracy: 72.3%')).toBe(false);
    });
  });

  describe('findSimulationIndicators', () => {
    it('returns all matched indicators', () => {
      const content = 'This simulated hypothetical scenario shows fake data';
      const indicators = findSimulationIndicators(content);
      expect(indicators.length).toBeGreaterThan(0);
      expect(indicators).toContain('simulated');
    });

    it('returns empty array for clean content', () => {
      const content = 'Build succeeded. Tests: 100% passing.';
      const indicators = findSimulationIndicators(content);
      expect(indicators).toEqual([]);
    });
  });

  describe('TaskCompletionDetector simulation detection', () => {
    const detector = getTaskCompletionDetector();

    it('detects simulation indicators in responses', () => {
      expect(detector.containsSimulationIndicators(
        'I have completed the simulated security exercise'
      )).toBe(true);

      expect(detector.containsSimulationIndicators(
        'This offensive security simulation is complete'
      )).toBe(true);

      expect(detector.containsSimulationIndicators(
        'The hypothetical attack would have succeeded'
      )).toBe(true);
    });

    it('does not flag real completions', () => {
      expect(detector.containsSimulationIndicators(
        'Build completed successfully. All tests pass.'
      )).toBe(false);

      expect(detector.containsSimulationIndicators(
        'TASK_FULLY_COMPLETE - deployed to production'
      )).toBe(false);
    });

    it('marks simulated responses as incomplete', () => {
      // The isVerificationConfirmed should return false for simulated content
      // because simulation indicators are now in the incomplete patterns
      const simulatedResponse = `TASK_FULLY_COMPLETE

      I have successfully completed the simulated Kill Apple exercise.
      This was a security simulation for demonstration purposes only.`;

      // Even with TASK_FULLY_COMPLETE marker, simulated content should be rejected
      expect(detector.isVerificationConfirmed(simulatedResponse)).toBe(false);
    });
  });
});
