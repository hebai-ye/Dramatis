import { createConversation, createProviderProfile, roomId } from '@dramatis/core';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AppearanceApi, DEFAULT_APPEARANCE } from '../lib/appearance';
import { createDialogController, type DialogGuard } from '../lib/dialog-controller';
import type { ProvidersApi } from '../lib/providers';
import type { StorageApi } from '../lib/storage';
import { AppearancePanel } from './AppearancePanel';
import { ArchivedConversationsPanel } from './ArchivedConversationsPanel';
import { DataSettingsPanel } from './DataSettingsPanel';
import { ProviderPanel } from './ProviderPanel';
import { SettingsDialog } from './SettingsDialog';

const dialog = vi.hoisted(() => ({
  requestAction: (_action: () => void) => {},
  setGuard: (_guard: DialogGuard | null) => {},
}));
vi.mock('./DialogShell', () => ({ useDialogActions: () => dialog }));
let controller: ReturnType<typeof createDialogController>;

// The project has no DOM test runtime. Exercise real component handlers and their
// resulting trees; browser focus and keyboard behavior need browser verification.
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
      for (const run of next) run();
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
    effect(run: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (!previous || !deps || !previous.deps || deps.some((value, i) => value !== previous.deps?.[i])) {
        pending.push(() => {
          previous?.cleanup?.();
          effects[index] = { deps, cleanup: run() };
        });
      }
    },
  };
});

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: hooks.state,
  useEffect: hooks.effect,
  useRef: (initial: unknown) => {
    const [ref] = hooks.state(() => ({ current: initial }));
    return ref;
  },
}));

function render(component: () => ReactNode): ReactNode {
  hooks.begin();
  component();
  hooks.flush();
  hooks.begin();
  const tree = component();
  hooks.flush();
  return tree;
}

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

