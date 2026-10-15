import {
  conversationId,
  createBlankCard,
  createConversation,
  evaluateBudget,
  instanceId,
  type Message,
  messageId,
  roomId,
  type Scene,
  sceneId,
} from '@dramatis/core';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CastPanel } from './CastPanel';
import { MainChat } from './MainChat';
import { type MessageHandlers, MessageItem, MessageList } from './MessageItem';
import { RuntimePanel } from './RuntimePanel';
import { ScenePanel } from './ScenePanel';

const host = vi.hoisted(() => {
  let values: unknown[] = [],
    cursor = 0,
    effectCursor = 0;
  let effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [],
    pending: (() => void)[] = [];
  return {
    begin() {
      cursor = 0;
      effectCursor = 0;
    },
    flush() {
      const runs = pending;
      pending = [];
      for (const run of runs) run();
    },
    reset() {
      for (const effect of effects) effect.cleanup?.();
      values = [];
      effects = [];
      pending = [];
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
      if (
        previous?.deps &&
        deps &&
        deps.length === previous.deps.length &&
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
  useCallback: (callback: unknown) => callback,
  useMemo: (callback: () => unknown) => callback(),
  useId: () => 'edit-fixture',
}));
vi.mock('../lib/render-count', () => ({ countRender: () => {} }));
vi.mock('../lib/viewport', () => ({ useCoarsePointer: () => false }));
vi.mock('../lib/chat-draft', () => ({
  useChatDraft: () => ({ input: '', setInput: () => {}, submit: () => {}, notice: null }),
}));
vi.mock('../lib/chat-visibility', () => ({
  useChatViewportVisibility: () => ({ visible: true, visibleRef: { current: true }, scrollVisibility: {} }),
}));
function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as ReactElement<Record<string, unknown>>;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function requireNode(node: ReactElement<Record<string, unknown>> | undefined) {
  if (!node) throw new Error('Missing component fixture');
  return node;
}
function text(tree: ReactNode): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  return typeof tree === 'object' ? text((tree as ReactElement<{ children: ReactNode }>).props.children) : String(tree);
}
function render<T>(run: () => T) {
  host.begin();
  const tree = run();
  host.flush();
  return tree;
}
function gate() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const message: Message = {
  id: messageId('message-a'),
  roomId: roomId('world-a'),
  conversationId: conversationId('conversation-a'),
  sceneId: sceneId('scene-a'),
  turnId: 'turn-a',
  localSeq: 1,
  deviceId: 'device-a',
  role: 'player',
  speakerInstanceId: null,
  speakerName: '我',
  audience: [],
  content: '原消息',
  createdAt: '',
  updatedAt: '',
  deletedAt: null,
};
const emptyHandlers: MessageHandlers = {
  onContextMenu: () => {},
  onPressStart: () => {},
  onPressCancel: () => {},
  onClickCapture: () => {},
  onStartEdit: () => {},
  onCancelEdit: () => {},
  onEdit: () => {},
  onRegenerate: () => {},
  onDelete: () => {},
  onReassign: () => {},
};
beforeEach(() => {
  host.reset();
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: () => {},
  });
});
afterEach(() => {
  host.reset();
  vi.unstubAllGlobals();
});

