import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDatabase } from '../lib/session';

const bootHarness = vi.hoisted(() => {
  let values: unknown[] = [];
  let cursor = 0;
  let finish: () => void = () => {};
  const effects: (() => undefined | (() => void))[] = [];
  return {
    effects,
    reset() {
      values = [];
      cursor = 0;
      effects.length = 0;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    begin() {
      cursor = 0;
    },
    state(initial: unknown) {
      const index = cursor++;
      if (!(index in values)) values[index] = initial;
      return [
        values[index],
        (next: unknown) => {
          values[index] = next;
          if (index === 1 || index === 2) finish();
        },
      ];
    },
    recover: vi.fn(),
    opened: {
      backendKind: 'indexeddb',
      repository: { migrate: vi.fn(async () => ({ applied: [] })) },
      queue: { recoverInterrupted: vi.fn(async () => 0) },
    },
  };
});

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: bootHarness.state,
  useEffect: (effect: () => undefined | (() => void)) => bootHarness.effects.push(effect),
}));
vi.mock('@dramatis/core', async (original) => ({
  ...(await original<typeof import('@dramatis/core')>()),
  recoverInterruptedImports: bootHarness.recover,
}));
vi.mock('../lib/db', () => ({
  openDramatisDb: async () => bootHarness.opened,
  pendingAccountDeletionCount: () => 0,
}));

function render() {
  bootHarness.begin();
  // biome-ignore lint/correctness/useHookAtTopLevel: controlled render entry for the real database hook.
  return useDatabase();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('database import recovery reporting', () => {
  it('loads readable data after an unknown recovery error without retrying or claiming preservation', async () => {
    const finished = bootHarness.reset();
    bootHarness.recover.mockRejectedValueOnce(new Error('PRIVATE MARKER DATA'));
    render();
    const effect = bootHarness.effects[0];
    if (!effect) throw new Error('boot effect missing');
    const cleanup = effect();
    try {
      await finished;
      const result = render();
      expect(result.db).toBe(bootHarness.opened);
      expect(result.error).toBeNull();
      expect(result.boot?.recoveredImports).toBe(0);
      expect(result.boot?.importRecoveryWarnings).toEqual([
        {
          code: 'import-recovery-failed',
          message: '导入恢复检查未完成。已继续加载可读取的本机数据，请检查现有世界和导入记录。',
        },
      ]);
      expect(bootHarness.recover).toHaveBeenCalledTimes(1);
    } finally {
      cleanup?.();
    }
  });

  it('passes real structured warning fields into BootReport and counts returned rooms only', async () => {
    const finished = bootHarness.reset();
    bootHarness.recover.mockResolvedValueOnce({
      rooms: ['rolled-back-room'],
      stillPending: 3,
      warnings: [{ code: 'invalid-marker', message: '导入标记需要检查。', markerId: 'marker-1' }],
    });
    render();
    const effect = bootHarness.effects[0];
    if (!effect) throw new Error('boot effect missing');
    const cleanup = effect();
    try {
      await finished;
      const result = render();
      expect(result.boot?.recoveredImports).toBe(1);
      expect(result.boot?.importRecoveryWarnings).toEqual([
        {
          code: 'invalid-marker',
          message: '导入标记需要检查。',
          markerId: 'marker-1',
        },
      ]);
    } finally {
      cleanup?.();
    }
  });
});
