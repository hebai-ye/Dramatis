import { createContext, type RefObject, useContext, useLayoutEffect, useRef } from 'react';
import { isNearBottom } from './scroll';

/** 只控制聊天区的 DOM 动作；订阅、落盘交接和停止生成不依赖它。 */
export const ChatVisibilityContext = createContext(true);

interface MessageAnchor {
  dataset: { messageId?: string };
  getBoundingClientRect: () => { top: number; bottom: number };
}

export interface ChatViewport {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  getBoundingClientRect: () => { top: number; bottom: number };
  querySelectorAll: (selector: string) => ArrayLike<MessageAnchor>;
}

export interface ChatViewportSnapshot {
  scrollTop: number;
  nearBottom: boolean;
  anchorId: string | null;
  anchorOffset: number;
}

export function captureChatViewport(node: ChatViewport): ChatViewportSnapshot {
  const viewport = node.getBoundingClientRect();
  const anchor = Array.from(node.querySelectorAll('[data-message-id]')).find((message) => {
    const rect = message.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  });
  return {
    scrollTop: node.scrollTop,
    nearBottom: isNearBottom(node),
    anchorId: anchor?.dataset.messageId ?? null,
    anchorOffset: anchor === undefined ? 0 : anchor.getBoundingClientRect().top - viewport.top,
  };
}

export function restoreChatViewport(node: ChatViewport, saved: ChatViewportSnapshot): void {
  const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
  let next = saved.nearBottom ? maximum : saved.scrollTop;
  if (!saved.nearBottom && saved.anchorId !== null) {
    const anchor = Array.from(node.querySelectorAll('[data-message-id]')).find(
      (message) => message.dataset.messageId === saved.anchorId,
    );
    if (anchor !== undefined) {
      next =
        node.scrollTop + anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.anchorOffset;
    }
  }
  node.scrollTop = Math.max(0, Math.min(maximum, next));
}

export interface ChatScrollVisibility {
  visibleRef: RefObject<boolean>;
  /** null 表示隐藏提交还未捕获位置；这一帧先禁止滚动，免得捕获到已经被拽走的位置。 */
  followHiddenRef: RefObject<boolean | null>;
}

interface SavedChatViewport {
  conversationKey: string;
  viewport: ChatViewportSnapshot;
  selection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null;
}

export function useChatViewportVisibility(
  bodyRef: RefObject<HTMLDivElement | null>,
  inputRef: RefObject<HTMLTextAreaElement | null>,
  conversationKey: string,
) {
  const visible = useContext(ChatVisibilityContext);
  const visibleRef = useRef(visible);
  const followHiddenRef = useRef<boolean | null>(null);
  const previousVisible = useRef(visible);
  const savedRef = useRef<SavedChatViewport | null>(null);
  const scrollVisibility = useRef<ChatScrollVisibility>({ visibleRef, followHiddenRef }).current;
  visibleRef.current = visible;

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!visible && (previousVisible.current || savedRef.current?.conversationKey !== conversationKey)) {
      if (node !== null) {
        // 覆盖前已有的平滑动画还会继续改变 scrollTop；先停在当前阅读位置再捕获。
        node.scrollTo({ top: node.scrollTop, behavior: 'instant' });
        const viewport = captureChatViewport(node);
        const input = inputRef.current;
        savedRef.current = {
          conversationKey,
          viewport,
          selection:
            input === null
              ? null
              : {
                  start: input.selectionStart,
                  end: input.selectionEnd,
                  direction: input.selectionDirection,
                },
        };
        followHiddenRef.current = viewport.nearBottom;
      }
    } else if (visible && !previousVisible.current) {
      const saved = savedRef.current;
      if (node !== null && saved?.conversationKey === conversationKey) {
        restoreChatViewport(node, saved.viewport);
        const input = inputRef.current;
        if (input !== null && saved.selection !== null) {
          const maximum = input.value.length;
          input.setSelectionRange(
            Math.min(maximum, saved.selection.start),
            Math.min(maximum, saved.selection.end),
            saved.selection.direction,
          );
        }
      }
      savedRef.current = null;
      followHiddenRef.current = null;
    }
    previousVisible.current = visible;
  }, [visible, conversationKey, bodyRef, inputRef]);

  return { visible, visibleRef, scrollVisibility };
}
