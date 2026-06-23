/**
 * TypeScript Utility Types and Helper Functions
 * 
 * Provides comprehensive TypeScript utilities for:
 * - Advanced type manipulation
 * - Functional programming patterns
 * - Immutable data structures
 * - Runtime type checking
 */
import { reportStatusError } from '../../utils/statusReporter.js';

/**
 * Deep Readonly type for complete immutability
 */
export type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

/**
 * Make specific properties optional
 */
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Make specific properties required
 */
export type RequiredBy<T, K extends keyof T> = T & Required<Pick<T, K>>;

/**
 * Extract only function properties from type
 */
export type FunctionProperties<T> = {
  [K in keyof T]: T[K] extends (...args: unknown[]) => unknown ? T[K] : never;
};

/**
 * Extract only data properties from type
 */
export type DataProperties<T> = {
  [K in keyof T]: T[K] extends (...args: unknown[]) => unknown ? never : T[K];
};

/**
 * Branded type for nominal typing
 */
export type Brand<T, B> = T & { readonly __brand: B };

/**
 * Union to intersection type
 */
export type UnionToIntersection<U> = 
  (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void 
    ? I 
    : never;

/**
 * Async function return type
 */
export type AsyncReturnType<T extends (...args: unknown[]) => unknown> = 
  T extends (...args: unknown[]) => Promise<infer R> ? R : never;

/**
 * Constructor type
 */
export type Constructor<T = unknown> = new (...args: unknown[]) => T;

/**
 * Instance type from constructor
 */
export type InstanceType<T extends Constructor> = T extends Constructor<infer R> ? R : never;

/**
 * Runtime type checking utilities
 */
export class TypeGuards {
  /**
   * Check if value is a string
   */
  static isString(value: unknown): value is string {
    return typeof value === 'string';
  }

  /**
   * Check if value is a number
   */
  static isNumber(value: unknown): value is number {
    return typeof value === 'number' && !isNaN(value);
  }

  /**
   * Check if value is a boolean
   */
  static isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
  }

  /**
   * Check if value is an object (not null, not array)
   */
  static isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * Check if value is an array
   */
  static isArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
  }

  /**
   * Check if value is a function
   */
  static isFunction(value: unknown): value is (...args: unknown[]) => unknown {
    return typeof value === 'function';
  }

  /**
   * Check if value is null or undefined
   */
  static isNil(value: unknown): value is null | undefined {
    return value === null || value === undefined;
  }

  /**
   * Check if value has a specific property
   */
  static hasProperty<T extends string>(
    value: unknown,
    property: T
  ): value is { [K in T]: unknown } {
    return TypeGuards.isObject(value) && property in value;
  }
}

/**
 * Functional programming utilities
 */
export class Functional {
  /**
   * Compose multiple functions
   */
  static compose<T>(...fns: Array<(x: T) => T>): (x: T) => T {
    return (x: T) => fns.reduceRight((acc, fn) => fn(acc), x);
  }

  /**
   * Pipe value through multiple functions
   */
  static pipe<T>(value: T, ...fns: Array<(x: T) => T>): T {
    return fns.reduce((acc, fn) => fn(acc), value);
  }

  /**
   * Memoize function with cache
   */
  static memoize<T extends (...args: unknown[]) => unknown>(
    fn: T,
    cacheKey?: (...args: Parameters<T>) => string
  ): T {
    const cache = new Map<string, ReturnType<T>>();
    
    return ((...args: Parameters<T>): ReturnType<T> => {
      const key = cacheKey ? cacheKey(...args) : JSON.stringify(args);
      
      if (cache.has(key)) {
        return cache.get(key)!;
      }
      
      const result = fn(...args) as ReturnType<T>;
      cache.set(key, result);
      
      return result;
    }) as T;
  }

  /**
   * Debounce function execution
   */
  static debounce<T extends (...args: unknown[]) => unknown>(
    fn: T,
    delay: number
  ): (...args: Parameters<T>) => void {
    let timeoutId: NodeJS.Timeout;
    
    return (...args: Parameters<T>): void => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn(...args), delay);
    };
  }

  /**
   * Throttle function execution
   */
  static throttle<T extends (...args: unknown[]) => unknown>(
    fn: T,
    delay: number
  ): (...args: Parameters<T>) => void {
    let lastCall = 0;
    
    return (...args: Parameters<T>): void => {
      const now = Date.now();
      
      if (now - lastCall >= delay) {
        lastCall = now;
        fn(...args);
      }
    };
  }
}

