import { describe, it, expect } from 'vitest';
import { extractJson } from '../server/claude.js';

describe('extractJson', () => {
  it('parses unfenced JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('parses fenced JSON with surrounding prose', () => {
    expect(extractJson('Here you go:\n```json\n{"a":[1,2]}\n```\nthanks')).toEqual({ a: [1, 2] });
  });
  it('throws on text without an object', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});
