/* eslint-disable @typescript-eslint/no-namespace */
import type { JSONSchemaArray, JSONSchemaObject, JSONSchemaProperty } from './types.js';

/**
 * Enhanced validation error with structured error information
 */
export class ToolArgumentValidationError extends Error {
  readonly issues: readonly string[];
  readonly toolName: string;
  
  constructor(toolName: string, issues: string[]) {
    super(formatMessage(toolName, issues));
    this.name = 'ToolArgumentValidationError';
    this.issues = issues;
    this.toolName = toolName;
  }
}

/**
 * Runtime type guards for tool argument validation
 */
export namespace TypeGuards {
  /**
   * Type guard for string values
   */
  export function isString(value: unknown): value is string {
    return typeof value === 'string';
  }

  /**
   * Type guard for number values
   */
  export function isNumber(value: unknown): value is number {
    return typeof value === 'number' && !Number.isNaN(value);
  }

  /**
   * Type guard for boolean values
   */
  export function isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
  }

  /**
   * Type guard for array values
   */
  export function isArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
  }

  /**
   * Type guard for object values
   */
  export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * Type guard for non-null values
   */
  export function isNotNull(value: unknown): value is NonNullable<unknown> {
    return value !== undefined && value !== null;
  }

  /**
   * Type guard for enum values
   */
  export function isEnum<T extends string>(value: unknown, enumValues: readonly T[]): value is T {
    return TypeGuards.isString(value) && enumValues.includes(value as T);
  }
}

/**
 * Coerce loosely-typed tool arguments into their declared schema types.
 * This makes tools resilient to providers that emit boolean/number values as strings.
 */
export function coerceToolArguments(
  schema: JSONSchemaObject | undefined,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return args;
  }

  const coerced: Record<string, unknown> = { ...args };

  for (const [key, definition] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(args, key)) {
      continue;
    }
    const value = args[key];
    if (value === undefined || value === null) {
      continue;
    }

    switch (definition.type) {
      case 'boolean': {
        const normalized = coerceBoolean(value);
        coerced[key] = normalized;
        break;
      }
      case 'number': {
        const normalized = coerceNumber(value);
        coerced[key] = normalized;
        break;
      }
      default:
        break;
    }
  }

  return coerced;
}

function coerceBoolean(value: unknown): unknown {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'true' || trimmed === '1') return true;
    if (trimmed === 'false' || trimmed === '0') return false;
  }
  return value;
}

function coerceNumber(value: unknown): unknown {
  if (typeof value === 'number') {
    // Reject NaN, Infinity, and -Infinity
    if (!Number.isFinite(value)) {
      return value; // Return as-is to fail validation
    }
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    // Only accept finite numbers
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return value;
}

export function validateToolArguments(
  toolName: string,
  schema: JSONSchemaObject | undefined,
  args: Record<string, unknown>
): void {
  if (!schema || schema.type !== 'object') {
    return;
  }

  const errors: string[] = [];
  const properties = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const property of required) {
    if (!hasArgument(args, property)) {
      errors.push(`Missing required property "${property}".`);
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const definition = properties[key];
    if (!definition) {
      // Silently ignore unknown properties - models sometimes hallucinate extra params
      // This is more lenient than strict JSON schema validation but prevents errors
      // when models pass extra parameters that don't affect tool behavior
      continue;
    }
    validateSchemaProperty(definition, value, key, errors);
  }

  if (errors.length) {
    throw new ToolArgumentValidationError(toolName, errors);
  }
}

function validateSchemaProperty(
  definition: JSONSchemaProperty,
  value: unknown,
  path: string,
  errors: string[]
): void {
  switch (definition.type) {
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`Argument "${path}" must be a string.`);
        return;
      }
      if (definition.enum && !definition.enum.includes(value)) {
        errors.push(
          `Argument "${path}" must be one of: ${definition.enum.map((entry) => `"${entry}"`).join(', ')}.`
        );
      }
      if (typeof definition.minLength === 'number' && value.length < definition.minLength) {
        errors.push(
          `Argument "${path}" must be at least ${definition.minLength} character${
            definition.minLength === 1 ? '' : 's'
          } long.`
        );
      }
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`Argument "${path}" must be a finite number.`);
        return;
      }
      // Validate minimum constraint
      if (typeof definition.minimum === 'number' && value < definition.minimum) {
        errors.push(`Argument "${path}" must be at least ${definition.minimum}.`);
      }
      // Validate maximum constraint
      if (typeof definition.maximum === 'number' && value > definition.maximum) {
        errors.push(`Argument "${path}" must be at most ${definition.maximum}.`);
      }
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        errors.push(`Argument "${path}" must be a boolean.`);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`Argument "${path}" must be an array.`);
        return;
      }
      validateArrayItems(definition, value, path, errors);
      return;
    }
    default:
      return;
  }
}

function validateArrayItems(
  definition: JSONSchemaArray,
  value: unknown[],
  path: string,
  errors: string[]
): void {
  const itemSchema = definition.items;
  if (!itemSchema) {
    return;
  }

  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    validateSchemaProperty(itemSchema, entry, `${path}[${index}]`, errors);
  }
}

function hasArgument(args: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(args, key)) {
    return false;
  }
  const value = args[key];
  return value !== undefined && value !== null;
}

function formatMessage(toolName: string, issues: string[]): string {
  const detail = issues.join(' ');
  return `Invalid arguments for "${toolName}": ${detail}`;
}
