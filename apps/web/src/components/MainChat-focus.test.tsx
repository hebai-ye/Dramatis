import { createConversation, messageId, roomId } from '@dramatis/core';
import type { ReactElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MainChat } from './MainChat';
import { StreamingBubble } from './StreamingBubble';

const host = vi.hoisted(() => {
  let cells: unknown[] = [];
  let cursor = 0;
  let effects: (() => unknown)[] = [];
  let effectIndex = 0;
  let dependencies: (readonly unknown[] | undefined)[] = [];
  return {
    state(initial: unknown) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
      return [
        cells[i],
        (next: unknown) => {
          cells[i] = typeof next === 'function' ? next(cells[i]) : next;
        },
      ];
    },
    ref(initial: unknown) {
      const i = cursor++;
      cells[i] ??= { current: initial };
      return cells[i];
    },
    effect(run: () => unknown, deps?: readonly unknown[]) {
      const index = effectIndex++;
      const previous = dependencies[index];
      if (
        previous &&
        deps &&
        previous.length === deps.length &&
        previous.every((value, i) => Object.is(value, deps[i]))
      )
        return;
      dependencies[index] = deps;
      effects.push(run);
    },
    begin() {
      cursor = 0;
      effectIndex = 0;
      effects = [];
    },
    flush() {
      for (const run of effects) run();
    },
    reset() {
      cells = [];
      dependencies = [];
      cursor = 0;
      effectIndex = 0;
      effects = [];
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: host.state,
  useRef: host.ref,
  useEffect: host.effect,
  useLayoutEffect: host.effect,
  useMemo: (run: () => unknown) => run(),
  useCallback: (run: unknown) => run,
  useId: () => 'id',
  useContext: () => null,
}));
vi.mock('../lib/viewport', () => ({ useCoarsePointer: () => false }));
vi.mock('../lib/render-count', () => ({ countRender: () => {} }));
vi.mock('../lib/chat-visibility', () => ({
  useChatViewportVisibility: () => ({
    visible: true,
    visibleRef: { current: true },
    scrollVisibility: { followHiddenRef: { current: true } },
  }),
}));
function find(node: unknown, className: string): ReactElement<Record<string, unknown>> | null {
  if (!node || typeof node !== 'object') return null;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.props?.className === className || (className === 'stream' && element.type === StreamingBubble))
    return element;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = find(child, className);
    if (found) return found;
  }
  return null;
}
beforeEach(() => {
  host.reset();
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }), setTimeout: () => 1, clearTimeout: () => {} });
});
it.each([
  ['button', 400],
  ['button', 1200],
  ['scroll', 400],
  ['scroll', 1200],
] as const)('定位消费后保持阅读，%s 回底恢复跟随（目标top=%i）', (resume, targetTop) => {
  const conversation = createConversation({ roomId: roomId('synthetic'), title: 'Focus' });
  const node = { dataset: { messageId: 'target' }, getBoundingClientRect: () => ({ top: targetTop, height: 60 }) };
  const body = {
    querySelectorAll: () => [node],
    scrollTop: 0,
    scrollHeight: 1600,
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 0 }),
    scrollTo: vi.fn(),
  };
  const consumed = vi.fn();
  const props = {
    conversation,
    scene: null,
    messages: [{ id: 'last', content: 'same', role: 'player' }],
    cast: [],
    avatars: {},
    busy: false,
    ready: true,
    archived: false,
    unlimitedPrompt: '',
    onSend: vi.fn(),
    onFocusConsumed: consumed,
  };
  const render = (focus: unknown) => {
    host.begin();
    const tree = (MainChat as unknown as { type: (props: unknown) => unknown }).type({ ...props, focus });
    const bodyElement = find(tree, 'chat-body');
    (bodyElement?.props.ref as { current: unknown }).current = body;
    host.flush();
    return tree;
  };
  render({ id: messageId('target'), seq: 1, conversationId: conversation.id });
  expect(consumed).toHaveBeenCalledWith(1, true);
  expect(body.scrollTo).toHaveBeenCalledTimes(1);
  render(null);
  expect(body.scrollTo).toHaveBeenCalledTimes(1);
  const tree = render(null);
  expect(find(tree, 'stream')?.props.suspendAutoScroll).toBe(true);
  body.scrollTop = 930; // inside StreamingBubble's physical follow threshold
  const bodyElement = find(tree, 'chat-body');
  if (!bodyElement) throw new Error('Chat body missing');
  (bodyElement.props.onScroll as () => void)();
  expect(find(render(null), 'stream')?.props.suspendAutoScroll).toBe(true);
  if (resume === 'button') {
    const jump = find(render(null), 'jump-to-latest');
    if (!jump) throw new Error('Return-to-latest button missing');
    (jump.props.onClick as () => void)();
  } else {
    body.scrollTop = body.scrollHeight - body.clientHeight;
    (bodyElement.props.onScroll as () => void)();
  }
  expect(find(render(null), 'stream')?.props.suspendAutoScroll).toBe(false);
  expect(consumed).toHaveBeenCalledTimes(1);
});
it('找不到目标也消费请求，避免永久阻断流式跟随', () => {
  const consumed = vi.fn();
  const conversation = createConversation({ roomId: roomId('synthetic'), title: 'Missing' });
  host.begin();
  const tree = (MainChat as unknown as { type: (props: unknown) => unknown }).type({
    conversation,
    scene: null,
    messages: [],
    cast: [],
    avatars: {},
    busy: false,
    ready: true,
    archived: false,
    unlimitedPrompt: '',
    onSend: vi.fn(),
    focus: { id: messageId('gone'), seq: 2, conversationId: conversation.id, settled: true },
    onFocusConsumed: consumed,
  });
  (find(tree, 'chat-body')?.props.ref as { current: unknown }).current = { querySelectorAll: () => [] };
  host.flush();
  expect(consumed).toHaveBeenCalledWith(2, false);
});
