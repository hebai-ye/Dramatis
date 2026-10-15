import { createMemoryEntityStore, createProviderProfile, createVault, Repository } from '@dramatis/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramatisDb } from './db';
import { useProviders } from './providers';
import type { SyncApi } from './sync';

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

const sync: Pick<SyncApi, 'config' | 'status' | 'requestAutoSync' | 'sealSecret' | 'openSecret'> = {
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

function ownerOf(api: ReturnType<typeof useProviders>) {
  if (api.setupOwner === null) throw new Error('Fixture provider owner is not ready');
  return api.setupOwner;
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
  sync.config = null;
  sync.status = 'off';
  sync.sealSecret = async () => null;
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
  it('saves only the key of an existing DeepSeek profile and preserves its custom parameters', async () => {
    await db.repository.saveProviderProfile({ ...first, baseUrl: 'https://api.deepseek.com', model: 'custom-model' });
    let api = await settle();
    await api.saveDeepSeekKey('sk-fixture-new', ownerOf(api));
    api = await settle();
    expect(api.apiKey).toBe('sk-fixture-new');
    expect(api.active?.model).toBe('custom-model');
    expect(api.keyMode).toBe('device');
  });
  it('creates a separate DeepSeek target without changing another provider secret', async () => {
    let api = await settle();
    await api.setApiKey('');
    api = await settle();
    await api.saveDeepSeekKey('sk-fixture-deepseek', ownerOf(api));
    api = await settle();
    expect(api.active?.baseUrl).toBe('https://api.deepseek.com');
    expect(api.active?.model).toBe('deepseek-flash');
    expect(api.apiKey).toBe('sk-fixture-deepseek');
    expect(keys.secrets.get(`device:${second.keyRef}`)).toBe('fixture-key-b');
    expect((await db.repository.listProviderProfiles()).find((profile) => profile.id === first.id)?.baseUrl).toBe(
      'https://a.invalid/v1',
    );
  });
  it('rejects a draft whose opening owner changed before submission', async () => {
    let api = await settle();
    const owner = ownerOf(api);
    await api.selectProfile(second.id);
    api = await settle();
    let rejected = false;
    try {
      await api.saveDeepSeekKey('sk-fixture-old', owner);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(keys.writes).toEqual([]);
  });
  it('rejects an old opening owner after the same profile changes its endpoint', async () => {
    await db.repository.saveProviderProfile({ ...first, baseUrl: 'https://api.deepseek.com' });
    let api = await settle();
    const openingOwner = ownerOf(api);
    await api.updateProfile(first.id, { baseUrl: 'https://changed.invalid/v1' });
    api = await settle();
    await expect(api.saveDeepSeekKey('sk-fixture-old-endpoint', openingOwner)).rejects.toThrow('配置目标已变化');
    expect(keys.writes).toEqual([]);
  });
  it('restores the previous key when the endpoint changes while its key write is pending', async () => {
    await db.repository.saveProviderProfile({ ...first, baseUrl: 'https://api.deepseek.com' });
    let api = await settle();
    let entered: () => void = () => {};
    let finish: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    keys.pendingWrites.set(
      first.keyRef,
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    // Observe entry into the asynchronous write without changing the stored value.
    const originalGet = keys.pendingWrites.get.bind(keys.pendingWrites);
    vi.spyOn(keys.pendingWrites, 'get').mockImplementation((ref) => {
      entered();
      return originalGet(ref);
    });
    const saving = api.saveDeepSeekKey('sk-fixture-pending-endpoint', ownerOf(api));
    const rejected = expect(saving).rejects.toThrow('配置目标已变化');
    await started;
    await api.updateProfile(first.id, { baseUrl: 'https://changed.invalid/v1' });
    api = await settle();
    finish();
    await rejected;
    api = await settle();
    expect(keys.secrets.get(`device:${first.keyRef}`)).toBe('fixture-key-a');
    expect(api.apiKey).toBe('fixture-key-a');
    expect(api.active?.baseUrl).toBe('https://changed.invalid/v1');
    vi.restoreAllMocks();
  });
  it('checks the persisted endpoint even before a changed profile has rendered', async () => {
    await db.repository.saveProviderProfile({ ...first, baseUrl: 'https://api.deepseek.com' });
    const api = await settle();
    await db.repository.saveProviderProfile({ ...first, baseUrl: 'https://changed.invalid/v1' });
    await expect(api.saveDeepSeekKey('sk-fixture-stale-repository', ownerOf(api))).rejects.toThrow('配置目标已变化');
    expect(keys.writes).toEqual([]);
  });
  it('checks selection and active flags in one repository transaction before activating a separate target', async () => {
    const api = await settle();
    const original = db.repository.atomic.bind(db.repository);
    vi.spyOn(db.repository, 'atomic').mockImplementation(async (run) => {
      await db.repository.saveProviderProfile({ ...first, baseUrl: 'https://changed.invalid/v1' });
      return original(run);
    });
    await expect(api.saveDeepSeekKey('sk-fixture-selection-race', ownerOf(api))).rejects.toThrow('配置目标已变化');
    expect((await db.repository.listProviderProfiles()).find((item) => item.id === first.id)?.baseUrl).toBe(
      'https://changed.invalid/v1',
    );
    expect(await db.repository.getMeta('provider.activeId')).toBe(first.id);
    expect([...keys.secrets.values()]).not.toContain('sk-fixture-selection-race');
    vi.restoreAllMocks();
  });
  it('restores its own credential revision after the endpoint changes during credential persistence', async () => {
    await db.repository.saveProviderProfile({ ...first, baseUrl: 'https://api.deepseek.com' });
    let api = await settle();
    sync.config = {
      endpoint: 'https://sync.invalid',
      userId: 'fixture',
      spaceHandle: 'fixture',
      keyMode: 'device',
      createdAt: first.createdAt,
      lastSyncAt: null,
      lastReport: null,
    };
    sync.status = 'ready';
    sync.sealSecret = async () => ({ algorithm: 'AES-256-GCM', iv: 'fixture', ciphertext: 'fixture' });
    await vi.waitFor(async () => {
      api = await settle();
      expect((await db.repository.listProviderCredentials()).some((item) => item.id === first.keyRef)).toBe(true);
    });
    const previous = (await db.repository.listProviderCredentials()).find((item) => item.id === first.keyRef);
    let entered: () => void = () => {};
    let finish: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const original = db.repository.saveProviderCredential.bind(db.repository);
    vi.spyOn(db.repository, 'saveProviderCredential').mockImplementation(async (credential) => {
      if (credential.id === first.keyRef && credential.revision !== previous?.revision) {
        entered();
        await waiting;
      }
      await original(credential);
    });
    const saving = api.saveDeepSeekKey('sk-fixture-credential-race', ownerOf(api));
    const rejected = expect(saving).rejects.toThrow('配置目标已变化');
    await started;
    await api.updateProfile(first.id, { baseUrl: 'https://changed.invalid/v1' });
    await settle();
    finish();
    await rejected;
    expect(keys.secrets.get(`device:${first.keyRef}`)).toBe('fixture-key-a');
    expect((await db.repository.listProviderCredentials()).find((item) => item.id === first.keyRef)?.revision).toBe(
      previous?.revision,
    );
    vi.restoreAllMocks();
  });
  it('does not let an older alignment read recreate an aborted setup key credential', async () => {
    await db.repository.saveProviderProfile({ ...first, baseUrl: 'https://api.deepseek.com' });
    let api = await settle();
    const alignmentRead = pause('device', first.keyRef);
    sync.config = {
      endpoint: 'https://sync.invalid',
      userId: 'fixture',
      spaceHandle: 'fixture',
      keyMode: 'device',
      createdAt: first.createdAt,
      lastSyncAt: null,
      lastReport: null,
    };
    sync.status = 'ready';
    const sealed: string[] = [];
    sync.sealSecret = async (_ref, _revision, secret) => {
      sealed.push(secret);
      return { algorithm: 'AES-256-GCM', iv: 'fixture', ciphertext: 'fixture' };
    };
    api = await settle();
    keys.pending.delete(`device:${first.keyRef}`);
    let entered: () => void = () => {};
    let finish: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    keys.pendingWrites.set(
      first.keyRef,
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const originalGet = keys.pendingWrites.get.bind(keys.pendingWrites);
    vi.spyOn(keys.pendingWrites, 'get').mockImplementation((ref) => {
      entered();
      return originalGet(ref);
    });
    const saving = api.saveDeepSeekKey('sk-fixture-late-alignment', ownerOf(api));
    const rejected = expect(saving).rejects.toThrow('配置目标已变化');
    await started;
    await api.updateProfile(first.id, { baseUrl: 'https://changed.invalid/v1' });
    await settle();
    finish();
    await rejected;
    alignmentRead.resolve('sk-fixture-late-alignment');
    await settle();
    expect(sealed).not.toContain('sk-fixture-late-alignment');
    expect(keys.secrets.get(`device:${first.keyRef}`)).toBe('fixture-key-a');
    vi.restoreAllMocks();
  });
  it('does not confirm a write when the real key-store reread fails, and reuses the target on retry', async () => {
    let api = await settle();
    const owner = ownerOf(api);
    const originalProfiles = await db.repository.listProviderProfiles();
    const originalSave = db.repository.saveProviderProfile.bind(db.repository);
    let targetRef = '';
    vi.spyOn(db.repository, 'saveProviderProfile').mockImplementation(async (profile) => {
      if (!originalProfiles.some((item) => item.id === profile.id)) {
        targetRef = profile.keyRef;
        keys.pending.set(`device:${targetRef}`, Promise.reject(new Error('fixture reread denied')));
        keys.pending.get(`device:${targetRef}`)?.catch(() => {});
      }
      await originalSave(profile);
    });
    let rejected = false;
    try {
      await api.saveDeepSeekKey('sk-fixture-retry', owner);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(api.activeId).toBe(first.id);
    keys.pending.delete(`device:${targetRef}`);
    vi.restoreAllMocks();
    await api.saveDeepSeekKey('sk-fixture-retry', owner);
    api = await settle();
    expect(api.apiKey).toBe('sk-fixture-retry');
    expect((await db.repository.listProviderProfiles()).length).toBe(originalProfiles.length + 1);
  });
  it('saves in an unlocked encrypted store without requesting a second passphrase', async () => {
    keys.useActualVault = true;
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const keystore = await import('./keystore');
    await createVault(keystore.browserVaultStorage(), 'fixture-passphrase');
    await db.repository.saveProviderProfile({ ...first, baseUrl: 'https://api.deepseek.com' });
    await db.repository.setMeta('provider.keyMode', 'encrypted');
    let api = await settle();
    await api.unlockVault('fixture-passphrase');
    await vi.waitFor(async () => {
      api = await settle();
      expect(api.keyLoading).toBe(false);
    });
    await api.saveDeepSeekKey('sk-fixture-encrypted-new', ownerOf(api));
    await vi.waitFor(async () => {
      api = await settle();
      expect(api.apiKey).toBe('sk-fixture-encrypted-new');
    });
    expect(api.keyMode).toBe('encrypted');
    const opened = await keystore.openBrowserVault('fixture-passphrase');
    expect(await opened.store.get(first.keyRef)).toBe('sk-fixture-encrypted-new');
  });
  it('keeps session storage when saving a separate DeepSeek target', async () => {
    keys.useActualSession = true;
    let api = await settle();
    await api.setKeyMode('session');
    api = await settle();
    await api.saveDeepSeekKey('sk-fixture-session-deepseek', ownerOf(api));
    api = await settle();
    api.reloadApiKey();
    api = await settle();
    expect(api.keyMode).toBe('session');
    expect(api.apiKey).toBe('sk-fixture-session-deepseek');
    expect(keys.writes).toEqual([]);
  });
  it('rejects invalid numeric config before writing the saved key or profile', async () => {
    const api = await settle();
    const savedProfiles = await db.repository.listProviderProfiles();
    await expect(
      api.commitConfig({
        profile: { price: { inputPerMillion: -1, outputPerMillion: 0, currency: '¥' } },
        apiKey: 'replacement',
        keyMode: 'device',
      }),
    ).rejects.toThrow('输入价');
    expect(keys.secrets.get(`device:${first.keyRef}`)).toBe('fixture-key-a');
    expect(await db.repository.listProviderProfiles()).toEqual(savedProfiles);
  });
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