describe('manual message edit', () => {
  it('retains the draft and shows a retryable failure while rejecting duplicate clicks', async () => {
    const deferred = gate();
    let attempts = 0;
    const tree = render(() =>
      MessageItem.type({
        message,
        cast: [],
        avatars: {},
        isLastCharacter: false,
        editing: true,
        highlighted: false,
        menuOpen: false,
        showIntent: false,
        archived: false,
        manualMode: false,
        signatures: [],
        handlers: {
          ...emptyHandlers,
          onEdit: () => {
            attempts++;
            return deferred.promise;
          },
        },
      }),
    );
    const editNode = nodes(tree).find((node) => typeof node.type === 'function');
    if (!editNode) throw new Error('Missing editor');
    host.reset();
    const edit = () => render(() => (editNode.type as (props: Record<string, unknown>) => ReactNode)(editNode.props));
    let editor = edit();
    const field = nodes(editor).find((node) => node.type === 'textarea');
    (requireNode(field).props.onChange as (event: unknown) => void)({ target: { value: '失败后保留的稿' } });
    editor = edit();
    const save = nodes(editor).find(
      (node) => node.type === 'button' && text(node.props.children as ReactNode) === '保存',
    );
    const saving = (requireNode(save).props.onClick as () => unknown)();
    (requireNode(save).props.onClick as () => unknown)();
    editor = edit();
    expect(nodes(editor).find((node) => node.type === 'button')?.props.disabled).toBe(true);
    expect(attempts).toBe(1);
    deferred.reject(new Error('写入失败'));
    await saving;
    editor = edit();
    expect(nodes(editor).find((node) => node.type === 'textarea')?.props.value).toBe('失败后保留的稿');
    expect(nodes(editor).some((node) => node.props.role === 'alert')).toBe(true);
  });

  it('does not offer native-only composing text as the next serial save', async () => {
    const deferred = gate();
    let readLatest: (() => string | null) | null = null;
    const tree = render(() =>
      MessageItem.type({
        message,
        cast: [],
        avatars: {},
        isLastCharacter: false,
        editing: true,
        highlighted: false,
        menuOpen: false,
        showIntent: false,
        archived: false,
        manualMode: false,
        signatures: [],
        handlers: {
          ...emptyHandlers,
          onEdit: (_id, _content, latest) => {
            readLatest = latest ?? null;
            return deferred.promise;
          },
        },
      }),
    );
    const editNode = nodes(tree).find((node) => typeof node.type === 'function');
    const editorNode = requireNode(editNode);
    host.reset();
    const edit = () =>
      render(() => (editorNode.type as (props: Record<string, unknown>) => ReactNode)(editorNode.props));
    const editor = edit();
    const save = nodes(editor).find(
      (node) => node.type === 'button' && text(node.props.children as ReactNode) === '保存',
    );
    const saving = (requireNode(save).props.onClick as () => Promise<void>)();
    const field = nodes(edit()).find((node) => node.type === 'textarea');
    (requireNode(field).props.onChange as (event: unknown) => void)({
      target: { value: '输入法中间字' },
      nativeEvent: { isComposing: true },
    });
    expect((readLatest as unknown as () => string | null)()).toBeNull();
    deferred.resolve();
    await saving;
  });
});

function mainProps(onEdit: (id: Message['id'], content: string) => Promise<void>) {
  return {
    conversation: createConversation({
      roomId: roomId('world-a'),
      title: '对话A',
      id: conversationId('conversation-a'),
    }),
    scene: null,
    messages: [message],
    cast: [],
    avatars: {},
    busy: false,
    ready: true,
    archived: false,
    onSend: () => ({ status: 'accepted' as const }),
    onStop: () => {},
    onRegenerate: () => {},
    onEdit,
    onDelete: () => {},
    onChangeModes: () => {},
    unlimitedPrompt: '',
    onOpenScene: () => {},
    onDropInstance: () => {},
    onReassign: () => {},
  };
}
function main(props: Parameters<typeof MainChat.type>[0]) {
  const tree = render(() => MainChat.type(props));
  const list = nodes(tree).find((node) => node.type === MessageList);
  if (!list) throw new Error('Missing message list');
  return list.props as { editingId: Message['id'] | null; handlers: MessageHandlers };
}

