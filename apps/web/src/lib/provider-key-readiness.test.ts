import { createMemoryEntityStore, createProviderProfile, createVault, Repository } from '@dramatis/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramatisDb } from './db';
import { useProviders } from './providers';

// Execute the real hook with controlled scheduling; only React scheduling and the
// asynchronous keystore I/O are fixtures. Repository writes use the real core store.
const hooks = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  let effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  let effectCursor = 0;
  let pending: (() => void)[] = [];
  const same = (left?: readonly unknown[], right?: readonly unknown[]) =>
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((value, i) => value === right[i]);
  return {
    reset() {
      for (const effect of effects) effect.cleanup?.();
      slots = [];
      effects = [];
      pending = [];
    },
    begin() {
      cursor = 0;
      effectCursor = 0;
    },
    flush() {
      const work = pending;
      pending = [];
      for (const run of work) run();
    },
    state(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (next: unknown) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        },
      ];
    },
    memo(create: () => unknown, deps?: readonly unknown[]) {
      const index = cursor++;
      const previous = slots[index] as { deps?: readonly unknown[]; value: unknown } | undefined;
      if (!previous || !same(previous.deps, deps)) slots[index] = { deps, value: create() };
      return (slots[index] as { value: unknown }).value;
    },
    effect(run: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (!previous || !same(previous.deps, deps))
        pending.push(() => {
          previous?.cleanup?.();
          effects[index] = { deps, cleanup: run() };
        });
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: hooks.state,
  useRef: (initial: unknown) => hooks.state(() => ({ current: initial }))[0],
  useMemo: hooks.memo,
  useCallback: (callback: unknown, deps: readonly unknown[]) => hooks.memo(() => callback, deps),
  useEffect: hooks.effect,
}));

const keys = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  pending: new Map<string, Promise<string | null>>(),
  pendingWrites: new Map<string, Promise<void>>(),
  writes: [] as { ref: string; value: string }[],
  useActualDevice: false,
  useActualSession: false,
  useActualVault: false,
}));
vi.mock('./keystore', async (original) => {
  const actual = await original<typeof import('./keystore')>();
  return {
    hasBrowserVault: async () => (keys.useActualVault ? actual.hasBrowserVault() : false),
    browserVaultStorage: () => {
      if (keys.useActualVault) return actual.browserVaultStorage();
      throw new Error('Not used in this fixture');
    },
    openBrowserVault: async (passphrase: string) => {
      if (keys.useActualVault) return actual.openBrowserVault(passphrase);
      throw new Error('Not used in this fixture');
    },
    createBrowserKeyStore: (
      mode: 'session' | 'device' | 'encrypted',
      vault: import('./keystore').VaultSession | null = null,
      options?: { strictRead?: boolean },
    ) =>
      (mode === 'device' && keys.useActualDevice) ||
      (mode === 'session' && keys.useActualSession) ||
      (mode === 'encrypted' && keys.useActualVault)
        ? actual.createBrowserKeyStore(mode, vault, options)
        : {
            kind: mode === 'device' ? 'plain' : 'memory',
            get: (ref: string) =>
              keys.pending.get(`${mode}:${ref}`) ?? Promise.resolve(keys.secrets.get(`${mode}:${ref}`) ?? null),
            async set(ref: string, value: string) {
              await keys.pendingWrites.get(ref);
              keys.writes.push({ ref, value });
              keys.secrets.set(`${mode}:${ref}`, value);
            },
            async remove(ref: string) {
              keys.writes.push({ ref, value: '' });
              keys.secrets.delete(`${mode}:${ref}`);
            },
          },
  };
});

const sync = {
  config: null,
  status: 'off' as const,
  requestAutoSync: () => {},
  sealSecret: async () => null,
  openSecret: async () => null,
};
let db: DramatisDb;
let first: ReturnType<typeof createProviderProfile>;
let second: ReturnType<typeof createProviderProfile>;

function render(flush = true) {
  hooks.begin();
  // biome-ignore lint/correctness/useHookAtTopLevel: controlled test renderer executes the real hook in the same order on each scheduled render
  const result = useProviders(db, sync);
  if (flush) hooks.flush();
  return result;
}

async function settle() {
  let api = render();
  for (let i = 0; i < 15; i += 1) {
    await Promise.resolve();
    api = render();
  }
  return api;
}

function pause(mode: string, ref: string) {
  let resolve: (value: string | null) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<string | null>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  keys.pending.set(`${mode}:${ref}`, promise);
  return { resolve, reject };
}

