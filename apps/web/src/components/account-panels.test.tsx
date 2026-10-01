import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountAuthResult, RegisterAccountInput } from '../lib/account-auth';
import type { AccountDeletionResult } from '../lib/account-deletion';
import { createAccount, readAccountRegistry, removeAccount } from '../lib/db';
import { createDialogController, type DialogGuard } from '../lib/dialog-controller';
import type { SyncApi } from '../lib/sync';
import { AccountPanel } from './AccountPanel';
import { SyncPanel } from './SyncPanel';

const dialog = vi.hoisted(() => ({
  requestAction: (_action: () => void) => {},
  setGuard: (_guard: DialogGuard | null) => {},
}));
const remote = vi.hoisted(() => ({
  register: async (
    _input: RegisterAccountInput & { onRecoveryCode?: (code: string) => void },
  ): Promise<AccountAuthResult> => {
    throw new Error('not configured');
  },
  login: async (): Promise<AccountAuthResult> => {
    throw new Error('not configured');
  },
  read: async () => ({
    configured: true,
    unlocked: false,
    lastSyncAt: null,
    endpoint: 'https://custom.fixture.invalid/sync',
  }),
  remove: async (): Promise<AccountDeletionResult> => {
    throw new Error('not configured');
  },
}));
vi.mock('./DialogShell', () => ({ useDialogActions: () => dialog }));
vi.mock('../lib/account-auth', async (original) => ({
  ...(await original<typeof import('../lib/account-auth')>()),
  registerAccount: (input: RegisterAccountInput) => remote.register(input),
  loginAccount: () => remote.login(),
  readAccountSyncInfo: () => remote.read(),
}));
vi.mock('../lib/account-deletion', () => ({ deleteAccountLocally: () => remote.remove() }));

