import { createConversation, roomId } from '@dramatis/core';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SideChat } from '../components/SideChat';
import { type ChatViewport, captureChatViewport, restoreChatViewport } from './chat-visibility';
import { resetStreamState, setStreamState } from './stream-store';

// 几何夹具只验证滚动计算；这里没有浏览器 DOM，不能证明挂载、焦点或流式交接。
function viewport(scrollTop: number, scrollHeight = 2000, clientHeight = 400): ChatViewport {
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    getBoundingClientRect: () => ({ top: 100, bottom: 100 + clientHeight }),
    querySelectorAll: () => [],
  };
}

function message(id: string, top: number, bottom: number) {
  return { dataset: { messageId: id }, getBoundingClientRect: () => ({ top, bottom }) };
}

describe('素材覆盖期间的聊天阅读位置', () => {
  it('历史阅读记录第一条可见消息的偏移，跳过视口上方的消息', () => {
    const node = viewport(300);
    node.querySelectorAll = () => [message('past', -20, 80), message('anchor', 84, 230), message('next', 240, 370)];
    expect(captureChatViewport(node)).toEqual({
      scrollTop: 300,
      nearBottom: false,
      anchorId: 'anchor',
      anchorOffset: -16,
    });
  });

  it('原来贴底时恢复到增长后的底部', () => {
    const node = viewport(1540);
    const saved = captureChatViewport(node);
    node.scrollHeight = 2600;
    restoreChatViewport(node, saved);
    expect(node.scrollTop).toBe(2200);
  });

  it('历史消息前方增高后仍保持同一条消息的视口偏移', () => {
    const node = viewport(300);
    node.querySelectorAll = () => [message('anchor', 84, 230)];
    const saved = captureChatViewport(node);
    node.scrollTop = 450;
    node.querySelectorAll = () => [message('anchor', 184, 330)];
    restoreChatViewport(node, saved);
    expect(node.scrollTop).toBe(550);
  });

  it('锚点被删除时使用原滚动位置，不跳到新消息', () => {
    const node = viewport(300);
    node.querySelectorAll = () => [message('anchor', 84, 230)];
    const saved = captureChatViewport(node);
    node.querySelectorAll = () => [message('other', 184, 330)];
    node.scrollTop = 900;
    restoreChatViewport(node, saved);
    expect(node.scrollTop).toBe(300);
  });

  it('内容缩短时恢复位置被限制在合法滚动范围', () => {
    const node = viewport(900);
    const saved = captureChatViewport(node);
    node.scrollHeight = 600;
    restoreChatViewport(node, saved);
    expect(node.scrollTop).toBe(200);
  });

  it('锚点向上移出时不产生负滚动值', () => {
    const node = viewport(200);
    node.querySelectorAll = () => [message('anchor', 100, 200)];
    const saved = captureChatViewport(node);
    node.scrollTop = 40;
    node.querySelectorAll = () => [message('anchor', -100, 0)];
    restoreChatViewport(node, saved);
    expect(node.scrollTop).toBe(0);
  });
});

// 受控 hook / 几何夹具执行真实 SideChat 的 effect 与 onScroll；不是浏览器 DOM 验证。
const hooks = vi.hoisted(() => {
  let values: unknown[] = [];
  let effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0;
  let effectCursor = 0;
  let layouts: (() => void)[] = [];
  let passive: (() => void)[] = [];
  const effect = (run: () => (() => void) | undefined, deps: readonly unknown[] | undefined, layout: boolean) => {
    const index = effectCursor++;
    const previous = effects[index];
    if (!previous || !deps || !previous.deps || deps.some((value, i) => value !== previous.deps?.[i])) {
      (layout ? layouts : passive).push(() => {
        previous?.cleanup?.();
        effects[index] = { deps, cleanup: run() };
      });
    }
  };
  return {
    visible: true,
    reset() {
      for (const effect of effects) effect.cleanup?.();
      values = [];
      effects = [];
      layouts = [];
      passive = [];
      this.visible = true;
    },
    begin() {
      cursor = 0;
      effectCursor = 0;
    },
    flush() {
      const currentLayouts = layouts;
      const currentPassive = passive;
      layouts = [];
      passive = [];
      for (const run of currentLayouts) run();
      for (const run of currentPassive) run();
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
    effect: (run: () => (() => void) | undefined, deps?: readonly unknown[]) => effect(run, deps, false),
    layout: (run: () => (() => void) | undefined, deps?: readonly unknown[]) => effect(run, deps, true),
  };
});

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useContext: () => hooks.visible,
  useState: hooks.state,
  useEffect: hooks.effect,
  useLayoutEffect: hooks.layout,
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useRef: (initial: unknown) => {
    const [ref] = hooks.state(() => ({ current: initial }));
    return ref;
  },
}));