describe('message save completion belongs to its editing target', () => {
  it('keeps editing during slow saves and serially persists a newer draft before closing', async () => {
    const first = gate(),
      second = gate();
    let latest = '第一稿';
    const stored: string[] = [];
    const props = mainProps(async (_id, content) => {
      await (stored.length === 0 ? first.promise : second.promise);
      stored.push(content);
    });
    main(props).handlers.onStartEdit(message.id);
    const saving = main(props).handlers.onEdit(message.id, latest, () => latest);
    expect(main(props).editingId).toBe(message.id);
    latest = '保存中继续写的最终稿';
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(main(props).editingId).toBe(message.id);
    second.resolve();
    await saving;
    expect(stored).toEqual(['第一稿', '保存中继续写的最终稿']);
    expect(main(props).editingId).toBeNull();
  });

  it('does not close another message editor when an older save settles', async () => {
    const deferred = gate(),
      props = mainProps(() => deferred.promise);
    main(props).handlers.onStartEdit(message.id);
    const saving = main(props).handlers.onEdit(message.id, 'A稿');
    const otherId = messageId('message-b');
    main(props).handlers.onStartEdit(otherId);
    deferred.resolve();
    await saving;
    expect(main(props).editingId).toBe(otherId);
  });

  it('propagates write failure and leaves the failed message editor open', async () => {
    const props = mainProps(() => Promise.reject(new Error('不可写')));
    main(props).handlers.onStartEdit(message.id);
    await expect(main(props).handlers.onEdit(message.id, '保留稿')).rejects.toThrow('不可写');
    expect(main(props).editingId).toBe(message.id);
  });

  it('keeps the editor open when IME composition begins during an in-flight save', async () => {
    const deferred = gate(),
      saved: string[] = [];
    const props = mainProps(async (_id, content) => {
      await deferred.promise;
      saved.push(content);
    });
    main(props).handlers.onStartEdit(message.id);
    const saving = main(props).handlers.onEdit(message.id, '已完成稿', () => null);
    deferred.resolve();
    await saving;
    expect(saved).toEqual(['已完成稿']);
    expect(main(props).editingId).toBe(message.id);
  });
});

function runtimeProps() {
  return {
    open: true,
    focusOnOpen: false,
    onClose: () => {},
    scene: {
      id: sceneId('scene-a'),
      roomId: roomId('world-a'),
      conversationId: null,
      title: '原场景',
      location: '',
      worldTime: '',
      summary: '',
      castPolicy: 'locked' as const,
      cast: [],
      createdAt: '',
      updatedAt: '',
      endedAt: null,
      deletedAt: null,
    },
    instances: [],
    memories: [],
    conversations: [],
    activeConversationId: null,
    personas: [],
    personaId: null,
    playerName: '我',
    chapters: [],
    attachedWorldBooks: [],
    libraryCards: [],
    worldCards: [],
    prompt: null,
    pending: 0,
    extraCalls: 0,
    usage: { world: null, conversation: null, latestTurn: null },
    budget: evaluateBudget(null, null),
    budgetLimits: null,
    onSaveBudget: () => {},
    conversationTitle: '对话A',
    workerError: null,
    disabled: false,
    onSceneChange: () => {},
    onStartNewScene: () => {},
    onSetPresence: () => {},
    onSelectPersona: () => {},
    onRenameInstance: () => {},
    onRemoveInstance: () => {},
    onAddInstance: () => {},
    onDetachWorldBook: () => {},
    onUpdateMemory: () => {},
    onDeleteMemory: () => {},
    onLocateMemory: () => {},
  };
}

