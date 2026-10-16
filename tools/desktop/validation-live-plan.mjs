export const PREVIOUS_TRUNCATED_SAMPLE = Object.freeze({ caseId: 'affect-1', side: 'shared', repeat: 2 });

export function planRemainingSamples(mapping, options, previous = PREVIOUS_TRUNCATED_SAMPLE) {
  if (!Array.isArray(mapping) || !Array.isArray(options) || mapping.length !== options.length)
    throw Error('Blind mapping does not match the visible samples');
  const byId = new Map();
  for (const row of mapping) {
    if (!row || typeof row.blindId !== 'string' || byId.has(row.blindId)) throw Error('Invalid blind mapping');
    byId.set(row.blindId, row);
  }
  const seen = new Set();
  const plan = [];
  let skipped = 0;
  for (const option of options) {
    const parts = option.label.split(' · ');
    const blindId = parts[0];
    const row = byId.get(blindId);
    if (!row || seen.has(blindId) || typeof option.value !== 'string' || parts.length !== 2)
      throw Error('Visible sample identity is ambiguous');
    seen.add(blindId);
    if (row.caseId === previous.caseId && row.side === previous.side && row.repeat === previous.repeat) {
      skipped += 1;
    } else {
      plan.push({ blindId, value: option.value, family: parts[1] });
    }
  }
  if (skipped !== 1) throw Error('Exactly one already attempted sample must be skipped');
  return plan;
}
