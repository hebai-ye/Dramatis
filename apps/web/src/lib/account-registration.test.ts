import { openSpace, type RemoteSpaceInput, type WrappedKey } from '@dramatis/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAccount } from './account-auth';
import { SYNC_CONFIG_META_KEY } from './sync';

const storage = vi.hoisted(() => ({
  events: [] as string[],
  records: new Map<string, Array<{ collection: string; id: string; value: unknown }>>(),
  failConfigWrite: false,
}));

// Keep the real registration, registry and EntityStore code; replace only IndexedDB I/O.
vi.mock('idb', () => ({
  async openDB(name: string) {
    storage.events.push('open-local-database');
    return {
      close() {
        storage.events.push('close-local-database');
      },
      async put(_store: string, record: { collection: string; id: string; value: unknown }) {
        storage.events.push('write-sync-config');
        if (storage.failConfigWrite) throw new Error('fixture: IndexedDB write denied');
        storage.records.set(name, [...(storage.records.get(name) ?? []), record]);
      },
    };
  },
}));

const endpoint = 'https://fixture.invalid/sync';
const input = {
  endpoint,
  accountId: 'fixture-registration',
  name: '注册测试账户',
  password: 'fixture-password',
};
const recoveryMessage = '服务器账户已创建，请先保存恢复码并检查本机存储后登录';
let values: Map<string, string>;
let remoteInput: RemoteSpaceInput | null;
let remoteStatus: 'created' | 'exists' | 'rejected';

beforeEach(() => {
  storage.events.length = 0;
  storage.records.clear();
  storage.failConfigWrite = false;
  values = new Map();
  remoteInput = null;
  remoteStatus = 'created';
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('indexedDB', { databases: async () => [] });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    if (url === `${endpoint}/spaces` && options?.method === 'POST') {
      remoteInput = JSON.parse(String(options.body)) as RemoteSpaceInput;
      storage.events.push(`remote-${remoteStatus}`);
      if (remoteStatus === 'exists') return new Response('', { status: 409 });
      if (remoteStatus === 'rejected') {
        return Response.json(
          { error: { code: 'forbidden', message: 'fixture: registration denied' } },
          { status: 403 },
        );
      }
      return Response.json({ status: 'created' }, { status: 201 });
    }
    if (url === `${endpoint}/accounts/claim`) {
      storage.events.push('claim-profile');
      return new Response('', { status: 404 });
    }
    throw new Error('Unexpected fixture request');
  });
});

afterEach(() => vi.unstubAllGlobals());

function delivery(codes: string[]) {
  return (code: string) => {
    storage.events.push('deliver-recovery-code');
    codes.push(code);
  };
}

async function verifyRecoveryCode(code: string) {
  // Exercise the real WebCrypto unwrap, proving this is the code for the remote space.
  expect(globalThis.crypto.subtle).toBeDefined();
  if (remoteInput === null) throw new Error('Remote space was not created');
  const opened = await openSpace({
    spaceHandle: remoteInput.spaceHandle,
    purpose: 'recovery',
    secret: code,
    wrapped: remoteInput.keyWraps.recovery as WrappedKey,
  });
  expect(opened.credentialHash).toBe(remoteInput.recoveryCredentialHash);
  expect([...values.values()].some((value) => value.includes(code))).toBe(false);
  expect(JSON.stringify([...storage.records.values()])).not.toContain(code);
}

describe('远端注册成功后的恢复码交付', () => {
  it('本机配置拒写前已交付可解锁远端空间的恢复码，并说明如何继续登录', async () => {
    storage.failConfigWrite = true;
    const codes: string[] = [];
    const error = await registerAccount({ ...input, profileConsent: true, onRecoveryCode: delivery(codes) }).catch(
      (reason: unknown) => reason,
    );
    expect(codes).toHaveLength(1);
    expect(storage.events).toEqual([
      'remote-created',
      'deliver-recovery-code',
      'claim-profile',
      'open-local-database',
      'write-sync-config',
      'close-local-database',
    ]);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(recoveryMessage);
    expect((error as Error).message).toContain('fixture: IndexedDB write denied');
    await verifyRecoveryCode(codes[0] as string);
  });

  it('未解锁本机口令库拒绝保存密码时仍已交付恢复码，并保留实际错误', async () => {
    const codes: string[] = [];
    const error = await registerAccount({ ...input, keyMode: 'encrypted', onRecoveryCode: delivery(codes) }).catch(
      (reason: unknown) => reason,
    );
    expect(codes).toHaveLength(1);
    expect(storage.events.indexOf('deliver-recovery-code')).toBeLessThan(storage.events.indexOf('write-sync-config'));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(recoveryMessage);
    expect((error as Error).message).toContain('口令库还没解锁');
    await verifyRecoveryCode(codes[0] as string);
  });

  it.each(['exists', 'rejected'] as const)('远端返回 %s 时不交付未被服务端接受的新恢复码', async (status) => {
    remoteStatus = status;
    const codes: string[] = [];
    await expect(registerAccount({ ...input, onRecoveryCode: delivery(codes) })).rejects.toThrow();
    expect(codes).toEqual([]);
    expect(storage.events).toEqual([`remote-${status}`]);
    expect(storage.records.size).toBe(0);
  });

  it('注册成功只提前交付一次，正常返回同一恢复码与原有账户结果', async () => {
    const codes: string[] = [];
    const result = await registerAccount({ ...input, onRecoveryCode: delivery(codes) });
    expect(codes).toEqual([result.recoveryCode]);
    expect(result.account.accountId).toBe(input.accountId);
    expect(result.profileWarning).toBeNull();
    expect(storage.events.indexOf('deliver-recovery-code')).toBeLessThan(storage.events.indexOf('open-local-database'));
    const records = storage.records.get(result.account.dbName) ?? [];
    expect(records).toEqual([
      expect.objectContaining({
        collection: 'meta',
        id: SYNC_CONFIG_META_KEY,
        value: { id: SYNC_CONFIG_META_KEY, value: expect.objectContaining({ endpoint }) },
      }),
    ]);
    await verifyRecoveryCode(codes[0] as string);
  });
});
