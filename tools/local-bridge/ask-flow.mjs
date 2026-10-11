import { captureBaseline, fillAndClick, observeReply, readSnapshot } from './site-adapter.mjs';
import { sleep, withCdp } from './transport.mjs';

/** Stable polls debounce a confirmed terminal reply; they never establish completion themselves. */
export async function waitForReply(
  call,
  baseline,
  prompt,
  deadline,
  { pollMs = 1_200, stableRounds = 3, sleepFn = sleep, readSnapshotFn = readSnapshot } = {},
) {
  let previous = '';
  let stable = 0;
  while (true) {
    await sleepFn(pollMs, deadline);
    deadline.throwIfExpired();
    const state = observeReply(baseline, await readSnapshotFn(call), prompt);
    if (!state.done) {
      previous = '';
      stable = 0;
      continue;
    }
    const signature = `${state.id}\u0000${state.text}`;
    stable = signature === previous ? stable + 1 : 1;
    previous = signature;
    if (stable >= stableRounds) return state.text;
  }
}

export async function runPageAsk({ call, prompt, targetId, guard, deadline, waitOptions }) {
  guard.check(targetId);
  deadline.throwIfExpired();
  await call('Runtime.enable');
  const baseline = captureBaseline(await readSnapshot(call));
  await fillAndClick(call, prompt, () => guard.markUncertain(targetId));
  const reply = await waitForReply(call, baseline, prompt, deadline, waitOptions);
  deadline.throwIfExpired();
  return reply;
}

/** The uncertainty lock is cleared only after the CDP transport has closed. */
export async function runTargetAsk({ target, prompt, guard, deadline, connect = withCdp, pageOptions }) {
  guard.check(target.id);
  const reply = await connect(
    target,
    async (call) => await runPageAsk({ call, prompt, targetId: target.id, guard, deadline, waitOptions: pageOptions }),
    { deadline },
  );
  deadline.throwIfExpired();
  guard.clear(target.id);
  return reply;
}
