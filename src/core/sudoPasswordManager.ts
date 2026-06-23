/**
 * Sudo Password Manager - handles sudo password caching and prompting
 *
 * This module provides a singleton manager for sudo passwords, allowing
 * bash commands to run with sudo privileges by prompting the user for
 * their password when needed.
 */

import { EventEmitter } from 'node:events';

interface SudoPasswordRequest {
  resolve: (password: string | null) => void;
  reject: (error: Error) => void;
}

class SudoPasswordManager extends EventEmitter {
  private cachedPassword: string | null = null;
  private passwordValidUntil: number = 0;
  private readonly CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes (matches typical sudo timeout)
  private pendingRequest: SudoPasswordRequest | null = null;

  /**
   * Get the cached sudo password if still valid
   */
  getCachedPassword(): string | null {
    if (this.cachedPassword && Date.now() < this.passwordValidUntil) {
      return this.cachedPassword;
    }
    return null;
  }

  /**
   * Cache a sudo password
   */
  cachePassword(password: string): void {
    this.cachedPassword = password;
    this.passwordValidUntil = Date.now() + this.CACHE_DURATION_MS;
  }

  /**
   * Invalidate the cached password (e.g., if sudo fails)
   */
  invalidatePassword(): void {
    this.cachedPassword = null;
    this.passwordValidUntil = 0;
  }

  /**
   * Request a sudo password - emits 'password-needed' event
   * Returns the password or null if cancelled
   */
  async requestPassword(): Promise<string | null> {
    // Check cache first
    const cached = this.getCachedPassword();
    if (cached) {
      return cached;
    }

    // If there's already a pending request, wait for it
    if (this.pendingRequest) {
      return new Promise((resolve, reject) => {
        // Subscribe to the same request
        const originalResolve = this.pendingRequest!.resolve;
        this.pendingRequest!.resolve = (password) => {
          originalResolve(password);
          resolve(password);
        };
      });
    }

    // Create new request
    return new Promise<string | null>((resolve, reject) => {
      this.pendingRequest = { resolve, reject };
      this.emit('password-needed');
    });
  }

  /**
   * Provide the password in response to a 'password-needed' event
   */
  providePassword(password: string | null): void {
    if (this.pendingRequest) {
      const request = this.pendingRequest;
      this.pendingRequest = null;

      if (password) {
        this.cachePassword(password);
      }
      request.resolve(password);
    }
  }

  /**
   * Cancel the pending password request
   */
  cancelRequest(): void {
    if (this.pendingRequest) {
      const request = this.pendingRequest;
      this.pendingRequest = null;
      request.resolve(null);
    }
  }

  /**
   * Check if there's a pending password request
   */
  hasPendingRequest(): boolean {
    return this.pendingRequest !== null;
  }
}

// Singleton instance
export const sudoPasswordManager = new SudoPasswordManager();

// Convenience exports
export function getSudoPassword(): Promise<string | null> {
  return sudoPasswordManager.requestPassword();
}

export function setCachedSudoPassword(password: string): void {
  sudoPasswordManager.cachePassword(password);
}

export function invalidateSudoPassword(): void {
  sudoPasswordManager.invalidatePassword();
}

export function onSudoPasswordNeeded(callback: () => void): void {
  sudoPasswordManager.on('password-needed', callback);
}

export function offSudoPasswordNeeded(callback: () => void): void {
  sudoPasswordManager.off('password-needed', callback);
}

export function provideSudoPassword(password: string | null): void {
  sudoPasswordManager.providePassword(password);
}