// No DOM runtime is installed. Keep actual handlers, local registry and dialog
// controller; substitute hooks to observe render trees and async transitions.
const hooks = vi.hoisted(() => {
  let values: unknown[] = [];
  let effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0;
  let effectCursor = 0;
  let pending: (() => void)[] = [];
  return {
    reset() {
      for (const effect of effects) effect.cleanup?.();
      values = [];
      effects = [];
      pending = [];
    },
    begin() {
      cursor = 0;
      effectCursor = 0;
    },
    flush() {
      const next = pending;
      pending = [];
      for (const action of next) action();
    },
    state(initial: unknown) {
      const index = cursor++;
      if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
      return [
        values[index],
        (next: unknown) => {
          values[index] = typeof next === 'function' ? next(values[index]) : next;
        },
      ];
    },
    memo(value: unknown, deps: readonly unknown[]) {
      const index = cursor++;
      const previous = values[index] as { value: unknown; deps: readonly unknown[] } | undefined;
      if (!previous || deps.some((item, i) => previous.deps[i] !== item)) values[index] = { value, deps };
      return (values[index] as { value: unknown }).value;
    },
    effect(action: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (!previous || !deps || !previous.deps || deps.some((item, i) => previous.deps?.[i] !== item))
        pending.push(() => {
          previous?.cleanup?.();
          effects[index] = { deps, cleanup: action() };
        });
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: hooks.state,
  useEffect: hooks.effect,
  useCallback: hooks.memo,
  useRef: (initial: unknown) => {
    const [ref] = hooks.state(() => ({ current: initial }));
    return ref;
  },
}));

let controller: ReturnType<typeof createDialogController>;
let reloads = 0;
let storageRejectWrites = false;
const render = (component: () => ReactNode): ReactNode => {
  hooks.begin();
  component();
  hooks.flush();
  hooks.begin();
  const tree = component();
  hooks.flush();
  return tree;
};
const settle = async () => {
  for (let i = 0; i < 15; i += 1) await Promise.resolve();
};
function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ReactElement<Record<string, unknown>>;
  return [element, ...nodes(element.props.children as ReactNode)];
}
function textOf(tree: ReactNode): string {
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return textOf((tree as ReactElement<{ children: ReactNode }>).props.children);
}
function button(tree: ReactNode, label: string, index = 0): ReactElement<Record<string, unknown>> {
  const found = nodes(tree).filter(
    (node) => node.type === 'button' && textOf(node.props.children as ReactNode) === label,
  )[index];
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function click(node: ReactElement<Record<string, unknown>>): unknown {
  return (node.props.onClick as (event: unknown) => unknown)({ currentTarget: { focus() {} } });
}
function changeField(tree: ReactNode, label: string, value: string): void {
  const field = nodes(tree).find((node) => node.type === 'label' && textOf(node).startsWith(label));
  const input =
    nodes(field).find((node) => node.type === 'input') ??
    nodes(tree).find((node) => node.type === 'input' && node.props.id === field?.props.htmlFor);
  if (!input) throw new Error(`Missing input: ${label}`);
  (input.props.onChange as (event: unknown) => void)({ target: { value } });
}
function submit(tree: ReactNode, label: string): unknown {
  const form = nodes(tree).find(
    (node) => node.type === 'form' && nodes(node).some((child) => child.type === 'button' && textOf(child) === label),
  );
  if (!form) throw new Error(`Missing form: ${label}`);
  return (form.props.onSubmit as (event: unknown) => unknown)({ preventDefault() {} });
}
function fixtureSync(): SyncApi {
  return {
    config: {
      endpoint: 'https://fixture.invalid/sync',
      userId: 'fixture-account',
      spaceHandle: 'fixture-handle',
      keyMode: 'device',
      createdAt: '2026-10-01T00:00:00Z',
      lastSyncAt: null,
      lastReport: null,
    },
    status: 'ready',
    busy: false,
    error: null,
    errorStatus: null,
    recoveryCode: null,
    autoSyncPending: false,
    spaceFull: false,
    dismissRecoveryCode: () => {},
    connect: async () => {},
    syncNow: async () => {},
    resync: async () => {},
    requestAutoSync: () => {},
    disconnect: async () => {},
    setKeyMode: async () => {},
    listDevices: async () => ({ devices: [], localDeviceId: 'fixture-device' }),
    rotatePassword: async () => {},
    exportSnapshot: async () => null,
    restoreSnapshot: async () => ({ pushed: 0, head: 0 }),
    sealSecret: async () => null,
    openSecret: async () => null,
  };
}
beforeEach(() => {
  hooks.reset();
  controller = createDialogController();
  dialog.requestAction = controller.request;
  dialog.setGuard = controller.setGuard;
  const values = new Map<string, string>();
  storageRejectWrites = false;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storageRejectWrites) throw new Error('fixture storage failed');
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
  });
  reloads = 0;
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      location: {
        origin: 'https://fixture.invalid',
        reload: () => {
          reloads += 1;
        },
      },
    }),
  );
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('indexedDB', {
    databases: async () => readAccountRegistry().accounts.map((account) => ({ name: account.dbName })),
  });
  vi.stubGlobal('requestAnimationFrame', (action: () => void) => action());
  remote.read = async () => ({
    configured: true,
    unlocked: false,
    lastSyncAt: null,
    endpoint: 'https://custom.fixture.invalid/sync',
  });
});

