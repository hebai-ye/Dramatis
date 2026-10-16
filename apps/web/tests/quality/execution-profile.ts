import type { QualityExecutionProfile } from './types';

export const defaultExecutionProfile: QualityExecutionProfile = Object.freeze({
  profileId: 'deepseek-flash-low-output-1200-v1',
  maxOutputTokens: 1200,
  model: 'deepseek-flash',
  reasoningEffort: 'low',
});

export class QualityExecutionProfileError extends Error {
  constructor(code: 'invalid-execution-profile' | 'execution-profile-mismatch') {
    super(code);
    this.name = 'QualityExecutionProfileError';
  }
}

/** Accept only the two approved parameter tuples; never silently fall back for host status. */
export function readExecutionProfile(value: unknown): QualityExecutionProfile {
  if (!value || typeof value !== 'object') throw new QualityExecutionProfileError('invalid-execution-profile');
  const profile = value as Record<string, unknown>;
  const maxOutputTokens = profile.maxOutputTokens;
  if (
    (maxOutputTokens !== 1200 && maxOutputTokens !== 4096) ||
    profile.profileId !== `deepseek-flash-low-output-${maxOutputTokens}-v1` ||
    profile.model !== 'deepseek-flash' ||
    profile.reasoningEffort !== 'low'
  )
    throw new QualityExecutionProfileError('invalid-execution-profile');
  return {
    profileId: profile.profileId as QualityExecutionProfile['profileId'],
    maxOutputTokens,
    model: 'deepseek-flash',
    reasoningEffort: 'low',
  };
}

/** A rejection may precede upstream dispatch and thus cannot supply an upstream body digest. */
export function readExecutionResponseEvidence(
  response: Response,
  profile: QualityExecutionProfile,
  required: boolean,
): string | undefined {
  if (!response.ok) return undefined;
  const profileId = response.headers.get('x-validation-execution-profile');
  const maxOutputTokens = response.headers.get('x-validation-max-output-tokens');
  const upstreamWireHash = response.headers.get('x-validation-upstream-wire-hash');
  if (profileId === null && maxOutputTokens === null && upstreamWireHash === null && !required) return undefined;
  if (
    profileId !== profile.profileId ||
    maxOutputTokens !== String(profile.maxOutputTokens) ||
    upstreamWireHash === null ||
    !/^[a-f0-9]{64}$/.test(upstreamWireHash)
  )
    throw new QualityExecutionProfileError('execution-profile-mismatch');
  return upstreamWireHash;
}
