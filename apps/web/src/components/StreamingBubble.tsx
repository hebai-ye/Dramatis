import { type CastName, type MessageId, renderMessageContent } from '@dramatis/core';
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import type { ChatScrollVisibility } from '../lib/chat-visibility';
import { countRender } from '../lib/render-count';
import { acknowledgeStreamHandoff, resetStreamState, useStreamState } from '../lib/stream-store';
import { Avatar } from './MessageBody';

interface Props {
  busy: boolean;
  onStop: () => void;
  /**
   * 当前对话里最后一条已落盘消息的 id（顺序 91）。
   *
   * 用来判断「刚落盘的那条回复是不是已经画出来了」：见下面的 `handedOver`。
   */
  lastMessageId: MessageId | null;
  /** 正在跳原句时别把用户拽到底部（T11 的高亮滚动要自己滚到位）。 */
  suspendAutoScroll: boolean;
  /** 对话区底部的锚点：流式内容长出来时滚到它。 */
  bottomRef: RefObject<HTMLDivElement | null>;
  scrollVisibility?: ChatScrollVisibility;
  cast: readonly CastName[];
  avatars: Readonly<Record<string, string | null>>;
}

/**
 * 推理流的**尾巴**。
 *
 * 用户要的是「知道它在动」，不是读它全部的思考（读全了还容易被剧透）。
 * 取最后一行、截断到 120 字，滚动着看就是活的。
 */
function tailOf(text: string, max = 120): string {
  const lines = text
    .trim()
    .split('\n')
    .filter((line) => line.trim() !== '');
  const last = lines[lines.length - 1] ?? text.trim();
  return last.length <= max ? last : `…${last.slice(-max)}`;
}

/**
 * 正在生成的那一条（顺序 59 从 MainChat 里拆出来）。
 *
 * 它是**唯一**订阅流式状态的组件：每个 token 到达只重画这里，几百条已落盘的消息、
 * 左栏、面板都不动。三块内容与拆出来之前一样：推理流、阶段占位（0ms 就有话说）、流式气泡。
 */
export function StreamingBubble({
  busy,
  onStop,
  lastMessageId,
  suspendAutoScroll,
  bottomRef,
  scrollVisibility,
  cast,
  avatars,
}: Props) {
  countRender('StreamingBubble');
  const { text, speaker, reasoning, progress, phase, handoffId } = useStreamState();
  const speakerId = cast.find((member) => member.displayName === speaker)?.id;
  const avatar = speakerId ? avatars[speakerId] : null;
  const previousHeight = useRef<number | null>(null);

  /*
   * 交接完成（顺序 91）：这一轮的回复已经落盘、而且已经画进消息列表了。
   *
   * 落盘那一刻（`handoffStreamState`）只记下 id，不清正文——清空是同步的，而消息要等
   * IndexedDB 写完再提交一次才出现，中间那几帧就是用户看到的「先消失、过一会儿整条出现」。
   * 现在流式副本留到列表里出现这条 id 为止，并且**在同一次提交里**收掉自己：
   * 既没有空窗，也不会同一条回复显示两遍。
   */
  const handedOver = handoffId !== null && handoffId === lastMessageId;
  useEffect(() => {
    // 确认必须带消息 id；上一位的迟到 effect 不能收掉下一位已开始的流。
    if (handedOver && handoffId !== null) acknowledgeStreamHandoff('main', handoffId);
  }, [handedOver, handoffId]);
  useEffect(
    () => () => {
      // 换对话会卸载这一颗气泡：立即中止并清主通道，不能把旧角色的流带到新对话。
      onStop();
      resetStreamState('main');
    },
    [onStop],
  );

  // 用本次 DOM 长高之前的距离判断是否贴底；大块输出即使一次长高超过 120px，
  // 原本在底部的人仍会跟上。主动上滑的人保持原位，逐 token 不再排 smooth 动画。
  useLayoutEffect(() => {
    const bottom = bottomRef.current;
    const scroller = bottom?.parentElement;
    if (scroller === undefined || scroller === null) return;
    const height = scroller.scrollHeight;
    const before = previousHeight.current ?? height;
    previousHeight.current = height;
    if (suspendAutoScroll || (text === '' && reasoning === '' && phase === 'idle')) return;
    if (scrollVisibility?.visibleRef.current === false) {
      if (scrollVisibility.followHiddenRef.current === true) scroller.scrollTop = height;
      return;
    }
    const growth = Math.max(0, height - before);
    const previousDistance = height - growth - scroller.scrollTop - scroller.clientHeight;
    if (previousDistance <= 120) scroller.scrollTop = height;
  }, [text, reasoning, phase, suspendAutoScroll, bottomRef, scrollVisibility]);

  // 已交接：这一帧起流式副本不再画任何东西（落盘消息已经在列表里了）
  if (handedOver) return null;

  return (
    <>
      {reasoning !== '' ? (
        <details className="reasoning" open={busy || undefined}>
          <summary>思考过程</summary>
          <pre>{reasoning}</pre>
        </details>
      ) : null}

      {/*
        流式的第一步是「让用户看见它在动」。
        推理模型会先流一大段推理流，气泡在这期间是空的；没有下面这一块，
        观感就是「等半天，整段话突然砸下来」（用户原话）。
      */}
      {busy && phase !== 'idle' && text === '' ? (
        <article className="message-row character pending">
          <Avatar name={speaker === '' ? '…' : speaker} avatar={avatar} />
          <div className="message-column">
            <span className="message-name">{speaker === '' ? '正在准备' : speaker}</span>
            <p className="pending-line">
              <span className="pending-dot" />
              {phase === 'planning'
                ? '正在判断这一轮谁开口…'
                : progress === ''
                  ? '正在写…'
                  : `正在由${speaker}回应（${progress}）…`}
            </p>
            {reasoning === '' ? null : <p className="reasoning-peek">{tailOf(reasoning)}</p>}
          </div>
        </article>
      ) : null}

      {text !== '' ? (
        <article className="message-row character">
          <Avatar name={speaker} avatar={avatar} />
          <div className="message-column streaming">
            <span className="message-name">{speaker}</span>
            {/* 流式气泡与落盘后的渲染用同一套规则，否则「我」会在生成完的一瞬间跳成名字 */}
            {renderMessageContent(text, { speakerName: speaker, thirdPersonActions: true }).map((segment, index) =>
              segment.kind === 'action' ? (
                <p className="action-line" key={`stream-action-${String(index)}`}>
                  {segment.text}
                </p>
              ) : (
                <div className="bubble character streaming" key={`stream-speech-${String(index)}`}>
                  <p>{segment.text}</p>
                </div>
              ),
            )}
          </div>
        </article>
      ) : null}
    </>
  );
}