describe('账户真实界面流程', () => {
  it('注册远端成功但本机保存失败，仍显示恢复码并阻止关闭', async () => {
    remote.register = async (input) => {
      input.onRecoveryCode?.('fixture-partial-recovery');
      throw new Error('fixture local write failed');
    };
    let tree = render(() => AccountPanel({ disabled: false }));
    await settle();
    tree = render(() => AccountPanel({ disabled: false }));
    click(button(tree, '＋ 添加账户'));
    tree = render(() => AccountPanel({ disabled: false }));
    changeField(tree, '账户 ID', 'partial-fixture');
    changeField(tree, '账户密码', 'long-fixture-password');
    changeField(tree, '再次输入密码', 'long-fixture-password');
    tree = render(() => AccountPanel({ disabled: false }));
    submit(tree, '注册账户');
    await settle();
    tree = render(() => AccountPanel({ disabled: false }));
    expect(textOf(tree)).toContain('fixture-partial-recovery');
    expect(textOf(tree)).toContain('fixture local write failed');
    let left = false;
    controller.request(() => {
      left = true;
    });
    expect(left).toBe(false);
    expect(controller.state().pending?.guard.kind).toBe('recovery');
  });

  it('注册后关闭需要恢复码确认，取消后码仍在，复制不可用给手动保存提示', async () => {
    remote.register = async () => ({
      account: createAccount({ accountId: 'new-fixture', name: 'New' }),
      recoveryCode: 'fixture-recovery',
      profileWarning: null,
    });
    let tree = render(() => AccountPanel({ disabled: false }));
    await settle();
    tree = render(() => AccountPanel({ disabled: false }));
    click(button(tree, '＋ 添加账户'));
    tree = render(() => AccountPanel({ disabled: false }));
    changeField(tree, '账户 ID', 'new-fixture');
    changeField(tree, '账户密码', 'long-fixture-password');
    changeField(tree, '再次输入密码', 'long-fixture-password');
    tree = render(() => AccountPanel({ disabled: false }));
    submit(tree, '注册账户');
    await settle();
    tree = render(() => AccountPanel({ disabled: false }));
    expect(textOf(tree)).toContain('fixture-recovery');
    let left = false;
    controller.request(() => {
      left = true;
    });
    expect(left).toBe(false);
    expect(controller.state().pending?.guard.kind).toBe('recovery');
    controller.cancel();
    click(button(tree, '复制恢复码'));
    await settle();
    tree = render(() => AccountPanel({ disabled: false }));
    expect(textOf(tree)).toContain('手动');
    expect(textOf(tree)).toContain('fixture-recovery');
    controller.request(() => {
      left = true;
    });
    controller.confirm();
    tree = render(() => AccountPanel({ disabled: false }));
    expect(left).toBe(true);
    expect(textOf(tree)).not.toContain('fixture-recovery');
  });

  it('自定义服务器卡片解锁会预填它自己的服务端', async () => {
    createAccount({ accountId: 'another-fixture', name: 'Other' });
    let tree = render(() => AccountPanel({ disabled: false }));
    await settle();
    tree = render(() => AccountPanel({ disabled: false }));
    click(button(tree, '输入账户密码', 1));
    tree = render(() => AccountPanel({ disabled: false }));
    expect(
      nodes(tree).some((node) => node.type === 'input' && node.props.value === 'https://custom.fixture.invalid/sync'),
    ).toBe(true);
    expect(nodes(tree).some((node) => node.type === 'input' && node.props.value === 'another-fixture')).toBe(true);
  });

  it('切换容器先说明reload影响，确认前既不换活动账户也不reload', async () => {
    const original = readAccountRegistry().activeId;
    const target = createAccount({ accountId: 'switch-fixture', name: 'Switch' });
    let tree = render(() => AccountPanel({ disabled: false }));
    await settle();
    tree = render(() => AccountPanel({ disabled: false }));
    click(button(tree, '使用此账户'));
    tree = render(() => AccountPanel({ disabled: false }));
    expect(readAccountRegistry().activeId).toBe(original);
    expect(reloads).toBe(0);
    expect(textOf(tree)).toContain('不会自动合并');
    click(button(tree, '确认进入并重新加载'));
    await settle();
    expect(readAccountRegistry().activeId).toBe(target.id);
    expect(reloads).toBe(1);
  });

  it('删除清理待完成时显示真实warning而不是成功保证', async () => {
    const target = createAccount({ accountId: 'delete-fixture', name: 'Delete' });
    remote.remove = async () => {
      removeAccount(target.id);
      return { requiresReload: false, pending: 1, warning: 'fixture 清理失败，请重新打开重试' };
    };
    let tree = render(() => AccountPanel({ disabled: false }));
    await settle();
    tree = render(() => AccountPanel({ disabled: false }));
    click(button(tree, '删除本机账户', 1));
    tree = render(() => AccountPanel({ disabled: false }));
    changeField(tree, '输入完整账户 ID', 'delete-fixture');
    tree = render(() => AccountPanel({ disabled: false }));
    submit(tree, '确认删除本机数据');
    await settle();
    tree = render(() => AccountPanel({ disabled: false }));
    expect(textOf(tree)).toContain('fixture 清理失败');
    expect(textOf(tree)).not.toContain('已硬删除');
    expect(readAccountRegistry().accounts.some((account) => account.id === target.id)).toBe(false);
  });

  it('账户名称无法落盘时显示失败并保留草稿', async () => {
    let tree = render(() => AccountPanel({ disabled: false }));
    await settle();
    tree = render(() => AccountPanel({ disabled: false }));
    click(button(tree, '改本机名称'));
    tree = render(() => AccountPanel({ disabled: false }));
    changeField(tree, '本机账户名', 'Unsaved fixture');
    tree = render(() => AccountPanel({ disabled: false }));
    storageRejectWrites = true;
    submit(tree, '保存');
    await settle();
    tree = render(() => AccountPanel({ disabled: false }));
    expect(nodes(tree).some((node) => node.props.role === 'alert' && textOf(node).includes('未保存'))).toBe(true);
    expect(nodes(tree).some((node) => node.type === 'input' && node.props.value === 'Unsaved fixture')).toBe(true);
  });

  it('活动账户无法落盘时显示失败且不reload', async () => {
    createAccount({ accountId: 'blocked-switch-fixture', name: 'Blocked switch' });
    let tree = render(() => AccountPanel({ disabled: false }));
    await settle();
    tree = render(() => AccountPanel({ disabled: false }));
    click(button(tree, '使用此账户'));
    tree = render(() => AccountPanel({ disabled: false }));
    storageRejectWrites = true;
    click(button(tree, '确认进入并重新加载'));
    await settle();
    tree = render(() => AccountPanel({ disabled: false }));
    expect(reloads).toBe(0);
    expect(nodes(tree).some((node) => node.props.role === 'alert' && textOf(node).includes('未切换'))).toBe(true);
  });
});

