import { createConversation, createProviderProfile, roomId } from '@dramatis/core';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPEARANCE } from '../lib/appearance';
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
    appearance: { value: DEFAULT_APPEARANCE, patch: () => {}, setBackgroundFromFile: async () => {} },
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

  it('exposes the selected theme with pressed semantics', () => {
    const tree = render(() =>
      AppearancePanel({
        api: {
          value: { ...DEFAULT_APPEARANCE, theme: 'light' },
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
