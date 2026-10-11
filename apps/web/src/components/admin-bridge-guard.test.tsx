import { describe, expect, it, vi } from 'vitest';
import { useAdminChat } from '../lib/admin';

const pending = vi.hoisted(() => ({ save: vi.fn(), reset: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    let value = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [
      value,
      (next: unknown) => {
        value = typeof next === 'function' ? (next as (old: unknown) => unknown)(value) : next;
      },
    ];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock('../lib/bridge-store', () => ({
  loadBridge: () => ({ prompt: 'pending reply' }),
  saveBridge: pending.save,
}));
vi.mock('../lib/stream-store', () => ({
  resetStreamState: pending.reset,
  setStreamState: () => {},
  handoffStreamState: () => {},
}));

describe('administrator bridge guard', () => {
  it('does not replace a pending bridge when a second send is attempted', () => {
    const appendMessages = vi.fn(() => new Promise<void>(() => {}));
    const api = useAdminChat({
      db: {} as never,
      session: {
        world: { id: 'room-1', playerName: 'Player' },
        conversation: { id: 'conversation-1', kind: 'side' },
        messages: [],
        appendMessages,
      } as never,
      providers: { active: { model: 'fixture' }, apiKey: '' } as never,
      onChanged: () => {},
    });
    void api.send('another request');
    expect(appendMessages).not.toHaveBeenCalled();
    expect(pending.reset).not.toHaveBeenCalled();
    expect(api.bridge).toEqual({ prompt: 'pending reply' });
  });
});
