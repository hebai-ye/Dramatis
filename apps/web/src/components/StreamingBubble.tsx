import { type CastName, renderMessageContent } from '@dramatis/core';
import { type RefObject, useLayoutEffect, useRef } from 'react';
import { countRender } from '../lib/render-count';
import { useStreamState } from '../lib/stream-store';
import { Avatar } from './MessageBody';

interface Props {
  busy: boolean;
  /** 正在跳原句时别把用户拽到底部（T11 的高亮滚动要自己滚到位）。 */
  suspendAutoScroll: boolean;
  /** 对话区底部的锚点：流式内容长出来时滚到它。 */
  bottomRef: RefObject<HTMLDivElement | null>;
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
export function StreamingBubble({ busy, suspendAutoScroll, bottomRef, cast, avatars }: Props) {
  countRender('StreamingBubble');
  const { text, speaker, reasoning, phase } = useStreamState();
  const speakerId = cast.find((member) => member.displayName === speaker)?.id;
  const avatar = speakerId ? avatars[speakerId] : null;
  const previousHeight = useRef<number | null>(null);

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
    const growth = Math.max(0, height - before);
    const previousDistance = height - growth - scroller.scrollTop - scroller.clientHeight;
    if (previousDistance <= 120) scroller.scrollTop = height;
  }, [text, reasoning, phase, suspendAutoScroll, bottomRef]);

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
              {phase === 'planning' ? '正在判断这一轮谁开口…' : '正在写…'}
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
