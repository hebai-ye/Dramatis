import { createProviderProfile } from '@dramatis/core';
import { describe, expect, it } from 'vitest';
import * as providers from './providers';

describe('DeepSeek setup eligibility', () => {
  const active = createProviderProfile({ name: 'fixture', baseUrl: 'https://api.deepseek.com', model: 'custom' });
  const ready = { active, apiKey: '', keyLoading: false, keyError: null, vaultLocked: false };
  it.each([
    [{ ...ready, active: null }, 'waiting'],
    [{ ...ready, keyLoading: true }, 'waiting'],
    [{ ...ready, keyError: 'read denied' }, 'read-error'],
    [{ ...ready, vaultLocked: true }, 'locked'],
    [ready, 'missing'],
    [{ ...ready, apiKey: 'fixture-existing' }, 'configured'],
  ])('classifies availability without treating temporary empty keys as missing', (input, expected) => {
    expect(providers.deepseekSetupState?.(input)).toBe(expected);
  });
  it.each([
    ['https://api.deepseek.com', true],
    ['https://api.deepseek.com/v1/', true],
    ['https://api.deepseek.com.evil.test/v1', false],
    ['http://api.deepseek.com', false],
    ['https://proxy.test/v1', false],
    ['https://api.deepseek.com/custom', false],
  ])('only targets official endpoints: %s', (baseUrl, expected) => {
    expect(providers.isDeepSeekProfile?.({ ...active, name: 'DeepSeek', baseUrl })).toBe(expected);
  });
});
