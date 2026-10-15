import { createHash } from 'node:crypto';
import { executionProfile, upstreamWireHash, validateOutputTokens } from './validation-profile.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
export function reservation(wire) {
  // UTF-8 byte count bounds text tokens conservatively; full JSON includes tool schema/framing.
  const outputTokens = validateOutputTokens(wire?.max_tokens);
  return (Buffer.byteLength(JSON.stringify(wire), 'utf8') * 2 + outputTokens * 8) / 1_000_000;
}
export class Ledger {
  constructor(saved) {
    this.state = saved
      ? structuredClone(saved)
      : { version: 1, requests: 0, qualityRequests: 0, spentCny: 0, halted: false, entries: [] };
    const s = this.state;
    if (
      s.version !== 1 ||
      !Number.isInteger(s.requests) ||
      s.requests < 0 ||
      !Number.isInteger(s.qualityRequests) ||
      s.qualityRequests < 0 ||
      s.qualityRequests > s.requests ||
      !Number.isFinite(s.spentCny) ||
      s.spentCny < 0 ||
      !Array.isArray(s.entries)
    )
      throw Error('Invalid ledger');
    if (s.entries.some((e) => e.status === 'pending')) s.halted = true;
  }
  reserve(wire, purpose) {
    const s = this.state;
    if (s.halted) throw Error('Ledger halted: reconcile usage before any further run');
    if (!['quality', 'csp'].includes(purpose)) throw Error('Invalid purpose');
    if (s.requests >= 48) throw Error('48 request limit');
    if (purpose === 'quality' && s.qualityRequests >= 44) throw Error('Four C05 calls reserved');
    const cost = reservation(wire);
    if (Math.round(s.spentCny * 1_000_000) + Math.round(cost * 1_000_000) > 5_000_000) throw Error('5 CNY limit');
    const id = ++s.requests;
    if (purpose === 'quality') s.qualityRequests++;
    s.spentCny = Math.round((s.spentCny + cost) * 1_000_000) / 1_000_000;
    const profile = executionProfile(wire.max_tokens);
    s.executionProfile = profile;
    s.entries.push({
      id,
      purpose,
      reservationCny: cost,
      chargedCny: cost,
      status: 'pending',
      maxOutputTokens: wire.max_tokens,
      executionProfile: profile,
      executionProfileHash: hash(profile),
      upstreamWireHash: upstreamWireHash(JSON.stringify(wire)),
    });
    return id;
  }
  settle(id, usage, status = 'complete') {
    const s = this.state,
      entry = s.entries.find((e) => e.id === id);
    if (entry?.status !== 'pending') throw Error('Unknown or settled request');
    const valid =
      usage &&
      Number.isInteger(usage.prompt_tokens) &&
      usage.prompt_tokens >= 0 &&
      Number.isInteger(usage.completion_tokens) &&
      usage.completion_tokens >= 0;
    if (!valid || status !== 'complete') {
      entry.status = status === 'complete' ? 'missing-usage' : status;
      s.halted = true;
      return;
    }
    const actual = (usage.prompt_tokens * 2 + usage.completion_tokens * 8) / 1_000_000;
    s.spentCny = Math.round((s.spentCny + actual - entry.chargedCny) * 1_000_000) / 1_000_000;
    entry.chargedCny = actual;
    entry.usage = { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens };
    entry.status = status;
    if (actual > entry.reservationCny || s.spentCny >= 5) s.halted = true;
  }
}
export function cleanEvidence(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => cleanEvidence(v, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k, v]) => (k === 'reasoningEffort' && v === 'low') || !/authorization|api.?key|reasoning|secret/i.test(k),
        )
        .map(([k, v]) => [k, cleanEvidence(v, key)]),
    );
  return typeof value === 'string' && key ? value.split(key).join('[REDACTED]') : value;
}