describe('runtime panel leave flush', () => {
  it('adding from the library waits for the scene write and preserves both changes', async () => {
    const first = gate(),
      calls: string[] = [],
      castId = instanceId('library-added');
    let stored: Scene = { ...runtimeProps().scene };
    const props = {
      ...runtimeProps(),
      libraryCards: [createBlankCard({ name: 'Synthetic available card' })],
      onSceneChange: async (patch: Partial<Scene>) => {
        calls.push('scene');
        const next = { ...stored, ...patch };
        await first.promise;
        stored = next;
      },
      onAddInstance: async () => {
        calls.push('add');
        stored = { ...stored, cast: [castId] };
      },
    };
    const tree = render(() => RuntimePanel.type(props));
    const sceneNode = requireNode(nodes(tree).find((node) => node.type === ScenePanel));
    const saving = (sceneNode.props.onChange as (patch: Partial<Scene>) => Promise<void>)({
      location: 'Saved location',
    });
    const add = requireNode(
      nodes(tree).find((node) => node.type === 'button' && text(node.props.children as ReactNode) === '加入场景'),
    );
    (add.props.onClick as () => void)();
    await Promise.resolve();
    expect(calls).toEqual(['scene']);
    first.resolve();
    await saving;
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(calls).toEqual(['scene', 'add']);
    expect(stored.location).toBe('Saved location');
    expect(stored.cast).toEqual([castId]);
  });
  it('serializes scene and cast callbacks sharing the same scene snapshot', async () => {
    const first = gate(),
      castId = instanceId('cast-a'),
      calls: string[] = [];
    let stored: Scene = { ...runtimeProps().scene };
    const props = {
      ...runtimeProps(),
      onSceneChange: async (patch: Partial<Scene>) => {
        calls.push('scene');
        const next = { ...stored, ...patch };
        await first.promise;
        stored = next;
      },
      onSetPresence: async () => {
        calls.push('cast');
        stored = { ...stored, cast: [castId] };
      },
    };
    const tree = render(() => RuntimePanel.type(props));
    const sceneNode = requireNode(nodes(tree).find((node) => node.type === ScenePanel));
    const castNode = requireNode(nodes(tree).find((node) => node.type === CastPanel));
    const savingScene = (sceneNode.props.onChange as (patch: Partial<Scene>) => Promise<void>)({ location: '新地点' });
    const savingCast = (castNode.props.onSetPresence as (id: string, presence: string) => Promise<void>)(
      castId,
      'onstage',
    );
    await Promise.resolve();
    expect(calls).toEqual(['scene']);
    first.resolve();
    await Promise.all([savingScene, savingCast]);
    expect(stored.location).toBe('新地点');
    expect(stored.cast).toEqual([castId]);
  });

  it('waits before switching tabs and retains the scene page when a registered save fails', async () => {
    const deferred = gate(),
      props = runtimeProps();
    const runtime = () => render(() => RuntimePanel.type(props));
    const sceneNode = nodes(runtime()).find((node) => node.type === ScenePanel);
    expect(typeof sceneNode?.props.onRegisterFlush).toBe('function');
    (requireNode(sceneNode).props.onRegisterFlush as (flush: () => Promise<boolean>) => void)(() =>
      deferred.promise.then(() => false),
    );
    const memory = nodes(runtime()).find(
      (node) => node.type === 'button' && text(node.props.children as ReactNode) === '记忆',
    );
    const leaving = (requireNode(memory).props.onClick as () => unknown)();
    expect(nodes(runtime()).some((node) => node.type === ScenePanel)).toBe(true);
    deferred.resolve();
    await leaving;
    expect(nodes(runtime()).some((node) => node.type === ScenePanel)).toBe(true);
    expect(nodes(runtime()).some((node) => node.props.role === 'alert')).toBe(true);
  });

  it('registers an external leave guard that awaits scene and cast edits', async () => {
    let guard: (() => Promise<boolean>) | null = null;
    const props = {
      ...runtimeProps(),
      onRegisterFlush: (flush: (() => Promise<boolean>) | null) => {
        guard = flush;
      },
    };
    const tree = render(() => RuntimePanel.type(props));
    expect(guard).not.toBeNull();
    const sceneNode = nodes(tree).find((node) => node.type === ScenePanel);
    (requireNode(sceneNode).props.onRegisterFlush as (flush: () => Promise<boolean>) => void)(async () => false);
    expect(await (guard as unknown as () => Promise<boolean>)()).toBe(false);
  });
});
