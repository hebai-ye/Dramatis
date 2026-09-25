import { describe, expect, it } from 'vitest';
import { assertPassword, MIN_PASSWORD_LENGTH, passwordStrength, passwordStrengthHint } from './password-policy';

describe('password-policy（审计 A9）', () => {
  it('太短的密码被拒', () => {
    expect(() => assertPassword('12345')).toThrow(String(MIN_PASSWORD_LENGTH));
    expect(() => assertPassword('      abc   ')).toThrow();
    expect(() => assertPassword('abcdef')).not.toThrow();
  });

  it('强度分档', () => {
    expect(passwordStrength('abc')).toBe('too-short');
    expect(passwordStrength('123456')).toBe('weak');
    expect(passwordStrength('aaaaaaaaaaaaaaaa')).toBe('weak');
    expect(passwordStrength('abcdefgh')).toBe('weak');
    expect(passwordStrength('abcd1234')).toBe('ok');
    expect(passwordStrength('Tea-Garden-7-Moon')).toBe('strong');
  });

  it('没输入时不给提示', () => {
    expect(passwordStrengthHint('')).toBeNull();
    expect(passwordStrengthHint('x')).toContain('太短');
  });
});
