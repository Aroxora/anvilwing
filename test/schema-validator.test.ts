/**
 * Tool-argument coercion + validation — the gate every LLM tool call passes
 * through (coerceToolArguments + validateToolArguments). It was untested; these
 * lock its real behaviour so a regression in the validation gate is caught.
 */

import {
  coerceToolArguments,
  validateToolArguments,
  ToolArgumentValidationError,
  TypeGuards,
} from '../src/core/schemaValidator.js';
import type { JSONSchemaObject } from '../src/core/types.js';

const sch = (o: object): JSONSchemaObject => o as unknown as JSONSchemaObject;

describe('TypeGuards', () => {
  it('narrow primitive/array/object/enum correctly', () => {
    expect(TypeGuards.isString('x')).toBe(true);
    expect(TypeGuards.isString(1)).toBe(false);
    expect(TypeGuards.isNumber(1)).toBe(true);
    expect(TypeGuards.isNumber('1')).toBe(false);
    expect(TypeGuards.isBoolean(false)).toBe(true);
    expect(TypeGuards.isArray([])).toBe(true);
    expect(TypeGuards.isArray({})).toBe(false);
    expect(TypeGuards.isObject({})).toBe(true);
    expect(TypeGuards.isObject(null)).toBe(false);
    expect(TypeGuards.isObject([])).toBe(false);
    expect(TypeGuards.isNotNull(0)).toBe(true);
    expect(TypeGuards.isNotNull(null)).toBe(false);
    expect(TypeGuards.isEnum('a', ['a', 'b'] as const)).toBe(true);
    expect(TypeGuards.isEnum('c', ['a', 'b'] as const)).toBe(false);
  });
});

describe('coerceToolArguments', () => {
  const schema = sch({ type: 'object', properties: { flag: { type: 'boolean' }, n: { type: 'number' }, s: { type: 'string' } } });

  it('coerces string/number booleans the way models emit them', () => {
    expect(coerceToolArguments(schema, { flag: 'true' }).flag).toBe(true);
    expect(coerceToolArguments(schema, { flag: '1' }).flag).toBe(true);
    expect(coerceToolArguments(schema, { flag: 1 }).flag).toBe(true);
    expect(coerceToolArguments(schema, { flag: 'false' }).flag).toBe(false);
    expect(coerceToolArguments(schema, { flag: '0' }).flag).toBe(false);
    expect(coerceToolArguments(schema, { flag: 0 }).flag).toBe(false);
  });

  it('coerces numeric strings to numbers', () => {
    expect(coerceToolArguments(schema, { n: '42' }).n).toBe(42);
    expect(coerceToolArguments(schema, { n: '3.14' }).n).toBe(3.14);
  });

  it('leaves un-coercible / non-target values untouched', () => {
    expect(coerceToolArguments(schema, { n: 'abc' }).n).toBe('abc'); // stays to fail validation
    expect(coerceToolArguments(schema, { flag: 'maybe' }).flag).toBe('maybe');
    expect(coerceToolArguments(schema, { s: 'hi' }).s).toBe('hi'); // strings not touched
    expect(coerceToolArguments(schema, { n: null }).n).toBeNull(); // null/undefined skipped
    expect(coerceToolArguments(schema, { extra: 'keep' }).extra).toBe('keep'); // unknown preserved
  });

  it('passes args through unchanged when there is no object schema', () => {
    const args = { a: '1', b: true };
    expect(coerceToolArguments(undefined, args)).toEqual(args);
    expect(coerceToolArguments(sch({ type: 'string' }), args)).toEqual(args);
  });
});

describe('validateToolArguments', () => {
  const schema = sch({
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      mode: { type: 'string', enum: ['r', 'w'] },
      count: { type: 'number', minimum: 0, maximum: 10 },
      flag: { type: 'boolean' },
      items: { type: 'array' },
    },
    required: ['path'],
  });

  it('passes valid args', () => {
    expect(() => validateToolArguments('Tool', schema, { path: 'a.ts', mode: 'r', count: 5, flag: true, items: [] })).not.toThrow();
  });

  it('throws ToolArgumentValidationError listing every problem', () => {
    try {
      validateToolArguments('Read', schema, { mode: 'x', count: 99, flag: 'nope', items: {} } as Record<string, unknown>);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolArgumentValidationError);
      const err = e as ToolArgumentValidationError;
      expect(err.toolName).toBe('Read');
      const joined = err.issues.join(' | ');
      expect(joined).toMatch(/Missing required property "path"/);
      expect(joined).toMatch(/must be one of/);        // bad enum
      expect(joined).toMatch(/at most 10/);            // count > maximum
      expect(joined).toMatch(/must be a boolean/);     // flag
      expect(joined).toMatch(/must be an array/);      // items
    }
  });

  it('enforces minLength and rejects NaN/Infinity numbers', () => {
    expect(() => validateToolArguments('T', schema, { path: '' })).toThrow(/at least 1 character/);
    expect(() => validateToolArguments('T', schema, { path: 'a', count: NaN })).toThrow(/finite number/);
    expect(() => validateToolArguments('T', schema, { path: 'a', count: Infinity })).toThrow(/finite number/);
    expect(() => validateToolArguments('T', schema, { path: 'a', count: -1 })).toThrow(/at least 0/);
  });

  it('ignores hallucinated unknown properties (lenient) and no-ops without an object schema', () => {
    expect(() => validateToolArguments('T', schema, { path: 'a', bogus: 123 })).not.toThrow();
    expect(() => validateToolArguments('T', undefined, { anything: 1 })).not.toThrow();
  });
});
