import { createConversation, roomId } from '@dramatis/core';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MainChat } from './MainChat';
import { SideChat } from './SideChat';

const host = vi.hoisted(() => {
  let cells: unknown[] = [];
  let cursor = 0;
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
    begin() {
      cursor = 0;
    },
    reset() {
      cells = [];
      cursor = 0;
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: host.state,
  useRef: host.ref,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (run: () => unknown) => run(),
  useCallback: (run: unknown) => run,
  useId: () => 'id',
  useContext: () => null,
}));
vi.mock('../lib/viewport', () => ({ useCoarsePointer: () => false }));
vi.mock('../lib/render-count', () => ({ countRender: () => {} }));
vi.mock('../lib/chat-visibility', () => ({
  useChatViewportVisibility: () => ({ visible: true, visibleRef: { current: true }, scrollVisibility: {} }),
}));
vi.mock('../lib/stream-store', () => ({
  useStreamState: () => ({ text: '', progress: '', handoffId: null }),
  resetStreamState: () => {},
  acknowledgeStreamHandoff: () => {},
}));
function composer(
  node: unknown,
): ReactElement<{ value: string; onChange: (text: string) => void; onSend: () => void }> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === 'function' && element.type.name === 'Composer')
    return element as ReturnType<typeof composer>;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = composer(child);
    if (found) return found;
  }
  return undefined;
}
function render(
  kind: 'main' | 'side',
  onSend: (text: string) => unknown,
  bridge: unknown = null,
  conversation = createConversation({ roomId: roomId('world'), title: 'test', kind }),
) {
  host.begin();
  const component = (kind === 'main' ? MainChat : SideChat) as unknown as { type: (props: unknown) => unknown };
  return composer(
    component.type({
      conversation,
      scene: null,
      messages: [],
      cast: [],
      avatars: {},
      busy: false,
      ready: true,
      archived: false,
      unlimitedPrompt: '',
      onSend,
      bridge,
      onStop: vi.fn(),
      onRegenerate: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onChangeModes: vi.fn(),
      onOpenScene: vi.fn(),
      onDropInstance: vi.fn(),
      onReassign: vi.fn(),
      onAdopt: vi.fn(),
      onDiscard: vi.fn(),
    }),
  );
}
async function drain() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
beforeEach(() => host.reset());
describe('聊天发送只清被接受的原稿', () => {
  for (const kind of ['main', 'side'] as const) {
    it(`${kind} 对话草稿独立且可返回`, () => {
      const a = createConversation({ roomId: roomId('world'), title: 'A', kind });
      const b = createConversation({ roomId: roomId('world'), title: 'B', kind });
      const send = vi.fn();
      render(kind, send, null, a)?.props.onChange('draft-A');
      expect(render(kind, send, null, b)?.props.value).toBe('');
      render(kind, send, null, b)?.props.onChange('draft-B');
      expect(render(kind, send, null, a)?.props.value).toBe('draft-A');
    });
    it(`${kind} 拒绝发送保留输入`, async () => {
      const conversation = createConversation({ roomId: roomId('world'), title: kind, kind });
      const send = vi.fn(async () => ({ status: 'rejected', reason: 'Synthetic reject' }));
      render(kind, send, null, conversation)?.props.onChange('keep');
      render(kind, send, null, conversation)?.props.onSend();
      await drain();
      expect(render(kind, send, null, conversation)?.props.value).toBe('keep');
    });
    it(`${kind} 迟到接受不清后来输入`, async () => {
      let finish!: (value: unknown) => void;
      const send = vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const conversation = createConversation({ roomId: roomId('world'), title: kind, kind });
      render(kind, send, null, conversation)?.props.onChange('old');
      render(kind, send, null, conversation)?.props.onSend();
      render(kind, send, null, conversation)?.props.onChange('new');
      finish({ status: 'accepted' });
      await drain();
      expect(render(kind, send, null, conversation)?.props.value).toBe('new');
    });
    it(`${kind} 桥接等待直接submit也不发`, () => {
      const send = vi.fn();
      const conversation = createConversation({ roomId: roomId('world'), title: kind, kind });
      const bridge = { stage: 'admin', prompt: 'pending' };
      render(kind, send, bridge, conversation)?.props.onChange('keep');
      render(kind, send, bridge, conversation)?.props.onSend();
      expect(send).not.toHaveBeenCalled();
    });
  }
});