describe('同步界面的失败与并发', () => {
  it('快照导出启动就阻止离开和重复点击，拒绝保存显示主区错误', async () => {
    const api = fixtureSync();
    let exports = 0;
    let reject: (error: Error) => void = () => {};
    api.exportSnapshot = () => {
      exports += 1;
      return new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
    };
    let tree = render(() => SyncPanel({ api, disabled: false }));
    const exportButton = button(tree, '存一份服务端快照');
    click(exportButton);
    click(exportButton);
    let left = false;
    controller.request(() => {
      left = true;
    });
    expect(exports).toBe(1);
    expect(left).toBe(false);
    expect(controller.state().guard?.kind).toBe('busy');
    reject(new Error('fixture snapshot failure'));
    await settle();
    tree = render(() => SyncPanel({ api, disabled: false }));
    expect(
      nodes(tree).some((node) => node.props.role === 'alert' && textOf(node).includes('fixture snapshot failure')),
    ).toBe(true);
    expect(button(tree, '存一份服务端快照').props.disabled).toBe(false);
  });

  it('更换密码先内联确认，提交后阻止重复和离开，失败保留新密码供重试', async () => {
    const api = fixtureSync();
    let rotations = 0;
    let reject: (error: Error) => void = () => {};
    api.rotatePassword = () => {
      rotations += 1;
      return new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
    };
    let tree = render(() => SyncPanel({ api, disabled: false }));
    changeField(tree, '更换账户密码', 'next-fixture-password');
    tree = render(() => SyncPanel({ api, disabled: false }));
    click(button(tree, '换密码'));
    tree = render(() => SyncPanel({ api, disabled: false }));
    expect(rotations).toBe(0);
    const confirm = button(tree, '确认更换密码');
    click(confirm);
    click(confirm);
    expect(rotations).toBe(1);
    expect(controller.state().guard?.kind).toBe('busy');
    reject(new Error('fixture rotate failure'));
    await settle();
    tree = render(() => SyncPanel({ api, disabled: false }));
    expect(textOf(tree)).toContain('fixture rotate failure');
    expect(nodes(tree).some((node) => node.type === 'input' && node.props.value === 'next-fixture-password')).toBe(
      true,
    );
  });

  it('同步错误与恢复码无需展开高级就可见，未保存恢复码不能断开', () => {
    const api = fixtureSync();
    api.error = 'fixture sync failed';
    api.status = 'error';
    api.recoveryCode = 'fixture-sync-recovery';
    let disconnects = 0;
    api.disconnect = async () => {
      disconnects += 1;
    };
    const tree = render(() => SyncPanel({ api, disabled: false }));
    const advanced = nodes(tree).find((node) => node.type === 'details');
    expect(textOf(advanced)).not.toContain('fixture-sync-recovery');
    expect(textOf(tree)).toContain('fixture-sync-recovery');
    expect(
      nodes(tree).some((node) => node.props.role === 'alert' && textOf(node).includes('fixture sync failed')),
    ).toBe(true);
    click(button(tree, '断开同步（不影响本机数据，也不会删除服务端的数据）'));
    expect(disconnects).toBe(0);
    expect(controller.state().pending?.guard.kind).toBe('recovery');
  });
});
