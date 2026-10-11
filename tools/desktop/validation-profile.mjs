import { createHash } from 'node:crypto';

export function validateOutputTokens(value) {
  if (value !== 1200 && value !== 4096) throw Error('invalid-output-token-limit: only 1200 or 4096 are approved');
  return value;
}

export function executionProfile(maxOutputTokens = 1200) {
  validateOutputTokens(maxOutputTokens);
  return Object.freeze({
    profileId: `deepseek-flash-low-output-${maxOutputTokens}-v1`,
    maxOutputTokens,
    model: 'deepseek-flash',
    reasoningEffort: 'low',
  });
}

// Hash precisely the UTF-8 JSON dispatched upstream, rather than the canonical fixture.
export const upstreamWireHash = (serializedWire) => createHash('sha256').update(serializedWire, 'utf8').digest('hex');
