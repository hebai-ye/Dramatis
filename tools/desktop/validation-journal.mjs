import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { hash, Ledger } from './validation-common.mjs';
import { eligibleFirstTruncationHistory } from './validation-recovery.mjs';

/**
 * Append-only checkpoints: the same open file is synchronously flushed before dispatch.
 * Node's fsyncSync uses the native flush operation on Windows. Unsupported/failed flush
 * poisons this session and leaves its exclusive lock for manual reconciliation.
 * No rename or unsynced replacement of an already acknowledged checkpoint is used.
 */
export function openBudgetJournal(ledgerPath, { initialize = false, sync = fsyncSync, write = writeSync } = {}) {
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const resolved = existsSync(ledgerPath)
    ? realpathSync(ledgerPath)
    : path.join(realpathSync(path.dirname(ledgerPath)), path.basename(ledgerPath));
  const lockPath = `${resolved}.lock`;
  let lockFd;
  try {
    lockFd = openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw Error('ledger-locked: another host or unreconciled failure owns this journal');
    throw error;
  }
  let fd,
    poisoned = false,
    closed = false,
    sequence = 0,
    previous = null,
    needsNewline = false,
    corrupted = false,
    completeHashChain = true;
  const history = [];
  const release = () => {
    if (closed) return;
    closed = true;
    if (fd !== undefined) closeSync(fd);
    closeSync(lockFd);
    if (!poisoned) unlinkSync(lockPath);
  };
  try {
    writeSync(lockFd, JSON.stringify({ pid: process.pid, reason: 'exclusive-validation-ledger' }));
    fsyncSync(lockFd);
    if (!initialize && !existsSync(resolved)) throw Error('ledger-missing: reconcile before initialization');
    if (initialize && existsSync(resolved) && readFileSync(resolved, 'utf8').length !== 0)
      throw Error('ledger-existing: initialization cannot reset historical budget');
    fd = openSync(resolved, initialize ? 'ax+' : 'a+');
    // a+ must never silently initialize a missing historical budget.
    if (!initialize && readFileSync(resolved, 'utf8').length === 0)
      throw Error('ledger-missing-or-empty: reconcile before initialization');
    const commit = (state) => {
      if (poisoned || closed || corrupted) throw Error('ledger-durability-unavailable');
      const payload = { format: 1, sequence: sequence + 1, previous, state };
      const digest = hash(payload);
      const bytes = Buffer.from(`${needsNewline ? '\n' : ''}${JSON.stringify({ ...payload, digest })}\n`);
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const count = write(fd, bytes, offset, bytes.length - offset, null);
          if (!Number.isInteger(count) || count <= 0) throw Error('short-journal-write');
          offset += count;
        }
        sync(fd);
        sequence = payload.sequence;
        previous = digest;
        history.push(structuredClone(state));
        needsNewline = false;
      } catch {
        poisoned = true;
        throw Error('ledger-durability-unavailable');
      }
    };
    let state;
    if (initialize) {
      state = new Ledger().state;
      commit(state);
    } else {
      const contents = readFileSync(resolved, 'utf8');
      const lines = contents.split('\n').filter((line) => line.trim() !== '');
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          if (sequence === 0 && previous === null && record.version === 1) {
            // Retain the old single-checkpoint format without overwriting it.
            state = new Ledger(record).state;
            previous = hash(record);
            completeHashChain = false;
            history.push(structuredClone(record));
          } else {
            const { digest, ...payload } = record;
            if (
              record.format !== 1 ||
              record.sequence !== sequence + 1 ||
              record.previous !== previous ||
              hash(payload) !== digest
            )
              throw Error('corrupt-journal');
            state = new Ledger(record.state).state;
            sequence = record.sequence;
            previous = digest;
            history.push(structuredClone(record.state));
          }
        } catch {
          corrupted = true;
          break;
        }
      }
      if (!state) throw Error('ledger-corrupt: no recoverable checkpoint');
      if (corrupted) state.halted = true;
      needsNewline = !contents.endsWith('\n');
      // Verify the operating system can flush this ledger before exposing real mode.
      try {
        sync(fd);
      } catch {
        poisoned = true;
        throw Error('ledger-durability-unavailable');
      }
    }
    return {
      state,
      commit,
      close: release,
      get poisoned() {
        return poisoned;
      },
      get corrupted() {
        return corrupted;
      },
      get completeHashChain() {
        return completeHashChain && !corrupted;
      },
      get firstTruncationHistoryEligible() {
        return completeHashChain && !corrupted && eligibleFirstTruncationHistory(history);
      },
      get checkpointHash() {
        return corrupted ? null : previous;
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