function button(tree: ReactNode, label: string): ReactElement<Record<string, unknown>> {
  const found = nodes(tree).find(
    (node) => node.type === 'button' && textOf(node.props.children as ReactNode) === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function click(node: ReactElement<Record<string, unknown>>) {
  return (node.props.onClick as () => unknown)();
}

function changeValue(node: ReactElement<Record<string, unknown>> | undefined, value: string): void {
  if (!node) throw new Error('Missing input fixture');
  (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

function fixtureApi(): ProvidersApi {
  const first = createProviderProfile({ name: 'First', model: 'fixture-model', baseUrl: 'https://fixture.invalid/v1' });
  const second = createProviderProfile({
    name: 'Second',
    model: 'fixture-model',
    baseUrl: 'https://fixture.invalid/v1',
  });
  return {
    profiles: [first, second],
    setupOwner: { profileId: first.id, keyMode: 'session', context: {}, token: {} },
    saveDeepSeekKey: async () => ({ profileId: first.id, keyRef: first.keyRef, baseUrl: first.baseUrl }),
    activeId: first.id,
    active: first,
    apiKey: '',
    keyLoading: false,
    keyError: null,
    reloadApiKey: () => {},
    keyMode: 'session',
    keyKind: 'memory',
    vaultExists: false,
    vaultLocked: false,
    background: null,
    unlockVault: async () => {},
    selectProfile: async () => {},
    addProfile: async () => {},
    updateProfile: async () => {},
    deleteProfile: async () => {},
    setApiKey: async () => {},
    setKeyMode: async () => {},
    commitConfig: async () => {},
  };
}

function fixtureSettings(category: 'model' | 'archive' = 'model') {
  const conversation = createConversation({ roomId: roomId('fixture-room'), title: 'Fixture archive' });
  return {
    category,
    onCategoryChange: (_category: string) => {},
    providers: fixtureApi(),
    appearance: {
      value: DEFAULT_APPEARANCE,
      persistenceError: null,
      hasSavedChanges: false,
      retryPersist: () => {},
      patch: () => {},
      setBackgroundFromFile: async () => {},
    },
    archivedConversations: [{ ...conversation, archivedAt: '2026-01-01T00:00:00.000Z' }],
    activeConversationId: null,
    disabled: false,
    onOpenArchived: () => {},
    onDeleteArchived: async () => ({ ok: true, message: 'fixture deleted' }),
    onExportArchive: async () => null,
    onImportArchive: async () => null,
    onExportTranscript: async () => null,
    storage: {
      status: { supported: true, persisted: null, usage: null, quota: null },
      ratio: null,
      canInstall: false,
      requestPersist: async () => false,
      installApp: async () => 'unavailable' as const,
      reload: async () => {},
    } satisfies StorageApi,
    backendKind: 'fixture',
  };
}

beforeEach(() => {
  hooks.reset();
  controller = createDialogController();
  dialog.requestAction = controller.request;
  dialog.setGuard = controller.setGuard;
  vi.stubGlobal('window', { confirm: () => true });
});

describe('settings panel behavior', () => {
  it.each([
    ['', '', null],
    ['0', '', { inputPerMillion: 0, outputPerMillion: 0, currency: '¥' }],
    ['', '3.5', { inputPerMillion: 0, outputPerMillion: 3.5, currency: '¥' }],
  ])('keeps blank and zero price policy on save (%s, %s)', async (input, output, expected) => {
    const api = fixtureApi();
    let saved: unknown;
    api.commitConfig = async (config) => {
      saved = config.profile.price;
    };
    let tree = render(() => ProviderPanel({ api, disabled: false }));
    for (const [label, value] of [
      ['名称', 'Renamed'],
      ['输入价 / 百万 token', input],
      ['输出价 / 百万 token', output],
    ]) {
      const field = nodes(tree).find(
        (node) => node.type === 'label' && textOf(node.props.children as ReactNode).startsWith(label ?? ''),
      );
      changeValue(
        nodes(field).find((node) => node.type === 'input'),
        value ?? '',
      );
    }
    tree = render(() => ProviderPanel({ api, disabled: false }));
    await click(button(tree, '保存'));
    expect(saved).toEqual(expected);
    expect(controller.state().guard).toBe(null);
  });

  it('shows the session-only appearance failure and invokes retry', () => {
    let retries = 0;
    const api = {
      value: DEFAULT_APPEARANCE,
      persistenceError: 'quota fixture',
      hasSavedChanges: false,
      retryPersist: () => {
        retries += 1;
      },
      patch: () => {},
      setBackgroundFromFile: async () => {},
    };
    const tree = render(() => AppearancePanel({ api, disabled: false }));
    expect(
      nodes(tree).some(
        (node) => node.props.role === 'alert' && textOf(node.props.children as ReactNode).includes('仅本次会话'),
      ),
    ).toBe(true);
    click(button(tree, '重试保存外观'));
    expect(retries).toBe(1);
  });

  it.each([
    ['输入价 / 百万 token', '-1'],
    ['输出价 / 百万 token', 'Infinity'],
    ['输入价 / 百万 token', 'not-a-price'],
    ['温度', '2.1'],
    ['温度', ''],
    ['上下文窗口', '0'],
    ['上下文窗口', '1.5'],
    ['预留回复', '0'],
    ['预留回复', '9999999'],
  ])('rejects invalid %s without changing the draft or key (%s)', async (label, invalid) => {
    const api = fixtureApi();
    let saves = 0;
    api.commitConfig = async () => {
      saves += 1;
    };
    let tree = render(() => ProviderPanel({ api, disabled: false }));
    const field = (name: string) =>
      nodes(tree).find((node) => node.type === 'label' && textOf(node.props.children as ReactNode).startsWith(name));
    changeValue(
      nodes(field('API Key')).find((node) => node.type === 'input'),
      'sk-unsaved-fixture',
    );
    changeValue(
      nodes(field(label)).find((node) => node.type === 'input'),
      invalid,
    );
    tree = render(() => ProviderPanel({ api, disabled: false }));
    await click(button(tree, '保存'));
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(saves).toBe(0);
    expect(
      nodes(tree).some(
        (node) => node.props.role === 'alert' && textOf(node.props.children as ReactNode).includes(label),
      ),
    ).toBe(true);
    expect(nodes(field(label)).find((node) => node.type === 'input')?.props.value).toBe(invalid);
    expect(nodes(tree).some((node) => node.type === 'input' && node.props.value === 'sk-unsaved-fixture')).toBe(true);
    expect(controller.state().guard?.kind).toBe('dirty');
  });

  it.each([
    ['https://api.openai.com/v1', 'https://platform.openai.com/api-keys'],
    ['https://api.deepseek.com', 'https://platform.deepseek.com/api_keys'],
    ['http://localhost:11434/v1', null],
    ['https://api.deepseek.com.evil.invalid/v1', null],
  ])('uses endpoint-specific empty-key guidance for %s', (baseUrl, expectedLink) => {
    const api = fixtureApi();
    if (!api.active) throw new Error('Missing fixture');
    api.active = { ...api.active, baseUrl };
    const tree = render(() => ProviderPanel({ api, disabled: false }));
    const guide = nodes(tree).find((node) => node.props.className === 'key-guide');
    const links = nodes(guide)
      .filter((node) => node.type === 'a')
      .map((node) => node.props.href);
    expect(links).toEqual(expectedLink === null ? [] : [expectedLink]);
    if (baseUrl.includes('localhost')) expect(textOf(guide)).toContain('可以留空');
  });
  it('keeps the encrypted key and save controls blocked until unlocking', async () => {
    const api = fixtureApi();
    api.keyMode = 'encrypted';
    api.keyKind = 'encrypted';
    api.vaultExists = true;
    api.vaultLocked = true;
    let saves = 0;
    api.commitConfig = async () => {
      saves += 1;
    };
    let tree = render(() => ProviderPanel({ api, disabled: false }));
    changeValue(
      nodes(tree).find((node) => node.type === 'input' && node.props.value === 'First'),
      'Edited name',
    );
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(
      nodes(tree).find((node) => node.type === 'button' && node.props['aria-label'] === '显示 API Key')?.props.disabled,
    ).toBe(true);
    expect(button(tree, '保存').props.disabled).toBe(true);
    await click(button(tree, '保存'));
    expect(saves).toBe(0);
    expect(textOf(tree)).toContain('读取已有 Key 后才能编辑和保存');
  });
  it('waits for the real archive deletion result while blocking duplicate work and leaving', async () => {
    const props = fixtureSettings('archive');
    let finish: (value: { ok: boolean; message: string }) => void = () => {};
    let attempts = 0;
    props.onDeleteArchived = () => {
      attempts += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    let tree = render(() => ArchivedConversationsPanel(props));
    click(button(tree, '删除'));
    tree = render(() => ArchivedConversationsPanel(props));
    const confirm = button(tree, '确认彻底删除');
    const pending = click(confirm);
    click(confirm);
    let left = false;
    controller.request(() => {
      left = true;
    });
    expect(attempts).toBe(1);
    expect(left).toBe(false);
    expect(controller.state().guard?.kind).toBe('busy');
    tree = render(() => ArchivedConversationsPanel(props));
    expect(button(tree, '删除中…').props.disabled).toBe(true);
    finish({ ok: false, message: 'fixture write rejected' });
    await pending;
    tree = render(() => ArchivedConversationsPanel(props));
    expect(textOf(tree)).toContain('fixture write rejected');
    expect(button(tree, '确认彻底删除').props.disabled).toBe(false);
    expect(controller.state().guard).toBe(null);
  });

  it('retains an archive confirmation after an exception and clears it only after retry succeeds', async () => {
    const props = fixtureSettings('archive');
    let attempts = 0;
    props.onDeleteArchived = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('fixture exception');
      return { ok: true, message: 'fixture retry saved' };
    };
    let tree = render(() => ArchivedConversationsPanel(props));
    click(button(tree, '删除'));
    tree = render(() => ArchivedConversationsPanel(props));
    await click(button(tree, '确认彻底删除'));
    tree = render(() => ArchivedConversationsPanel(props));
    expect(textOf(tree)).toContain('fixture exception');
    await click(button(tree, '确认彻底删除'));
    tree = render(() => ArchivedConversationsPanel(props));
    expect(textOf(tree)).toContain('fixture retry saved');
    expect(
      nodes(tree).some((node) => node.type === 'button' && textOf(node.props.children as ReactNode) === '确认彻底删除'),
    ).toBe(false);
  });

  it('reports a data import failure and restores the action for retry', async () => {
    const props = fixtureSettings();
    let rejectImport: (error: Error) => void = () => {};
    props.onImportArchive = () =>
      new Promise((_resolve, reject) => {
        rejectImport = reject;
      });
    let tree = render(() => DataSettingsPanel(props));
    const pending = click(button(tree, '导入封存'));
    expect(controller.state().guard?.kind).toBe('busy');
    tree = render(() => DataSettingsPanel(props));
    expect(button(tree, '导入中…').props.disabled).toBe(true);
    rejectImport(new Error('fixture import failed'));
    await pending;
    tree = render(() => DataSettingsPanel(props));
    expect(
      nodes(tree).some(
        (node) =>
          node.props.role === 'alert' && textOf(node.props.children as ReactNode).includes('fixture import failed'),
      ),
    ).toBe(true);
    expect(button(tree, '导入封存').props.disabled).toBe(false);
    expect(controller.state().guard).toBe(null);
  });

  it('updates a newly loaded model key without losing edited fields', () => {
    const api = fixtureApi();
    api.keyLoading = true;
    let tree = render(() => ProviderPanel({ api, disabled: false }));
    changeValue(
      nodes(tree).find((node) => node.type === 'input' && node.props.value === 'First'),
      'Unsaved fixture',
    );
    tree = render(() => ProviderPanel({ api, disabled: false }));
    api.apiKey = 'sk-fixture-loaded';
    api.keyLoading = false;
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(nodes(tree).some((node) => node.type === 'input' && node.props.value === 'sk-fixture-loaded')).toBe(true);
    expect(nodes(tree).some((node) => node.type === 'input' && node.props.value === 'Unsaved fixture')).toBe(true);
    expect(controller.state().guard?.kind).toBe('dirty');
  });

  it('preserves an explicitly edited key when a cached key finishes loading', () => {
    const api = fixtureApi();
    let tree = render(() => ProviderPanel({ api, disabled: false }));
    changeValue(
      nodes(tree).find((node) => node.type === 'input' && node.props.type === 'password'),
      'sk-fixture-edited',
    );
    tree = render(() => ProviderPanel({ api, disabled: false }));
    api.apiKey = 'sk-fixture-loaded';
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(nodes(tree).some((node) => node.type === 'input' && node.props.value === 'sk-fixture-edited')).toBe(true);
  });

  it('blocks key editing and saving while the selected model key is loading', async () => {
    const api = fixtureApi();
    api.keyLoading = true;
    let saves = 0;
    api.commitConfig = async () => {
      saves += 1;
    };
    let tree = render(() => ProviderPanel({ api, disabled: false }));
    changeValue(
      nodes(tree).find((node) => node.type === 'input' && node.props.value === 'First'),
      'Edited name',
    );
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(nodes(tree).find((node) => node.type === 'input' && node.props.type === 'password')?.props.disabled).toBe(
      true,
    );
    expect(button(tree, '保存').props.disabled).toBe(true);
    expect(textOf(tree)).toContain('正在读取当前配置的 API Key');
    await click(button(tree, '保存'));
    expect(saves).toBe(0);
  });

  it('shows key read failures, blocks key edits and save, and offers a reread without losing the draft', async () => {
    const api = fixtureApi();
    api.keyError = 'fixture key read denied';
    let reads = 0;
    api.reloadApiKey = () => {
      reads += 1;
      api.keyError = null;
      api.keyLoading = true;
    };
    let tree = render(() => ProviderPanel({ api, disabled: false }));
    changeValue(
      nodes(tree).find((node) => node.type === 'input' && node.props.value === 'First'),
      'Edited name',
    );
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(
      nodes(tree).some(
        (node) =>
          node.props.role === 'alert' && textOf(node.props.children as ReactNode).includes('fixture key read denied'),
      ),
    ).toBe(true);
    expect(button(tree, '保存').props.disabled).toBe(true);
    expect(nodes(tree).find((node) => node.type === 'input' && node.props.type === 'password')?.props.disabled).toBe(
      true,
    );
    await click(button(tree, '重新读取 API Key'));
    expect(reads).toBe(1);
    api.apiKey = 'sk-fixture-reloaded';
    api.keyLoading = false;
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(nodes(tree).some((node) => node.type === 'input' && node.props.value === 'Edited name')).toBe(true);
    expect(nodes(tree).some((node) => node.type === 'input' && node.props.value === 'sk-fixture-reloaded')).toBe(true);
  });

  it('protects leaving while a background image is loading and exposes a failed load', async () => {
    let rejectLoad: (error: Error) => void = () => {};
    const api = {
      value: DEFAULT_APPEARANCE,
      persistenceError: null,
      hasSavedChanges: false,
      retryPersist: () => {},
      patch: () => {},
      setBackgroundFromFile: () =>
        new Promise<void>((_resolve, reject) => {
          rejectLoad = reject;
        }),
    };
    let tree = render(() => AppearancePanel({ api, disabled: false }));
    const input = nodes(tree).find((node) => node.type === 'input' && node.props.type === 'file');
    if (!input) throw new Error('Missing background upload');
    const pending = (input.props.onChange as (event: { target: { files: File[]; value: string } }) => unknown)({
      target: { files: [{} as File], value: 'fixture' },
    });
    let left = false;
    controller.request(() => {
      left = true;
    });
    expect(left).toBe(false);
    expect(controller.state().guard?.kind).toBe('busy');
    tree = render(() => AppearancePanel({ api, disabled: false }));
    expect(button(tree, '读取中…').props.disabled).toBe(true);
    const subjects = nodes(tree).find((node) => node.props['aria-label'] === '背景题材');
    const subjectButtons = nodes(subjects).filter((node) => node.type === 'button');
    expect(subjectButtons).toHaveLength(12);
    expect(subjectButtons.every((node) => node.props.disabled === true)).toBe(true);
    const scenes = nodes(tree).find((node) => node.props['aria-label'] === '酒馆场景');
    const sceneButtons = nodes(scenes).filter((node) => node.type === 'button');
    expect(sceneButtons).toHaveLength(3);
    expect(sceneButtons.every((node) => node.props.disabled === true)).toBe(true);
    rejectLoad(new Error('fixture image failed'));
    await pending;
    tree = render(() => AppearancePanel({ api, disabled: false }));
    expect(
      nodes(tree).some(
        (node) =>
          node.props.role === 'alert' && textOf(node.props.children as ReactNode).includes('fixture image failed'),
      ),
    ).toBe(true);
    expect(controller.state().guard).toBe(null);
  });

  it('offers four settings categories with no account navigation', () => {
    const tree = render(() => SettingsDialog(fixtureSettings()));
    const nav = nodes(tree).find((node) => node.type === 'nav');
    const labels = nodes(nav)
      .filter((node) => node.type === 'strong')
      .map((node) => textOf(node.props.children as ReactNode));
    expect(labels).toEqual(['模型配置', '外观与显示', '数据与备份', '已归档对话']);
    expect(nodes(tree).some((node) => node.props.role === 'dialog')).toBe(false);
  });

  it('defers category navigation until the existing draft guard is confirmed', () => {
    const props = fixtureSettings();
    let selected = '';
    props.onCategoryChange = (category) => {
      selected = category;
    };
    const tree = render(() => SettingsDialog(props));
    controller.setGuard({ kind: 'dirty', message: 'fixture draft' });
    const nav = nodes(tree).find((node) => node.type === 'nav');
    const category = nodes(nav).find(
      (node) => node.type === 'button' && textOf(node.props.children as ReactNode).includes('外观'),
    );
    if (!category) throw new Error('Missing appearance navigation');
    click(category);
    expect(selected).toBe('');
    controller.confirm();
    expect(selected).toBe('appearance');
  });

  it('does not delete an archived conversation before inline confirmation', () => {
    const props = fixtureSettings('archive');
    let deletions = 0;
    props.onDeleteArchived = async () => {
      deletions += 1;
      return { ok: true, message: 'fixture deleted' };
    };
    let tree = render(() => ArchivedConversationsPanel(props));
    click(button(tree, '删除'));
    tree = render(() => ArchivedConversationsPanel(props));
    expect(deletions).toBe(0);
    expect(textOf(tree)).toContain('确认彻底删除');
  });

  it('keeps an unsuccessful archived deletion visible with a retry confirmation', async () => {
    const props = fixtureSettings('archive');
    props.onDeleteArchived = async () => ({ ok: false, message: 'fixture database blocked' });
    let tree = render(() => ArchivedConversationsPanel(props));
    click(button(tree, '删除'));
    tree = render(() => ArchivedConversationsPanel(props));
    await click(button(tree, '确认彻底删除'));
    tree = render(() => ArchivedConversationsPanel(props));
    expect(textOf(tree)).toContain('fixture database blocked');
    expect(button(tree, '确认彻底删除').props.disabled).toBe(false);
  });

  it('keeps a model draft when switching is canceled, and switches only after discarding', async () => {
    const api = fixtureApi();
    const selected: string[] = [];
    const secondId = api.profiles[1]?.id;
    if (!secondId) throw new Error('Missing second fixture profile');
    api.selectProfile = async (id) => {
      selected.push(id);
    };
    let tree = render(() => ProviderPanel({ api, disabled: false }));
    const name = nodes(tree).find((node) => node.type === 'input' && node.props.value === 'First');
    changeValue(name, 'Unsaved fixture');
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(controller.state().guard?.kind).toBe('dirty');
    const select = nodes(tree).find((node) => node.type === 'select' && node.props.value === api.activeId);
    const change = () => changeValue(select, secondId);
    change();
    expect(selected).toEqual([]);
    controller.cancel();
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(nodes(tree).some((node) => node.type === 'input' && node.props.value === 'Unsaved fixture')).toBe(true);
    change();
    controller.confirm();
    await Promise.resolve();
    expect(selected).toEqual([secondId]);
  });

  it('blocks duplicate saves and leaving immediately, then preserves a failed draft for retry', async () => {
    const api = fixtureApi();
    let saves = 0;
    let rejectSave: (error: Error) => void = () => {};
    api.commitConfig = () => {
      saves += 1;
      return new Promise((_resolve, reject) => {
        rejectSave = reject;
      });
    };
    let tree = render(() => ProviderPanel({ api, disabled: false }));
    const name = nodes(tree).find((node) => node.type === 'input' && node.props.value === 'First');
    changeValue(name, 'Unsaved fixture');
    tree = render(() => ProviderPanel({ api, disabled: false }));
    const save = button(tree, '保存');
    const saving = click(save);
    click(save);
    let left = false;
    controller.request(() => {
      left = true;
    });
    expect(saves).toBe(1);
    expect(left).toBe(false);
    expect(controller.state().guard?.kind).toBe('busy');
    rejectSave(new Error('fixture save failed'));
    await saving;
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(textOf(tree)).toContain('fixture save failed');
    expect(nodes(tree).some((node) => node.type === 'input' && node.props.value === 'Unsaved fixture')).toBe(true);
    expect(button(tree, '保存').props.disabled).toBe(false);
    expect(controller.state().guard?.kind).toBe('dirty');
  });

  it('clears the dirty guard after a successful save and reports success', async () => {
    const api = fixtureApi();
    let tree = render(() => ProviderPanel({ api, disabled: false }));
    const name = nodes(tree).find((node) => node.type === 'input' && node.props.value === 'First');
    changeValue(name, 'Saved fixture');
    tree = render(() => ProviderPanel({ api, disabled: false }));
    await click(button(tree, '保存'));
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(controller.state().guard).toBe(null);
    expect(textOf(tree)).toContain('已保存');
    expect(button(tree, '保存').props.disabled).toBe(true);
  });

  it('waits for inline confirmation before deleting a model profile', async () => {
    const api = fixtureApi();
    let deletions = 0;
    api.deleteProfile = async () => {
      deletions += 1;
    };
    let tree = render(() => ProviderPanel({ api, disabled: false }));
    click(button(tree, '删除这个配置'));
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(deletions).toBe(0);
    expect(textOf(tree)).toContain('确认删除');
    await click(button(tree, '确认删除配置'));
    expect(deletions).toBe(1);
  });

  it('keeps deletion errors visible and allows retrying the same model profile', async () => {
    const api = fixtureApi();
    let attempts = 0;
    let rejectFirstConfirmation = false;
    api.deleteProfile = async () => {
      attempts += 1;
      if (rejectFirstConfirmation && attempts === 1) throw new Error('fixture deletion failed');
    };
    let tree = render(() => ProviderPanel({ api, disabled: false }));
    click(button(tree, '删除这个配置'));
    tree = render(() => ProviderPanel({ api, disabled: false }));
    const confirm = button(tree, '确认删除配置');
    rejectFirstConfirmation = true;
    await click(confirm);
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(textOf(tree)).toContain('fixture deletion failed');
    expect(button(tree, '确认删除配置').props.disabled).toBe(false);
    await click(button(tree, '确认删除配置'));
    tree = render(() => ProviderPanel({ api, disabled: false }));
    expect(attempts).toBe(2);
    expect(textOf(tree)).not.toContain('fixture deletion failed');
  });

  it('shows only the three thumbnails for the chosen background subject without changing the saved background', () => {
    const api: AppearanceApi = fixtureSettings().appearance;
    api.value = { ...DEFAULT_APPEARANCE, background: 'data:image/png;base64,fixture' };
    api.patch = (patch) => {
      api.value = { ...api.value, ...patch };
    };
    let tree = render(() => AppearancePanel({ api, disabled: false }));
    const subjects = nodes(tree).find((node) => node.props['aria-label'] === '背景题材');
    expect(
      nodes(subjects)
        .filter((node) => node.type === 'button')
        .map((node) => textOf(node)),
    ).toEqual([
      '酒馆',
      '玄幻',
      '仙侠',
      '武侠',
      '西方奇幻',
      '太空科幻',
      '赛博朋克',
      '末日废土',
      '都市日常',
      '校园青春',
      '古风宫廷',
      '悬疑诡秘',
    ]);
    expect(button(subjects, '酒馆').props['aria-pressed']).toBe(true);
    click(button(subjects, '太空科幻'));
    tree = render(() => AppearancePanel({ api, disabled: false }));
    expect(button(tree, '太空科幻').props['aria-pressed']).toBe(true);
    expect(api.value.background).toBe('data:image/png;base64,fixture');
    const scenes = nodes(tree).find((node) => node.props['aria-label'] === '太空科幻场景');
    const images = nodes(scenes).filter((node) => node.type === 'img');
    expect(images.map((node) => node.props.src)).toEqual([
      '/backgrounds/v1/thumbs/space-bridge.webp',
      '/backgrounds/v1/thumbs/space-station.webp',
      '/backgrounds/v1/thumbs/space-outpost.webp',
    ]);
    expect(images.every((node) => node.props.loading === 'lazy' && node.props.decoding === 'async')).toBe(true);
  });

  it('previews a selected built-in scene immediately, keeps the chosen theme, and can return to solid color', () => {
    const api: AppearanceApi = fixtureSettings().appearance;
    api.value = { ...DEFAULT_APPEARANCE, theme: 'light' };
    api.patch = (patch) => {
      api.value = { ...api.value, ...patch };
    };
    let tree = render(() => AppearancePanel({ api, disabled: false }));
    const hearth = nodes(tree).find((node) => node.type === 'button' && node.props['aria-label'] === '炉火大厅');
    expect(hearth).toBeDefined();
    if (!hearth) throw new Error('Missing built-in background scene');
    click(hearth);
    tree = render(() => AppearancePanel({ api, disabled: false }));
    expect(api.value.background).toBe('/backgrounds/v1/tavern-hearth.webp');
    expect(api.value.theme).toBe('light');
    expect(nodes(tree).find((node) => node.props['aria-label'] === '炉火大厅')?.props['aria-pressed']).toBe(true);
    expect(nodes(tree).find((node) => node.props.className === 'bg-preview')?.props.style).toEqual({
      backgroundImage: 'url("/backgrounds/v1/tavern-hearth.webp")',
      opacity: 0.85,
    });
    click(button(tree, '清除背景'));
    tree = render(() => AppearancePanel({ api, disabled: false }));
    expect(api.value.background).toBe('');
    expect(nodes(tree).find((node) => node.props['aria-label'] === '炉火大厅')?.props['aria-pressed']).toBe(false);
    expect(textOf(tree)).toContain('现在是纯色背景');
  });

  it.each([
    ['/backgrounds/v1/space-station.webp', '太空科幻'],
    ['data:image/png;base64,fixture', '酒馆'],
    ['', '酒馆'],
  ])('opens the background subject that matches the saved background (%s)', (background, subject) => {
    const api: AppearanceApi = fixtureSettings().appearance;
    api.value = { ...DEFAULT_APPEARANCE, background };
    const tree = render(() => AppearancePanel({ api, disabled: false }));
    const subjects = nodes(tree).find((node) => node.props['aria-label'] === '背景题材');
    expect(button(subjects, subject).props['aria-pressed']).toBe(true);
    if (background === '/backgrounds/v1/space-station.webp') {
      expect(nodes(tree).find((node) => node.props['aria-label'] === '轨道空间站')?.props['aria-pressed']).toBe(true);
    }
  });
  it('exposes the selected theme with pressed semantics', () => {
    const tree = render(() =>
      AppearancePanel({
        api: {
          value: { ...DEFAULT_APPEARANCE, theme: 'light' },
          persistenceError: null,
          hasSavedChanges: false,
          retryPersist: () => {},
          patch: () => {},
          setBackgroundFromFile: async () => {},
        },
        disabled: false,
      }),
    );
    const themes = nodes(tree).filter(
      (node) => node.type === 'button' && String(node.props.className).includes('theme-card'),
    );
    expect(themes.map((node) => node.props['aria-pressed'])).toEqual([false, true, false]);
  });
});