/**
 * Immutable data utilities
 */
export class Immutable {
  /**
   * Deep freeze object
   */
  static deepFreeze<T>(obj: T): DeepReadonly<T> {
    if (typeof obj !== 'object' || obj === null) {
      return obj as DeepReadonly<T>;
    }

    Object.freeze(obj);

    Object.getOwnPropertyNames(obj).forEach(prop => {
      const value = (obj as Record<string, unknown>)[prop];
      
      if (
        value &&
        typeof value === 'object' &&
        !Object.isFrozen(value)
      ) {
        Immutable.deepFreeze(value);
      }
    });

    return obj as DeepReadonly<T>;
  }

  /**
   * Create immutable copy with updates
   */
  static update<T extends Record<string, unknown>>(
    obj: T,
    updates: Partial<T>
  ): T {
    return { ...obj, ...updates };
  }

  /**
   * Create immutable copy with nested updates
   */
  static updateIn<T extends Record<string, unknown>>(
    obj: T,
    path: string[],
    value: unknown
  ): T {
    if (path.length === 0) {
      return obj;
    }

    const [first, ...rest] = path;
    
    if (rest.length === 0) {
      return { ...obj, [first as keyof T]: value } as T;
    }

    const current = obj[first as keyof T];
    
    if (!TypeGuards.isObject(current)) {
      throw new Error(`Cannot update non-object at path: ${first}`);
    }

    return {
      ...obj,
      [first as keyof T]: Immutable.updateIn(current as Record<string, unknown>, rest, value)
    } as T;
  }
}

/**
 * Type-safe event emitter
 */
export class TypedEventEmitter<T extends Record<string, unknown[]>> {
  private listeners: {
    [K in keyof T]?: Array<(...args: T[K]) => void>;
  } = {};

  /**
   * Add event listener
   */
  on<K extends keyof T>(event: K, listener: (...args: T[K]) => void): void {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event]!.push(listener);
  }

  /**
   * Remove event listener
   */
  off<K extends keyof T>(event: K, listener: (...args: T[K]) => void): void {
    if (!this.listeners[event]) {
      return;
    }
    
    const index = this.listeners[event]!.indexOf(listener);
    if (index !== -1) {
      this.listeners[event]!.splice(index, 1);
    }
  }

  /**
   * Emit event
   */
  emit<K extends keyof T>(event: K, ...args: T[K]): void {
    if (!this.listeners[event]) {
      return;
    }
    
    this.listeners[event]!.forEach(listener => {
      try {
        listener(...args);
      } catch (error) {
        reportStatusError(error, `Error in event listener for ${String(event)}`);
      }
    });
  }

  /**
   * Remove all listeners
   */
  removeAllListeners(): void {
    this.listeners = {};
  }
}

/**
 * Utility functions for common TypeScript patterns
 */
export class TypeScriptUtils {
  /**
   * Assert value is not null or undefined
   */
  static assertDefined<T>(value: T | null | undefined, message?: string): asserts value is T {
    if (value === null || value === undefined) {
      throw new Error(message ?? 'Value is null or undefined');
    }
  }

  /**
   * Create type-safe enum from array
   */
  static createStringEnum<T extends string>(values: readonly T[]): { [K in T]: K } {
    return values.reduce((acc, value) => {
      acc[value] = value;
      return acc;
    }, {} as { [K in T]: K });
  }

  /**
   * Create branded type
   */
  static createBranded<T, B>(value: T): Brand<T, B> {
    return value as Brand<T, B>;
  }

  /**
   * Extract keys from type that match a condition
   */
  static extractKeys<T extends object>(
    obj: T,
    predicate: (key: keyof T, value: T[keyof T]) => boolean
  ): Array<keyof T> {
    return (Object.keys(obj) as Array<keyof T>).filter(key => predicate(key, obj[key]));
  }

  /**
   * Pick properties from object
   */
  static pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
    const result = {} as Pick<T, K>;
    
    keys.forEach(key => {
      if (key in obj) {
        result[key] = obj[key];
      }
    });
    
    return result;
  }

  /**
   * Omit properties from object
   */
  static omit<T, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
    const result = { ...obj };
    
    keys.forEach(key => {
      delete result[key];
    });
    
    return result;
  }
}
