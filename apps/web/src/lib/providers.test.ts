import { createProviderProfile } from '@dramatis/core';
import { describe, expect, it } from 'vitest';
import { sameProfiles } from './providers';

describe('sameProfiles（审计 A10）', () => {
  const a = createProviderProfile({ name: 'A', baseUrl: 'https://a.test/v1', model: 'm' });
  const b = createProviderProfile({ name: 'B', baseUrl: 'https://b.test/v1', model: 'm' });

  it('内容一样（引用不同）视为相同，避免反复 setProfiles', () => {
    expect(sameProfiles([a, b], [{ ...a }, { ...b }])).toBe(true);
  });

  it('长度、顺序或字段不同都算不同', () => {
    expect(sameProfiles([a], [a, b])).toBe(false);
    expect(sameProfiles([a, b], [b, a])).toBe(false);
    expect(sameProfiles([a], [{ ...a, active: true }])).toBe(false);
  });
});
