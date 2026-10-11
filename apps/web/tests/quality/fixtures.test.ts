import { describe, expect, it } from 'vitest';
import { canonical, hash } from '../../../../tools/desktop/validation-common.mjs';
import { makeCases } from './fixtures';

describe('frozen production quality fixtures', () => {
  it('assembles twelve stable requests, three per family, without random IDs or time', () => {
    const first = makeCases();
    expect(first).toHaveLength(12);
    expect(first.map((c) => c.caseId)).toEqual(makeCases().map((c) => c.caseId));
    expect(hash(first)).toBe(hash(makeCases()));
    for (const family of ['roleplay', 'extraction', 'affect', 'admin']) {
      expect(first.filter((c) => c.family === family)).toHaveLength(3);
    }
    for (const item of first) {
      expect(item.request.messages.length).toBeGreaterThan(1);
      expect(item.request.params).toEqual({
        model: 'deepseek-flash',
        reasoning_effort: 'low',
        thinking: { type: 'enabled' },
        max_tokens: 1200,
      });
    }
    expect(first.filter((c) => c.family === 'admin').every((c) => c.request.tools.length > 0)).toBe(true);
  });
  it('canonicalizes objects recursively but preserves meaningful array order', () => {
    expect(hash({ b: 1, a: { y: 2, x: 3 } })).toBe(hash({ a: { x: 3, y: 2 }, b: 1 }));
    expect(hash([1, 2])).not.toBe(hash([2, 1]));
    expect(canonical({ z: undefined, a: 1 })).toBe('{"a":1}');
  });
});
