import { describe, expect, it } from 'vitest';
import { readExecutionProfile, readExecutionResponseEvidence } from './execution-profile';

const profile4096 = {
  profileId: 'deepseek-flash-low-output-4096-v1',
  maxOutputTokens: 4096,
  model: 'deepseek-flash',
  reasoningEffort: 'low',
} as const;

describe('quality execution profile boundary', () => {
  it.each([
    undefined,
    { ...profile4096, maxOutputTokens: 1200 },
    { ...profile4096, maxOutputTokens: 8192 },
    { ...profile4096, model: 'other-model' },
    { ...profile4096, reasoningEffort: 'high' },
    { ...profile4096, profileId: 'unapproved-profile' },
  ])('rejects unsupported or inconsistent host profile before dispatch: %j', (value) => {
    expect(() => readExecutionProfile(value)).toThrow('invalid-execution-profile');
  });

  it('requires complete matching server evidence when running the approved 4096 profile', () => {
    const profile = readExecutionProfile(profile4096);
    const responseHeaders: Record<string, string>[] = [
      {},
      { 'x-validation-execution-profile': profile4096.profileId },
      {
        'x-validation-execution-profile': 'deepseek-flash-low-output-1200-v1',
        'x-validation-max-output-tokens': '4096',
        'x-validation-upstream-wire-hash': 'a'.repeat(64),
      },
      {
        'x-validation-execution-profile': profile4096.profileId,
        'x-validation-max-output-tokens': '1200',
        'x-validation-upstream-wire-hash': 'a'.repeat(64),
      },
      {
        'x-validation-execution-profile': profile4096.profileId,
        'x-validation-max-output-tokens': '4096',
        'x-validation-upstream-wire-hash': 'not-a-digest',
      },
    ];
    for (const headers of responseHeaders) {
      expect(() => readExecutionResponseEvidence(new Response('ok', { headers }), profile, true)).toThrow(
        'execution-profile-mismatch',
      );
    }
  });

  it('keeps legacy 1200 fake responses compatible but cannot label them as observed upstream evidence', () => {
    const profile = readExecutionProfile({
      profileId: 'deepseek-flash-low-output-1200-v1',
      maxOutputTokens: 1200,
      model: 'deepseek-flash',
      reasoningEffort: 'low',
    });
    expect(readExecutionResponseEvidence(new Response('ok'), profile, false)).toBeUndefined();
    expect(() => readExecutionResponseEvidence(new Response('ok'), profile, true)).toThrow(
      'execution-profile-mismatch',
    );
  });

  it('preserves non-OK rejection handling without inventing an upstream digest', () => {
    expect(
      readExecutionResponseEvidence(
        new Response('denied', { status: 403, headers: { 'x-validation-execution-profile': profile4096.profileId } }),
        readExecutionProfile(profile4096),
        true,
      ),
    ).toBeUndefined();
  });
});