beforeEach(async () => {
  hooks.reset();
  keys.secrets.clear();
  keys.pending.clear();
  keys.pendingWrites.clear();
  keys.writes = [];
  keys.useActualDevice = false;
  keys.useActualSession = false;
  keys.useActualVault = false;
  first = { ...createProviderProfile({ name: 'A', model: 'a', baseUrl: 'https://a.invalid/v1' }), active: true };
  second = createProviderProfile({ name: 'B', model: 'b', baseUrl: 'https://b.invalid/v1' });
  const repository = new Repository(createMemoryEntityStore());
  await repository.saveProviderProfile(first);
  await repository.saveProviderProfile(second);
  await repository.setMeta('provider.activeId', first.id);
  db = { repository } as DramatisDb;
  keys.secrets.set(`device:${first.keyRef}`, 'fixture-key-a');
  keys.secrets.set(`device:${second.keyRef}`, 'fixture-key-b');
});

afterEach(() => vi.unstubAllGlobals());

describe('provider key readiness across configuration changes', () => {
  it('protects a real encrypted key until unlocking and reading it', async () => {
    keys.useActualVault = true;
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const keystore = await import('./keystore');
    await createVault(keystore.browserVaultStorage(), 'fixture-passphrase');
    const vault = await keystore.openBrowserVault('fixture-passphrase');
    await vault.store.set(first.keyRef, 'fixture-encrypted-key');
    await db.repository.setMeta('provider.keyMode', 'encrypted');
    let api = await settle();
    expect(api.vaultLocked).toBe(true);
    await expect(
      api.commitConfig({
        profile: { name: 'Renamed' },
        apiKey: '',
        keyMode: 'encrypted',
        vaultPassphrase: 'fixture-passphrase',
      }),
    ).rejects.toThrow('尚未解锁');
    expect(await vault.store.get(first.keyRef)).toBe('fixture-encrypted-key');
    await api.unlockVault('fixture-passphrase');
    api = await settle();
    // Real WebCrypto completion crosses microtasks; allow that asynchronous read to finish.
    await vi.waitFor(async () => {
      api = await settle();
      expect(api.apiKey).toBe('fixture-encrypted-key');
    });
    expect(api.vaultLocked).toBe(false);
  });
  it('keeps B ready when a delayed A key write finishes after selection', async () => {
    let api = await settle();
    let finish: () => void = () => {};
    keys.pendingWrites.set(
      first.keyRef,
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const saving = api.setApiKey('fixture-delayed-a');
    await api.selectProfile(second.id);
    api = await settle();
    finish();
    await saving;
    api = await settle();
    expect(api.apiKey).toBe('fixture-key-b');
    expect(api.keyLoading).toBe(false);
  });
  it('does not replace B readiness when a delayed A save finishes after B was selected', async () => {
    await db.repository.saveProviderProfile({ ...first, role: 'background' });
    let api = await settle();
    let finish: () => void = () => {};
    keys.pendingWrites.set(
      first.keyRef,
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const saving = api.commitConfig({
      profile: { baseUrl: 'https://changed.invalid/v1' },
      apiKey: 'fixture-delayed-a',
      keyMode: 'device',
    });
    await api.selectProfile(second.id);
    api = await settle();
    expect(api.apiKey).toBe('fixture-key-b');
    finish();
    await saving.catch(() => {});
    api = await settle();
    expect(api.apiKey).toBe('fixture-key-b');
    expect(api.keyLoading).toBe(false);
    expect(api.background?.baseUrl).toBe('https://changed.invalid/v1');
    expect(api.background?.apiKey).toBe('fixture-delayed-a');
  });
  it('rereads B from the new account-wide mode when selection changes during mode persistence', async () => {
    let api = await settle();
    const originalSetMeta = db.repository.setMeta.bind(db.repository);
    let finish: () => void = () => {};
    let entered: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const modeWriteStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(db.repository, 'setMeta').mockImplementation(async (key, value) => {
      if (key === 'provider.keyMode') {
        entered();
        await waiting;
      }
      return originalSetMeta(key, value);
    });
    keys.secrets.set(`session:${second.keyRef}`, 'fixture-session-b');
    const saving = api.commitConfig({ profile: {}, apiKey: 'fixture-session-a', keyMode: 'session' });
    await modeWriteStarted;
    await api.selectProfile(second.id);
    api = await settle();
    finish();
    await saving;
    api = await settle();
    expect(api.activeId).toBe(second.id);
    expect(api.keyMode).toBe('session');
    expect(api.apiKey).toBe('fixture-session-b');
    expect(api.keyLoading).toBe(false);
  });
  it('surfaces a real device storage read denial and can reread after storage recovers', async () => {
    keys.useActualDevice = true;
    let denied = true;
    const values = new Map([['dramatis.keys.v1', JSON.stringify({ [first.keyRef]: 'fixture-actual-device' })]]);
    vi.stubGlobal('localStorage', {
      getItem(key: string) {
        if (denied) throw new Error('fixture localStorage read denied');
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    let api = await settle();
    expect(api.keyLoading).toBe(false);
    expect(api.keyError).toContain('fixture localStorage read denied');
    expect(api.apiKey).toBe('');
    await expect(api.commitConfig({ profile: {}, apiKey: '', keyMode: 'device' })).rejects.toThrow(
      'fixture localStorage read denied',
    );
    denied = false;
    api.reloadApiKey();
    api = await settle();
    expect(api.keyError).toBeNull();
    expect(api.apiKey).toBe('fixture-actual-device');
  });

  it('keeps a saved real session key across mode changes and rereads', async () => {
    keys.useActualSession = true;
    let api = await settle();
    await api.commitConfig({ profile: {}, apiKey: 'fixture-session-saved', keyMode: 'session' });
    api = await settle();
    expect(api.apiKey).toBe('fixture-session-saved');
    api.reloadApiKey();
    api = await settle();
    expect(api.apiKey).toBe('fixture-session-saved');
  });

  it('updates the dedicated background key together with a new endpoint when saving in the same mode', async () => {
    await db.repository.saveProviderProfile({ ...first, role: 'background' });
    let api = await settle();
    expect(api.background?.apiKey).toBe('fixture-key-a');
    await api.commitConfig({
      profile: { baseUrl: 'https://changed.invalid/v1' },
      apiKey: 'fixture-updated-key',
      keyMode: 'device',
    });
    api = await settle();
    expect(api.background?.baseUrl).toBe('https://changed.invalid/v1');
    expect(api.background?.apiKey).toBe('fixture-updated-key');
  });

  it('hides A immediately on selection of B and rejects stale or current saves before B finishes reading', async () => {
    let api = await settle();
    expect(api.apiKey).toBe('fixture-key-a');
    const waiting = pause('device', second.keyRef);
    const staleApi = api;
    const selection = api.selectProfile(second.id);
    await expect(staleApi.commitConfig({ profile: {}, apiKey: 'fixture-key-a', keyMode: 'device' })).rejects.toThrow();
    api = render(false);
    expect(api.activeId).toBe(second.id);
    expect(api.apiKey).toBe('');
    expect(api.keyLoading).toBe(true);
    hooks.flush();
    await selection;
    api = await settle();
    await expect(
      api.commitConfig({ profile: { name: 'unsafe' }, apiKey: 'fixture-key-a', keyMode: 'device' }),
    ).rejects.toThrow();
    expect(keys.writes).toEqual([]);
    expect((await db.repository.listProviderProfiles()).find((profile) => profile.id === second.id)?.name).toBe('B');
    waiting.resolve('fixture-key-b');
    api = await settle();
    expect(api.apiKey).toBe('fixture-key-b');
    expect(api.keyLoading).toBe(false);
  });

  it('invalidates a ready device key before the session store has been read', async () => {
    let api = await settle();
    const waiting = pause('session', first.keyRef);
    const changing = api.setKeyMode('session');
    api = render(false);
    expect(api.apiKey).toBe('');
    expect(api.keyLoading).toBe(true);
    hooks.flush();
    await changing;
    api = await settle();
    await expect(api.commitConfig({ profile: {}, apiKey: 'fixture-key-a', keyMode: 'session' })).rejects.toThrow();
    expect(keys.writes).toEqual([]);
    waiting.resolve('fixture-session-key');
    api = await settle();
    expect(api.apiKey).toBe('fixture-session-key');
    expect(api.keyLoading).toBe(false);
  });

  it('reports a failed B read as an error, ends loading and rereads successfully on retry', async () => {
    let api = await settle();
    const waiting = pause('device', second.keyRef);
    await api.selectProfile(second.id);
    api = await settle();
    expect(api.keyLoading).toBe(true);
    waiting.reject(new Error('fixture key read denied'));
    api = await settle();
    expect(api.apiKey).toBe('');
    expect(api.keyLoading).toBe(false);
    expect(api.keyError).toContain('fixture key read denied');
    await expect(api.commitConfig({ profile: {}, apiKey: '', keyMode: 'device' })).rejects.toThrow(
      'fixture key read denied',
    );
    expect(keys.writes).toEqual([]);
    keys.pending.delete(`device:${second.keyRef}`);
    api.reloadApiKey();
    api = render(false);
    expect(api.keyLoading).toBe(true);
    expect(api.keyError).toBeNull();
    hooks.flush();
    api = await settle();
    expect(api.apiKey).toBe('fixture-key-b');
    expect(api.keyError).toBeNull();
    expect(api.keyLoading).toBe(false);
  });
});