function elements(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}

function animatedViewport() {
  let top = 0;
  let animation: number | null = null;
  return {
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = value;
      animation = null;
    },
    scrollHeight: 3600,
    clientHeight: 400,
    getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
    querySelectorAll: () => [],
    scrollTo(options: ScrollToOptions) {
      const target = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, options.top ?? top));
      if (options.behavior === 'smooth') animation = target;
      else {
        top = target;
        animation = null;
      }
    },
    advanceAnimation() {
      if (animation !== null) top += (animation - top) / 4;
    },
    finishAnimation() {
      if (animation !== null) top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, animation));
      animation = null;
    },
  };
}

const conversation = createConversation({ roomId: roomId('scroll-room'), title: '副对话', kind: 'side' });
function renderSide(node: ReturnType<typeof animatedViewport>) {
  hooks.begin();
  const implementation = (SideChat as unknown as { type: (props: Parameters<typeof SideChat>[0]) => ReactNode }).type;
  const tree = implementation({
    conversation,
    messages: [],
    busy: true,
    ready: true,
    archived: false,
    onSend: () => {},
    onStop: () => {},
    onAdopt: () => {},
    onDiscard: () => {},
  });
  const body = elements(tree).find((element) => element.props.className === 'chat-body');
  if (!body) throw new Error('Missing side chat viewport');
  (body.props.ref as RefObject<unknown>).current = node;
  hooks.flush();
  return body;
}

beforeEach(() => {
  hooks.reset();
  resetStreamState('admin');
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(() => {
  hooks.reset();
  vi.unstubAllGlobals();
});

describe('副对话可见性滚动（受控 effect，无 DOM）', () => {
  it('阅读历史时第一批可见分块不启动向底部的滚动', () => {
    const node = animatedViewport();
    setStreamState('admin', { text: '已有正文', phase: 'writing' });
    const body = renderSide(node);
    node.finishAnimation();
    node.scrollTop = 1296;
    (body.props.onScroll as (() => void) | undefined)?.();
    setStreamState('admin', { text: '已有正文，新的分块到达' });
    renderSide(node);
    node.finishAnimation();
    expect(node.scrollTop).toBe(1296);
  });

  it('原来贴底时一次增长超过阈值仍继续跟随新正文', () => {
    const node = animatedViewport();
    setStreamState('admin', { text: '已有正文', phase: 'writing' });
    const body = renderSide(node);
    node.finishAnimation();
    (body.props.onScroll as (() => void) | undefined)?.();
    node.scrollHeight = 4300;
    setStreamState('admin', { text: '已有正文，长段落到达' });
    renderSide(node);
    node.finishAnimation();
    expect(node.scrollTop).toBe(3900);
  });

  it('长段落跟随中的滚动事件不会让后续分块遗失贴底意图', () => {
    const node = animatedViewport();
    setStreamState('admin', { text: '已有正文', phase: 'writing' });
    const body = renderSide(node);
    node.finishAnimation();
    (body.props.onScroll as (() => void) | undefined)?.();
    node.scrollHeight = 4300;
    setStreamState('admin', { text: '已有正文，长段落到达' });
    renderSide(node);
    node.advanceAnimation();
    (body.props.onScroll as (() => void) | undefined)?.();
    node.scrollHeight = 5000;
    setStreamState('admin', { text: '已有正文，长段落到达，后续分块继续到达' });
    renderSide(node);
    node.finishAnimation();
    expect(node.scrollTop).toBe(4600);
  });

  it('素材覆盖时终止未完成的平滑滚动，隐藏正文不继续漂移', () => {
    const node = animatedViewport();
    setStreamState('admin', { text: '已有正文', phase: 'writing' });
    renderSide(node);
    node.scrollTop = 1296;
    node.scrollTo({ top: 3200, behavior: 'smooth' });
    hooks.visible = false;
    renderSide(node);
    node.finishAnimation();
    expect(node.scrollTop).toBe(1296);
  });
});
