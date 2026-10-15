import { executionProfile, validateOutputTokens } from './validation-profile.mjs';

// A digest chain alone does not rule out a historical stop or a budget reset.
// Recovery additionally requires the original zero -> pending -> truncation path.
export function eligibleFirstTruncationHistory(states) {
  let reserved = null,
    reservedFingerprint = null,
    truncated = false;
  if (states.length < 3 || states[0].requests !== 0) return false;
  for (const s of states) {
    if (s.recoveryAudit !== undefined || !Array.isArray(s.entries)) return false;
    if (s.requests === 0) {
      if (reserved || s.qualityRequests !== 0 || s.spentCny !== 0 || s.halted !== false || s.entries.length !== 0)
        return false;
      continue;
    }
    const e = s.entries[0];
    if (
      s.requests !== 1 ||
      s.qualityRequests !== 1 ||
      s.entries.length !== 1 ||
      e?.id !== 1 ||
      e.purpose !== 'quality' ||
      !Number.isFinite(e.reservationCny) ||
      e.reservationCny <= 0 ||
      e.chargedCny !== e.reservationCny ||
      Math.round(s.spentCny * 1_000_000) !== Math.round(e.chargedCny * 1_000_000) ||
      s.spentCny >= 5 ||
      (e.maxOutputTokens !== undefined && e.maxOutputTokens !== 1200) ||
      (reserved && reservedFingerprint !== JSON.stringify({ ...e, status: undefined }))
    )
      return false;
    if (e.status === 'pending' && s.halted === false && !truncated) {
      reserved = e;
      reservedFingerprint = JSON.stringify({ ...e, status: undefined });
    } else if (e.status === 'budget-truncation' && s.halted === true && reserved) truncated = true;
    else return false;
  }
  return truncated;
}

/** This is a one-time exception for the explicitly approved first truncated request. */
export function recoverApprovedTruncation(ledger, journal, approval, maxOutputTokens) {
  const refuse = () => {
    throw Error('recovery-refused: approval, checkpoint or settled truncation is ineligible');
  };
  validateOutputTokens(maxOutputTokens);
  const s = ledger.state;
  const entry = s.entries.at(-1);
  if (
    approval?.approvedChoice !== '4096-preserve-ledger' ||
    maxOutputTokens !== 4096 ||
    approval.lastEntryId !== 1 ||
    approval.checkpointHash !== journal.checkpointHash ||
    !/^[a-f0-9]{64}$/.test(approval.checkpointHash ?? '') ||
    journal.poisoned ||
    journal.corrupted ||
    !journal.completeHashChain ||
    !journal.firstTruncationHistoryEligible ||
    s.halted !== true ||
    s.requests !== 1 ||
    s.qualityRequests !== 1 ||
    s.entries.length !== 1 ||
    s.recoveryAudit !== undefined ||
    entry?.id !== 1 ||
    entry.purpose !== 'quality' ||
    entry.status !== 'budget-truncation' ||
    !Number.isFinite(entry.reservationCny) ||
    entry.reservationCny <= 0 ||
    entry.chargedCny !== entry.reservationCny ||
    Math.round(s.spentCny * 1_000_000) !== Math.round(entry.chargedCny * 1_000_000) ||
    s.spentCny >= 5 ||
    s.spentCny < 0 ||
    (entry.maxOutputTokens !== undefined && entry.maxOutputTokens !== 1200)
  )
    refuse();
  // Work on a clone: failed writes must never expose an unhalted in-memory budget.
  const next = structuredClone(s);
  next.executionProfile = executionProfile(4096);
  next.recoveryAudit = [
    {
      kind: 'approved-output-profile-recovery',
      approvedChoice: '4096-preserve-ledger',
      previousCheckpointHash: journal.checkpointHash,
      lastEntryId: 1,
      previousStop: 'budget-truncation',
      preservedRequests: s.requests,
      preservedQualityRequests: s.qualityRequests,
      preservedSpentCny: s.spentCny,
      executionProfile: next.executionProfile,
    },
  ];
  next.halted = false;
  journal.commit(next);
  ledger.state = next;
}
