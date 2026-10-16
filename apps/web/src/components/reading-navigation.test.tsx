import {
  type AssembledPrompt,
  createConversation,
  eventId,
  instanceId,
  type MemoryEvent,
  roomId,
} from '@dramatis/core';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PlanPage } from '../plan/PlanPage';
import { ArchivedConversationsPanel } from './ArchivedConversationsPanel';
import { DataSettingsPanel } from './DataSettingsPanel';
import { MemoryPanel } from './MemoryPanel';
import { PromptInspector } from './PromptInspector';
import { SettingsDialog } from './SettingsDialog';
import { WorldTree } from './WorldTree';

const host = vi.hoisted(() => {
  let values: unknown[] = [],
    cursor = 0;
  let effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [],
    effectCursor = 0;
  let pending: (() => void)[] = [];
  return {
    begin() {
      cursor = 0;
      effectCursor = 0;
    },
    reset() {
      for (const effect of effects) effect.cleanup?.();
      values = [];
      effects = [];
      pending = [];
    },
    flush() {
      const runs = pending;
      pending = [];
      for (const run of runs) run();
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
      const index = effectCursor++,
        previous = effects[index];
      if (previous && deps && previous.deps && deps.every((v, i) => Object.is(v, previous.deps?.[i]))) return;
      pending.push(() => {
        previous?.cleanup?.();
        effects[index] = { deps, cleanup: run() };
      });
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  memo: (component: unknown) => component,
  useState: host.state,
  useEffect: host.effect,
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useRef: (initial: unknown) => host.state(() => ({ current: initial }))[0],
}));
vi.mock('./DialogShell', () => ({
  useDialogActions: () => ({ setGuard: () => {}, requestAction: (action: () => void) => action() }),
}));
function render(component: () => ReactNode) {
  host.begin();
  component();
  host.flush();
  host.begin();
  const tree = component();
  host.flush();
  return tree;
}
function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as ReactElement<Record<string, unknown>>;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function text(tree: ReactNode): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return text((tree as ReactElement<{ children: ReactNode }>).props.children);
}
function button(tree: ReactNode, label: string) {
  const found = nodes(tree).find((n) => n.type === 'button' && text(n.props.children as ReactNode) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function click(node: ReactElement<Record<string, unknown>>) {
  return (node.props.onClick as () => unknown)();
}
const storage = { getItem: vi.fn<() => string | null>(() => null), setItem: vi.fn() };
beforeEach(() => {
  host.reset();
  storage.getItem.mockReset().mockReturnValue(null);
  storage.setItem.mockReset();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { confirm: vi.fn(() => false) });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => {
  host.reset();
  vi.unstubAllGlobals();
});

it('lets observer memories open for editing in contrast without an objective entry', () => {
  const conversation = createConversation({ roomId: roomId('fixture'), title: 'Fixture' });
  const memory: MemoryEvent = {
    id: eventId('memory'),
    roomId: conversation.roomId,
    conversationId: conversation.id,
    sceneId: null,
    timeline: { worldTime: '', sequence: 1 },
    location: '',
    participants: [],
    summary: 'Remembered',
    observerId: instanceId('observer'),
    perception: 'Subjective',
    importance: 0.5,
    pinned: false,
    importanceLocked: false,
    affects: [],
    sourceTurnIds: ['turn'],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    lastRecalledAt: null,
    recallCount: 0,
    deletedAt: null,
  };
  const props = {
    memories: [memory],
    instances: [],
    conversations: [conversation],
    activeConversationId: conversation.id,
    pending: 0,
    extraCalls: 0,
    chapters: [],
    cards: [],
    workerError: null,
    disabled: false,
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
  };
  let tree = render(() => MemoryPanel(props));
  click(button(tree, '对照'));
  tree = render(() => MemoryPanel(props));
  click(button(tree, '改视角'));
  tree = render(() => MemoryPanel(props));
  expect(nodes(tree).some((n) => n.props.className === 'memory-editor')).toBe(true);
});

it('searches local names while preserving selected IDs and rename targets', () => {
  const conversation = createConversation({ roomId: roomId('w1'), title: '长对话名称' });
  const rename = vi.fn();
  const props = {
    worlds: ['w1', 'w2'].map((id) => ({
      id: roomId(id),
      title: '同名世界',
      messageCount: 1,
      instanceCount: 0,
      conversationCount: 1,
      updatedAt: '',
    })),
    activeWorldId: roomId('w1'),
    conversations: [conversation],
    activeConversationId: conversation.id,
    disabled: false,
    onOpenWorld: vi.fn(),
    onNewConversation: vi.fn(),
    onOpenConversation: vi.fn(),
    onArchiveConversation: vi.fn(),
    onRenameConversation: rename,
    onDeleteConversation: vi.fn(),
    onDeleteWorld: vi.fn(),
  };
  const component = WorldTree as unknown as (p: typeof props) => ReactNode;
  let tree = render(() => component(props));
  const search = nodes(tree).find((n) => n.type === 'input' && n.props.type === 'search');
  expect(search).toBeDefined();
  if (!search) throw new Error('Missing search');
  (search.props.onChange as (e: unknown) => void)({ target: { value: '长对话' } });
  tree = render(() => component(props));
  expect(nodes(tree).filter((n) => n.props.className === 'world-open')).toHaveLength(1);
  expect(nodes(tree).find((n) => n.props.className === 'conversation-open')?.props['aria-current']).toBe('page');
  const renameButton = nodes(tree).find((n) => n.type === 'button' && n.props.title === '改这条对话的名字');
  if (!renameButton) throw new Error('Missing rename');
  click(renameButton);
  tree = render(() => component(props));
  const input = nodes(tree).find((n) => n.props.className === 'conversation-rename');
  if (!input) throw new Error('Missing rename input');
  (input.props.onChange as (e: unknown) => void)({ target: { value: '新的名字' } });
  tree = render(() => component(props));
  const updated = nodes(tree).find((n) => n.props.className === 'conversation-rename');
  if (!updated) throw new Error('Missing rename input');
  (updated.props.onKeyDown as (e: unknown) => void)({ key: 'Enter' });
  expect(rename).toHaveBeenCalledWith(conversation, '新的名字');
  expect(props.onOpenConversation).not.toHaveBeenCalled();
});

it('shows the selected world scope and archive count, including an explicit no-world state', () => {
  const conversation = createConversation({ roomId: roomId('w1'), title: 'Fixture archive' });
  const props = {
    worldTitle: 'Fixture world',
    archivedConversations: [conversation],
    activeConversationId: null,
    disabled: false,
    onOpenArchived: vi.fn(),
    onDeleteArchived: vi.fn(async () => ({ ok: true, message: '' })),
    onExportTranscript: vi.fn(async () => null),
  };
  let tree = render(() => ArchivedConversationsPanel(props));
  expect(text(tree)).toContain('当前世界「Fixture world」 · 1 条归档对话');
  tree = render(() => ArchivedConversationsPanel({ ...props, worldTitle: null, archivedConversations: [] }));
  expect(text(tree)).toContain('当前未打开世界');
});

it('passes world context through settings and names the actual backup scope', () => {
  const props = {
    worldTitle: 'Fixture world',
    activeConversationId: null,
    disabled: false,
    onExportArchive: vi.fn(async () => null),
    onImportArchive: vi.fn(async () => null),
    backendKind: 'memory',
    storage: {
      status: { supported: true, persisted: null, usage: null, quota: null },
      ratio: null,
      canInstall: false,
      requestPersist: async () => false,
      installApp: async () => 'unavailable' as const,
      reload: async () => {},
    },
  };
  const tree = render(() => DataSettingsPanel(props));
  expect(text(tree)).toContain('导出范围：当前世界「Fixture world」');
  expect(button(tree, '导出这个世界').props.disabled).toBe(true);
  const settings = SettingsDialog({
    ...props,
    category: 'data',
    onCategoryChange: vi.fn(),
    archivedConversations: [],
    providers: {} as Parameters<typeof SettingsDialog>[0]['providers'],
    appearance: {} as Parameters<typeof SettingsDialog>[0]['appearance'],
    onOpenArchived: vi.fn(),
    onDeleteArchived: vi.fn(async () => ({ ok: true, message: '' })),
    onExportTranscript: vi.fn(async () => null),
  });
  const panel = nodes(settings).find((n) => n.props.label === '数据与备份' && n.props.panelProps);
  if (!panel) throw new Error('Missing data panel');
  expect((panel.props.panelProps as { worldTitle: string }).worldTitle).toBe('Fixture world');
});

it('reports failed local saves and clipboard rejection with selectable report text', async () => {
  storage.setItem.mockImplementation(() => {
    throw new Error('quota');
  });
  let tree = render(() => PlanPage());
  expect(text(tree)).toContain('保存失败');
  vi.stubGlobal('navigator', {
    clipboard: {
      writeText: vi.fn(async () => {
        throw new Error('denied');
      }),
    },
  });
  await click(button(tree, '复制规划文本'));
  tree = render(() => PlanPage());
  expect(text(tree)).toContain('复制失败');
  expect(nodes(tree).some((n) => n.type === 'textarea' && n.props.readOnly === true)).toBe(true);
});

it('keeps planning notes when clear is cancelled and clears only on confirmation', () => {
  storage.getItem.mockReturnValue('{"mainBody":"Keep this"}');
  let tree = render(() => PlanPage());
  click(button(tree, '清空'));
  tree = render(() => PlanPage());
  expect(storage.setItem).toHaveBeenLastCalledWith('dramatis.plan.v1', '{"mainBody":"Keep this"}');
  vi.stubGlobal('window', { confirm: vi.fn(() => true) });
  click(button(tree, '清空'));
  render(() => PlanPage());
  expect(storage.setItem).toHaveBeenLastCalledWith('dramatis.plan.v1', '{}');
});

it('does not overwrite an unreadable existing planning record until the user edits', () => {
  storage.getItem.mockReturnValue('invalid-json');
  const tree = render(() => PlanPage());
  expect(text(tree)).toContain('读取失败');
  expect(storage.setItem).not.toHaveBeenCalled();
  const region = nodes(tree).find((n) => n.props.spec && (n.props.spec as { id: string }).id === 'mainBody');
  if (!region) throw new Error('Missing plan region');
  (region.props.onChange as (value: string) => void)('New plan');
  render(() => PlanPage());
  expect(storage.setItem).toHaveBeenCalledWith('dramatis.plan.v1', '{"mainBody":"New plan"}');
});

it('labels every planning input and keeps the textual preview available without clipboard access', () => {
  const tree = render(() => PlanPage());
  const regions = nodes(tree).filter((n) => typeof n.type === 'function' && n.props.spec);
  expect(regions).toHaveLength(11);
  for (const node of regions) {
    const region = (node.type as (props: Record<string, unknown>) => ReactNode)(node.props);
    const label = nodes(region).find((n) => n.type === 'label');
    const input = nodes(region).find((n) => n.type === 'textarea');
    expect(label?.props.htmlFor).toBe(input?.props.id);
  }
});

it('keeps prompt source context while searching and reports rejected block copies', async () => {
  const prompt: AssembledPrompt = {
    report: { usedTokens: 10, maxTokens: 100, stages: [], dropped: [], compressed: [], fits: true },
    tokenEstimate: 10,
    messages: [{ role: 'user', content: 'needle' }],
    blocks: [{ id: 'a', label: 'A', kind: 'history', content: 'needle', priority: 1, droppable: true }],
    memoryStats: { recall: 0, mention: 0, source: 0 },
    historyStats: { total: 1, visible: 1, collapsed: 0, recalled: 0 },
  };
  const props = { prompt, sourceLabel: '副对话 · Fixture · 草稿上下文', preparedAt: '2026-01-01T00:00:00.000Z' };
  let tree = render(() => PromptInspector(props));
  expect(text(tree)).toContain(props.sourceLabel);
  vi.stubGlobal('navigator', {
    clipboard: {
      writeText: vi.fn(async () => {
        throw new Error('denied');
      }),
    },
  });
  await click(button(tree, '复制区块'));
  tree = render(() => PromptInspector(props));
  expect(text(tree)).toContain('复制失败');
  const input = nodes(tree).find((n) => n.type === 'input' && n.props.type === 'search');
  if (!input) throw new Error('Missing prompt search');
  (input.props.onChange as (event: unknown) => void)({ target: { value: 'unmatched' } });
  tree = render(() => PromptInspector(props));
  expect(text(tree)).toContain('没有匹配文本');
  expect(text(tree)).toContain(props.sourceLabel);
});
