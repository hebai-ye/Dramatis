import { conversationId, createConversation, type Message, messageId, roomId } from '@dramatis/core';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { type FocusRequest, MainChat } from './MainChat';
import { SideChat } from './SideChat';

const hooks = vi.hoisted(() => {
  let values: unknown[] = [];
  let effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0;
  let effectCursor = 0;
  let pending: (() => void)[] = [];
  return {
    reset() {
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
          values[index] = typeof next === 'function' ? (next as (old: unknown) => unknown)(values[index]) : next;
        },
      ];
    },
    ref(initial: unknown) {
      const [value] = this.state(() => ({ current: initial }));
      return value;
    },
    memo(value: unknown, deps: readonly unknown[]) {
      const index = cursor++;
      const previous = values[index] as { value: unknown; deps: readonly unknown[] } | undefined;
      if (!previous || deps.some((item, i) => previous.deps[i] !== item)) values[index] = { value, deps };
      return (values[index] as { value: unknown }).value;
    },
    effect(run: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (!previous || !deps || !previous.deps || deps.some((item, i) => item !== previous.deps?.[i])) {
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
  useRef: (initial: unknown) => hooks.ref(initial),
  useMemo: (factory: () => unknown, deps: readonly unknown[]) => hooks.memo(factory(), deps),
  useCallback: (callback: unknown, deps: readonly unknown[]) => hooks.memo(callback, deps),
  useEffect: hooks.effect,
  useLayoutEffect: hooks.effect,
  useId: () => 'test-id',
}));
vi.mock('../lib/render-count', () => ({ countRender: () => {} }));
vi.mock('../lib/viewport', () => ({ useCoarsePointer: () => false }));
vi.mock('../lib/stream-store', () => ({
  useStreamState: () => ({ text: '', progress: '', handoffId: null }),
  acknowledgeStreamHandoff: () => {},
  resetStreamState: () => {},
}));

const ROOM = roomId('room-test');
const CONVERSATION = createConversation({ roomId: ROOM, title: 'Main' });
const OTHER = createConversation({ roomId: ROOM, title: 'Other' });
function message(index: number, conversationIdValue = CONVERSATION.id): Message {
  return {
    id: messageId(`message-${index}`),
    roomId: ROOM,
    conversationId: conversationId(conversationIdValue),
    sceneId: null,
    turnId: `turn-${index}`,
    localSeq: index,
    deviceId: 'device-test',
    role: 'character',
    speakerInstanceId: null,
    speakerName: 'A',
    audience: [],
    content: `Line ${index}`,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    deletedAt: null,
  };
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
function callComponent<T>(component: unknown, props: T): ReactNode {
  hooks.begin();
  return (component as { type: (props: T) => ReactNode }).type(props);
}
function bindBody(tree: ReactNode, body: object, bottom: object): void {
  const bodyNode = nodes(tree).find((node) => node.type === 'div' && node.props.className === 'chat-body');
  if (bodyNode) (bodyNode.props.ref as { current: unknown }).current = body;
  const bottomNode = nodes(tree).find(
    (node) => node.type === 'div' && typeof node.props.ref === 'object' && node !== bodyNode,
  );
  if (bottomNode) (bottomNode.props.ref as { current: unknown }).current = bottom;
}
function mainProps(extra: Partial<ComponentProps<typeof MainChat>> = {}): ComponentProps<typeof MainChat> {
  return {
    conversation: CONVERSATION,
    scene: null,
    messages: Array.from({ length: 20 }, (_, i) => message(i + 1)),
    cast: [],
    avatars: {},
    busy: false,
    ready: true,
    archived: false,
    onSend: vi.fn(),
    onStop: vi.fn(),
    onRegenerate: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onChangeModes: vi.fn(),
    unlimitedPrompt: '',
    onOpenScene: vi.fn(),
    onDropInstance: vi.fn(),
    onReassign: vi.fn(),
    ...extra,
  };
}
function renderMain(props: ReturnType<typeof mainProps>, body: object, bottom: object): ReactNode {
  let tree = callComponent(MainChat, props);
  bindBody(tree, body, bottom);
  hooks.flush();
  tree = callComponent(MainChat, props);
  bindBody(tree, body, bottom);
  hooks.flush();
  return tree;
}

beforeEach(() => {
  hooks.reset();
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    setTimeout: () => 1,
    clearTimeout() {},
  });
  vi.stubGlobal('document', { querySelector: () => null });
});

