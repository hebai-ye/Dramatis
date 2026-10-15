import { beforeEach, expect, it, vi } from 'vitest';
import { useLibraryNavigation } from './useLibraryWorkspace';

const host = vi.hoisted(() => {
  let values: unknown[] = [];
  let cursor = 0;
  return {
    begin() {
      cursor = 0;
    },
    reset() {
      values = [];
    },
    ref(value: unknown) {
      const i = cursor++;
      values[i] ??= { current: value };
      return values[i];
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: host.ref,
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useLayoutEffect: (run: () => void) => run(),
}));
function navigation(beforeNavigate: () => Promise<boolean>) {
  host.begin();
  // biome-ignore lint/correctness/useHookAtTopLevel: controlled no-DOM host exercises the real navigation hook.
  return useLibraryNavigation(
    { world: null, conversation: null, openWorld: vi.fn(), openConversation: vi.fn() },
    null,
    false,
    vi.fn(),
    vi.fn(),
    beforeNavigate,
  );
}
beforeEach(() => host.reset());
it('failed Runtime saves prevent the import action before choosing or reading a file', async () => {
  const importAction = vi.fn(async () => ({ ok: true }));
  const result = await navigation(async () => false).navigateImported(importAction);
  expect(importAction).not.toHaveBeenCalled();
  expect(result).toBeNull();
});
it('slow Runtime saves finish before the import action starts', async () => {
  let finish!: (value: boolean) => void;
  const guard = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const importAction = vi.fn(async () => null);
  const pending = navigation(() => guard).navigateImported(importAction);
  await Promise.resolve();
  expect(importAction).not.toHaveBeenCalled();
  finish(true);
  await pending;
  expect(importAction).toHaveBeenCalledTimes(1);
});
