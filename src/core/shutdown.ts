/**
 * Centralized shutdown and signal handling for the CLI.
 * Ensures Ctrl+C always works and process exits cleanly.
 */

import { stdin, stdout } from 'node:process';
import { reportStatusError } from '../utils/statusReporter.js';

// Track shutdown state
let isShuttingDown = false;
let shutdownReason: string | undefined;
let signalHandlersInstalled = false;
let cleanupCallbacks: Array<() => void | Promise<void>> = [];
let forceExitTimeout: NodeJS.Timeout | null = null;

// Ctrl+C counter for double-press detection at process level
let processCtrlCCount = 0;
let lastProcessCtrlCTime = 0;

/**
 * Register a cleanup callback to run on shutdown
 */
export function onShutdown(callback: () => void | Promise<void>): () => void {
  cleanupCallbacks.push(callback);
  // Return unregister function
  return () => {
    const index = cleanupCallbacks.indexOf(callback);
    if (index !== -1) {
      cleanupCallbacks.splice(index, 1);
    }
  };
}

/**
 * Run all cleanup callbacks
 */
async function runCleanup(): Promise<void> {
  const callbacks = [...cleanupCallbacks];
  cleanupCallbacks = [];

  for (const callback of callbacks) {
    try {
      await callback();
    } catch {
      // Ignore cleanup errors during shutdown
    }
  }
}

/**
 * Initiate authorized shutdown with cleanup
 */
export async function authorizedShutdown(codeOrReason?: number | string): Promise<never> {
  const exitCode = typeof codeOrReason === 'number' ? codeOrReason : 0;
  const reason = typeof codeOrReason === 'string' ? codeOrReason : `exit(${exitCode})`;

  if (isShuttingDown) {
    // Already shutting down - force exit if called again
    process.exit(exitCode);
  }

  isShuttingDown = true;
  shutdownReason = reason;

  // Set a force exit timeout in case cleanup hangs
  forceExitTimeout = setTimeout(() => {
    process.exit(exitCode);
  }, 3000);

  try {
    // Restore terminal state
    if (stdin.isTTY && stdin.setRawMode) {
      try {
        stdin.setRawMode(false);
      } catch {
        // Ignore - may not be in raw mode
      }
    }

    // Run cleanup callbacks
    await runCleanup();

    // Clear the force exit timeout since we completed normally
    if (forceExitTimeout) {
      clearTimeout(forceExitTimeout);
    }
  } catch {
    // Ignore cleanup errors
  }

  process.exit(exitCode);
}

/**
 * Check if shutdown is in progress
 */
export function isShutdownInProgress(): boolean {
  return isShuttingDown;
}

/**
 * Get the shutdown reason if shutting down
 */
export function getShutdownReason(): string | undefined {
  return shutdownReason;
}

/**
 * Handle SIGINT at process level - this is the fallback when input interception fails
 */
function handleSIGINT(): void {
  const now = Date.now();

  // Reset count if more than 2 seconds since last
  if (now - lastProcessCtrlCTime > 2000) {
    processCtrlCCount = 0;
  }

  lastProcessCtrlCTime = now;
  processCtrlCCount++;

  if (processCtrlCCount >= 2) {
    // Double Ctrl+C - force exit
    stdout.write('\n');
    void authorizedShutdown(130); // Standard SIGINT exit code
  } else {
    // Single Ctrl+C - show hint
    stdout.write('\n');
    stdout.write('\x1b[2m(Press Ctrl+C again to exit)\x1b[0m\n');
  }
}

/**
 * Handle SIGTERM - graceful shutdown request
 */
function handleSIGTERM(): void {
  void authorizedShutdown('SIGTERM');
}

/**
 * Install process-level signal handlers as fallback
 * This ensures Ctrl+C always works even if input handling fails
 */
export function installSignalHandlers(): void {
  if (signalHandlersInstalled) {
    return;
  }

  signalHandlersInstalled = true;

  // SIGINT (Ctrl+C) - with double-press detection
  process.on('SIGINT', handleSIGINT);

  // SIGTERM - graceful shutdown
  process.on('SIGTERM', handleSIGTERM);

  // Handle uncaught errors during shutdown
  process.on('uncaughtException', (error) => {
    if (!isShuttingDown) {
      reportStatusError(error, 'Uncaught exception');
      void authorizedShutdown(1);
    }
  });

  // Handle unhandled promise rejections during shutdown
  process.on('unhandledRejection', (reason) => {
    if (!isShuttingDown) {
      reportStatusError(reason, 'Unhandled rejection');
      void authorizedShutdown(1);
    }
  });

  // Ensure terminal is restored on exit. The cleanup-callback chain handles
  // most paths, but `process.exit(N)` from any internal error and a few
  // SIGKILL-adjacent flows skip async cleanup; this synchronous handler
  // emits the minimum escape sequences directly so the user's shell isn't
  // left in bracketed-paste mode with the cursor hidden.
  process.on('exit', () => {
    if (stdin.isTTY && stdin.setRawMode) {
      try {
        stdin.setRawMode(false);
      } catch {
        // Ignore
      }
    }
    try {
      // Show cursor + disable bracketed paste — the two global terminal
      // states the renderer toggles on startup. Idempotent: a terminal
      // that wasn't in those modes silently ignores the sequences.
      stdout.write('\x1b[?25h\x1b[?2004l');
    } catch {
      // Ignore
    }
  });
}

/**
 * Reset Ctrl+C counter (call when input is processed to prevent double-counting)
 */
export function resetCtrlCCounter(): void {
  processCtrlCCount = 0;
}

/**
 * Get current Ctrl+C count (for coordination with input handlers)
 */
export function getCtrlCCount(): number {
  return processCtrlCCount;
}