describe('chat submission while awaiting a bridge reply', () => {
  it.each(['main', 'side'])('%s keeps the draft and does not send', (kind) => {
    const onSend = vi.fn();
    const props =
      kind === 'main'
        ? mainProps({ bridge: { stage: 'reply', prompt: 'pending' }, onSend })
        : {
            conversation: OTHER,
            messages: [],
            busy: false,
            ready: true,
            archived: false,
            bridge: { prompt: 'pending' },
            onSend,
            onStop: vi.fn(),
            onAdopt: vi.fn(),
            onDiscard: vi.fn(),
          };
    const component = kind === 'main' ? MainChat : SideChat;
    let tree = callComponent(component, props);
    hooks.flush();
    const composer = nodes(tree).find((node) => node.type === Composer);
    if (!composer) throw new Error('Composer missing');
    (composer.props.onChange as (value: string) => void)('draft');
    tree = callComponent(component, props);
    hooks.flush();
    const updated = nodes(tree).find((node) => node.type === Composer);
    if (!updated) throw new Error('Updated Composer missing');
    (updated.props.onSend as () => void)();
    tree = callComponent(component, props);
    hooks.flush();
    expect(nodes(tree).find((node) => node.type === Composer)?.props.value).toBe('draft');
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('jump to source message', () => {
  it('shows return immediately, preserves the old position on append, then resumes following', () => {
    const located = { scrollIntoView: vi.fn(), getAttribute: () => 'message-3' };
    const bottom = { scrollIntoView: vi.fn() };
    const body = { querySelectorAll: () => [located], scrollHeight: 2000, scrollTop: 200, clientHeight: 400 };
    const consumed = vi.fn();
    let props = mainProps({
      focus: { id: messageId('message-3'), seq: 1, conversationId: CONVERSATION.id },
      onFocusConsumed: consumed,
    });
    let tree = renderMain(props, body, bottom);
    expect(located.scrollIntoView).toHaveBeenCalledOnce();
    expect(consumed).toHaveBeenCalledOnce();
    tree = renderMain({ ...props, focus: null }, body, bottom);
    expect(bottom.scrollIntoView).not.toHaveBeenCalled();
    expect(textOf(tree)).toContain('回到底部');
    props = { ...props, focus: null, messages: [...props.messages, message(21)] };
    tree = renderMain(props, body, bottom);
    expect(bottom.scrollIntoView).not.toHaveBeenCalled();
    expect(textOf(tree)).toContain('有新消息');
    const jump = nodes(tree).find((node) => node.type === 'button' && textOf(node).includes('有新消息'));
    if (!jump) throw new Error('New-message button missing');
    (jump.props.onClick as () => void)();
    tree = renderMain(props, body, bottom);
    expect(bottom.scrollIntoView).toHaveBeenCalledOnce();
    expect(textOf(tree)).not.toContain('回到底部');
    const stream = nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === 'StreamingBubble');
    expect(stream?.props.suspendAutoScroll).toBe(false);
  });

  it('accepts the same id with a new seq and waits for a delayed node', () => {
    let available = false;
    const located = { scrollIntoView: vi.fn(), getAttribute: () => 'message-3' };
    const body = {
      querySelectorAll: () => (available ? [located] : []),
      scrollHeight: 2000,
      scrollTop: 200,
      clientHeight: 400,
    };
    const bottom = { scrollIntoView: vi.fn() };
    const consumed = vi.fn();
    let props = mainProps({
      focus: { id: messageId('message-3'), seq: 1, conversationId: CONVERSATION.id },
      onFocusConsumed: consumed,
    });
    renderMain(props, body, bottom);
    expect(consumed).not.toHaveBeenCalled();
    available = true;
    props = { ...props, messages: [...props.messages] };
    renderMain(props, body, bottom);
    expect(consumed).toHaveBeenCalledOnce();
    props = { ...props, focus: { id: messageId('message-3'), seq: 2, conversationId: CONVERSATION.id } };
    renderMain(props, body, bottom);
    expect(located.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(consumed).toHaveBeenCalledTimes(2);
  });

  it('ignores a focus for another conversation and resets away state on conversation switch', () => {
    const located = { scrollIntoView: vi.fn(), getAttribute: () => 'message-3' };
    const body = { querySelectorAll: () => [located], scrollHeight: 2000, scrollTop: 200, clientHeight: 400 };
    const bottom = { scrollIntoView: vi.fn() };
    const consumed = vi.fn();
    const request: FocusRequest = { id: messageId('message-3'), seq: 1, conversationId: CONVERSATION.id };
    let props = mainProps({ focus: request, onFocusConsumed: consumed });
    let tree = renderMain(props, body, bottom);
    expect(textOf(tree)).toContain('回到底部');
    props = { ...props, conversation: OTHER, messages: [message(1, OTHER.id)] };
    tree = renderMain(props, body, bottom);
    expect(located.scrollIntoView).toHaveBeenCalledOnce();
    expect(textOf(tree)).not.toContain('回到底部');
  });

  it('waits for the requested conversation even when another conversation has the same message id', () => {
    const located = { scrollIntoView: vi.fn(), getAttribute: () => 'message-3' };
    const body = { querySelectorAll: () => [located], scrollHeight: 2000, scrollTop: 200, clientHeight: 400 };
    const bottom = { scrollIntoView: vi.fn() };
    const consumed = vi.fn();
    const request: FocusRequest = { id: messageId('message-3'), seq: 4, conversationId: CONVERSATION.id };
    const props = mainProps({
      conversation: OTHER,
      messages: [message(3, OTHER.id)],
      focus: request,
      onFocusConsumed: consumed,
    });
    renderMain(props, body, bottom);
    expect(located.scrollIntoView).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
    renderMain({ ...props, conversation: CONVERSATION, messages: [message(3)] }, body, bottom);
    expect(located.scrollIntoView).toHaveBeenCalledOnce();
    expect(consumed).toHaveBeenCalledOnce();
  });

  it('manual scrolling back to bottom clears the return state', () => {
    const located = { scrollIntoView: vi.fn(), getAttribute: () => 'message-3' };
    const body = { querySelectorAll: () => [located], scrollHeight: 2000, scrollTop: 200, clientHeight: 400 };
    const bottom = { scrollIntoView: vi.fn() };
    const props = mainProps({
      focus: { id: messageId('message-3'), seq: 1, conversationId: CONVERSATION.id },
      onFocusConsumed: vi.fn(),
    });
    let tree = renderMain(props, body, bottom);
    expect(textOf(tree)).toContain('回到底部');
    body.scrollTop = 1600;
    const chatBody = nodes(tree).find((node) => node.type === 'div' && node.props.className === 'chat-body');
    if (!chatBody) throw new Error('Chat body missing');
    (chatBody.props.onScroll as () => void)();
    tree = renderMain({ ...props, focus: null }, body, bottom);
    expect(textOf(tree)).not.toContain('回到底部');
    const stream = nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === 'StreamingBubble');
    expect(stream?.props.suspendAutoScroll).toBe(false);
  });
});
