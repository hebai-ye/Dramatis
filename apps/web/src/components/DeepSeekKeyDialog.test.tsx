import { createProviderProfile } from '@dramatis/core';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProvidersApi } from '../lib/providers';

const host = vi.hoisted(() => {
  let slots: unknown[] = [],
    cursor = 0,
    effectCursor = 0;
  let effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [],
    pending: (() => void)[] = [];
  return {
    begin() {
      cursor = 0;
      effectCursor = 0;
    },
    reset() {
      for (const effect of effects) effect.cleanup?.();
      slots = [];
      effects = [];
      pending = [];
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
    effect(run: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const index = effectCursor++,
        previous = effects[index];
      if (
        previous?.deps &&
        deps &&
        previous.deps.length === deps.length &&
        deps.every((value, i) => Object.is(value, previous.deps?.[i]))
      )
        return;
      pending.push(() => {
        previous?.cleanup?.();
        effects[index] = { deps, cleanup: run() };
      });
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: host.state,
  useRef: (initial: unknown) => host.state(() => ({ current: initial }))[0],
  useEffect: host.effect,
  useLayoutEffect: host.effect,
  useMemo: (create: () => unknown) => create(),
  useCallback: (callback: unknown) => callback,
}));

function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ReactElement<Record<string, unknown>>;
  return [element, ...nodes(element.props.children as ReactNode)];
}
const modulePath = './' + 'DeepSeekKeyDialog';
const module = (await import(modulePath).catch(() => null)) as typeof import('./DeepSeekKeyDialog') | null;
let api: ProvidersApi, closed: boolean;
function ownerOf() {
  if (api.setupOwner === null) throw new Error('Fixture owner is not ready');
  return api.setupOwner;
}
function render() {
  host.begin();
  const tree = module?.DeepSeekKeyDialog({
    providers: api,
    onClose: () => {
      closed = true;
    },
    onRecover: () => {},
    returnFocus: null,
  });
  host.flush();
  return tree;
}
function input(tree: ReactNode) {
  return nodes(tree).find((node) => node.type === 'input');
}
function fill(value: string) {
  (input(render())?.props.onChange as ((event: unknown) => void) | undefined)?.({ target: { value } });
}
async function submit() {
  const form = nodes(render()).find((node) => node.type === 'form');
  return (form?.props.onSubmit as ((event: unknown) => unknown) | undefined)?.({ preventDefault() {} });
}
beforeEach(() => {
  host.reset();
  closed = false;
  const active = createProviderProfile({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'fixture' });
  api = {
    active,
    activeId: active.id,
    profiles: [active],
    apiKey: '',
    keyLoading: false,
    keyError: null,
    keyMode: 'device',
    vaultLocked: false,
    setupOwner: { profileId: active.id, keyMode: 'device', context: {}, token: {} },
    async saveDeepSeekKey() {
      api.apiKey = 'sk-fixture';
      return { profileId: active.id, keyRef: active.keyRef, baseUrl: active.baseUrl };
    },
    reloadApiKey() {},
    keyKind: 'plain',
    vaultExists: false,
    background: null,
    async unlockVault() {},
    async selectProfile() {},
    async addProfile() {},
    async updateProfile() {},
    async deleteProfile() {},
    async setApiKey() {},
    async setKeyMode() {},
    async commitConfig() {},
  };
});
describe('single-field DeepSeek setup dialog', () => {
  it('only presents one editable configuration input and the official application link', () => {
    const tree = render();
    expect(nodes(tree).filter((node) => ['input', 'select', 'textarea'].includes(String(node.type)))).toHaveLength(1);
    expect(input(tree)?.props.type).toBe('password');
    expect(nodes(tree).find((node) => node.type === 'a')?.props.href).toBe('https://platform.deepseek.com/api_keys');
    expect(nodes(tree).find((node) => node.props.type === 'submit')?.props.disabled).toBe(true);
  });
  it('waits for saving and a ready matching target before closing', async () => {
    let finish: (value: { profileId: string; keyRef: string; baseUrl: string }) => void = () => {};
    api.saveDeepSeekKey = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    fill('sk-fixture');
    const saving = submit();
    render();
    expect(closed).toBe(false);
    finish({ profileId: api.activeId ?? '', keyRef: api.active?.keyRef ?? '', baseUrl: api.active?.baseUrl ?? '' });
    await saving;
    api.keyLoading = true;
    render();
    expect(closed).toBe(false);
    api.keyLoading = false;
    api.apiKey = 'sk-fixture';
    render();
    expect(closed).toBe(true);
  });
  it('retains the draft and stays open after a failed write', async () => {
    api.saveDeepSeekKey = async () => {
      throw new Error('fixture denied');
    };
    fill('sk-fixture');
    await submit();
    const tree = render();
    expect(input(tree)?.props.value).toBe('sk-fixture');
    expect(closed).toBe(false);
    expect(nodes(tree).some((node) => node.props.role === 'alert')).toBe(true);
  });
  it('submits once on repeated clicks and keeps the dialog busy until persistence finishes', async () => {
    let writes = 0;
    let finish: () => void = () => {};
    api.saveDeepSeekKey = async () => {
      writes += 1;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      api.apiKey = 'sk-fixture-double-click';
      return { profileId: api.activeId ?? '', keyRef: api.active?.keyRef ?? '', baseUrl: api.active?.baseUrl ?? '' };
    };
    fill('sk-fixture-double-click');
    expect(render()?.props.guard?.kind).toBe('dirty');
    await submit();
    await submit();
    expect(writes).toBe(1);
    expect(render()?.props.guard?.kind).toBe('busy');
    expect(closed).toBe(false);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    render();
    expect(closed).toBe(true);
  });
  it('can reread a newly selected target after its first active read failed, without saving twice', async () => {
    const target = createProviderProfile({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'fixture' });
    let writes = 0;
    api.saveDeepSeekKey = async () => {
      writes += 1;
      api.active = target;
      api.activeId = target.id;
      api.setupOwner = { ...ownerOf(), profileId: target.id, token: {} };
      api.keyLoading = true;
      return { profileId: target.id, keyRef: target.keyRef, baseUrl: target.baseUrl };
    };
    fill('sk-fixture-new-target');
    await submit();
    render();
    api.keyLoading = false;
    api.keyError = 'fixture active read denied';
    render();
    const failed = render();
    expect(closed).toBe(false);
    expect(input(failed)?.props.value).toBe('sk-fixture-new-target');
    const retry = nodes(failed).find((node) => node.type === 'button' && node.props.children === '重新读取');
    expect(retry).toBeDefined();
    expect(retry?.props.disabled).not.toBe(true);
    let reloads = 0;
    api.reloadApiKey = () => {
      reloads += 1;
      api.keyLoading = true;
      api.keyError = null;
    };
    (retry?.props.onClick as (() => void) | undefined)?.();
    render();
    expect(reloads).toBe(1);
    expect(closed).toBe(false);
    api.keyLoading = false;
    api.apiKey = 'sk-fixture-new-target';
    render();
    expect(closed).toBe(true);
    expect(writes).toBe(1);
  });
  it('does not submit an old draft after its opening owner changed', async () => {
    let written = false;
    api.saveDeepSeekKey = async () => {
      written = true;
      return { profileId: api.activeId ?? '', keyRef: api.active?.keyRef ?? '', baseUrl: api.active?.baseUrl ?? '' };
    };
    fill('sk-fixture');
    api.setupOwner = { ...ownerOf(), token: {} };
    await submit();
    render();
    expect(written).toBe(false);
    expect(input(render())?.props.value).toBe('sk-fixture');
  });
  it('does not expose an empty key input when the existing vault is locked', () => {
    api.vaultLocked = true;
    expect(nodes(render()).filter((node) => node.type === 'input')).toHaveLength(0);
    expect(nodes(render()).filter((node) => node.type === 'button').length).toBeGreaterThan(0);
  });
  it('waits without an empty form when manually opened during a key read and closes if a key exists', () => {
    api.keyLoading = true;
    expect(input(render())).toBeUndefined();
    expect(closed).toBe(false);
    api.keyLoading = false;
    api.apiKey = 'sk-fixture-existing';
    render();
    expect(closed).toBe(true);
  });
});
