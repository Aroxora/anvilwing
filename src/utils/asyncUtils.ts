/**
 * Async Utilities Module
 *
 * Production-ready async patterns for rate limiting, throttling,
 * concurrency control, and caching with TTL.
 *
 * Principal Investigator: Bo Shang
 * Framework: agi-cli
 */

// ============================================================================
// Types
// ============================================================================

export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

export interface ThrottleConfig {
  intervalMs: number;
  leading?: boolean;
  trailing?: boolean;
}

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheConfig {
  ttlMs: number;
  maxSize?: number;
}

export interface ConcurrencyConfig {
  maxConcurrent: number;
  timeout?: number;
}

// ============================================================================
// Rate Limiter (Token Bucket)
// ============================================================================

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;

  constructor(config: RateLimiterConfig) {
    this.maxTokens = config.maxRequests;
    this.tokens = config.maxRequests;
    this.refillRate = config.maxRequests / config.windowMs;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Wait for a token to become available
    const waitTime = (1 - this.tokens) / this.refillRate;
    await sleep(waitTime);
    this.refill();
    this.tokens -= 1;
  }

  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  get availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

// ============================================================================
// Throttle & Debounce
// ============================================================================

export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  config: ThrottleConfig
): (...args: Parameters<T>) => ReturnType<T> | undefined {
  let lastCall = 0;
  let lastResult: ReturnType<T> | undefined;
  let pendingCall: NodeJS.Timeout | null = null;
  let pendingArgs: Parameters<T> | null = null;

  const { intervalMs, leading = true, trailing = true } = config;

  return function throttled(...args: Parameters<T>): ReturnType<T> | undefined {
    const now = Date.now();
    const elapsed = now - lastCall;

    if (elapsed >= intervalMs) {
      // Enough time has passed
      if (leading || lastCall !== 0) {
        lastCall = now;
        lastResult = fn(...args) as ReturnType<T>;
        return lastResult;
      }
    }

    // Store args for potential trailing call
    if (trailing) {
      pendingArgs = args;

      if (!pendingCall) {
        pendingCall = setTimeout(() => {
          if (pendingArgs) {
            lastCall = Date.now();
            lastResult = fn(...pendingArgs) as ReturnType<T>;
            pendingArgs = null;
          }
          pendingCall = null;
        }, intervalMs - elapsed);
      }
    }

    return lastResult;
  };
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delayMs: number
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | null = null;

  return function debounced(...args: Parameters<T>): void {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delayMs);
  };
}

// ============================================================================
// TTL Cache
// ============================================================================

export class TTLCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(config: CacheConfig) {
    this.ttlMs = config.ttlMs;
    this.maxSize = config.maxSize ?? Infinity;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.ttlMs),
    });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    this.prune();
    return this.cache.size;
  }

  private prune(): void {
    const now = Date.now();
    const keysToDelete: K[] = [];
    this.cache.forEach((entry, key) => {
      if (now > entry.expiresAt) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach(key => this.cache.delete(key));
  }
}

// ============================================================================
// Memoize with TTL
// ============================================================================

export function memoize<T extends (...args: unknown[]) => unknown>(
  fn: T,
  config: CacheConfig & { keyFn?: (...args: Parameters<T>) => string }
): T {
  const cache = new TTLCache<string, ReturnType<T>>(config);
  const keyFn = config.keyFn ?? ((...args) => JSON.stringify(args));

  return function memoized(...args: Parameters<T>): ReturnType<T> {
    const key = keyFn(...args);
    const cached = cache.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const result = fn(...args) as ReturnType<T>;
    cache.set(key, result);
    return result;
  } as T;
}

// ============================================================================
// Concurrency Pool
// ============================================================================

export class ConcurrencyPool {
  private running = 0;
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private readonly maxConcurrent: number;
  private readonly timeout: number | undefined;

  constructor(config: ConcurrencyConfig) {
    this.maxConcurrent = config.maxConcurrent;
    this.timeout = config.timeout;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();

    try {
      if (this.timeout) {
        return await withTimeout(fn(), this.timeout);
      }
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  private release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next.resolve();
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.running;
  }
}

// ============================================================================
// Parallel Map with Concurrency Limit
// ============================================================================

export async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number = 5
): Promise<R[]> {
  const pool = new ConcurrencyPool({ maxConcurrent: concurrency });
  return Promise.all(
    items.map((item, index) => pool.run(() => fn(item, index)))
  );
}

// ============================================================================
// Utility Functions
// ============================================================================

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation timed out'
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

export async function retry<T>(
  fn: () => Promise<T>,
  config: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    backoffMultiplier = 2,
    shouldRetry = () => true,
  } = config;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      const delay = Math.min(
        baseDelayMs * Math.pow(backoffMultiplier, attempt),
        maxDelayMs
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

// ============================================================================
// Exports
// ============================================================================

export default {
  RateLimiter,
  TTLCache,
  ConcurrencyPool,
  throttle,
  debounce,
  memoize,
  parallelMap,
  sleep,
  withTimeout,
  retry,
};
