import {
  assessAttribution,
  type CharacterInstance,
  type Conversation,
  type ConversationModes,
  type InstanceId,
  type Message,
  type MessageId,
  renderMessageContent,
  type Scene,
} from '@dramatis/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCoarsePointer } from '../lib/viewport';
import { IconPlus, IconScene, IconSend, IconStop } from './Icons';
import { Avatar, MessageBody } from './MessageBody';
import { WebBridgePanel, type WebBridgeState } from './WebBridgePanel';

interface Props {
  conversation: Conversation;
  scene: Scene | null;
  messages: Message[];
  cast: CharacterInstance[];
  streamText: string;
  streamSpeaker: string;
  reasoningText: string;
  /** 这一轮正在做什么：判断谁开口 / 正在写。空转时是 idle。 */
  phase?: 'idle' | 'planning' | 'writing';
  busy: boolean;
  ready: boolean;
  /** 已归档的对话只用于回顾，不能再说话。 */
  archived: boolean;
  /**
   * 从记忆面板「跳到原句」时亮一下的那条消息（T11）。
   *
   * 带上 `seq` 是为了让「同一条记忆连点两次」也能重新高亮一次——
   * 只比 id 的话第二次点击什么都不发生，用户会以为按钮坏了。
   * 它只负责滚动与高亮，不改数据。
   */
  focus?: FocusRequest | null;
  /** 心理活动是否默认展开（个性化里可改；默认收起）。 */
  showIntent?: boolean;
  /** 网页版桥接：非 null 时正等着用户把网页版的输出贴回来。 */
  bridge?: WebBridgeState | null;
  /** 没配 API Key：这一轮的提示词要用户自己贴到网页版。 */
  manualMode?: boolean;
  onBridgeReply?: (text: string) => void;
  onBridgeAnalysis?: (text: string) => void;
  onBridgeSkip?: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onRegenerate: (id: MessageId) => void;
  onEdit: (id: MessageId, content: string) => void;
  onDelete: (id: MessageId) => void;
  onToggleMode: (key: keyof ConversationModes, value: boolean) => void;
  onOpenScene: () => void;
  /** 从右栏把角色拖进来：进入当前场景。 */
  onDropInstance: (id: InstanceId) => void;
  /** 改归属：这条其实是别人说的（T18）。 */
  onReassign: (id: MessageId, instanceId: InstanceId) => void;
}

/** 「跳到原句」的一次请求：`seq` 让重复点击同一条也能再闪一次。 */
export interface FocusRequest {
  id: MessageId;
  seq: number;
}

const MODE_LABELS: Array<{ key: keyof ConversationModes; label: string; note: string }> = [
  { key: 'playerFirst', label: '角色等我先说', note: '所有角色都必须在你发言之后才能接话' },
  { key: 'silent', label: '静默模式', note: '你连续说话期间，其他角色只能做动作，不能开口' },
  {
    key: 'intentFirst',
    label: '意图先行',
    note: '发言前先花一次便宜调用判断「这一轮谁开口、他想做什么」；关掉可以省一次调用',
  },
];

function shorten(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s*\n\s*/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}……`;
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
 * 一条回复的用量。
 *
 * 显示成「提示 1.2k / 输出 240」而不是一个总数：BYOK 用户看的是钱，
 * 输入与输出的单价常常不一样（P3-7）。
 */
function formatUsage(usage: Message['usage']): string {
  if (usage === undefined) return '';
  const compact = (value: number): string => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));
  return `提示 ${compact(usage.promptTokens)} / 输出 ${compact(usage.completionTokens)} token`;
}

/**
 * 手机上按住多久算「长按」（毫秒）。
 *
 * 450 是折中：再短会和「想滚动却按到了」打架，再长用户会以为没反应。
 * 桌面的右键不需要这个值——`contextmenu` 是浏览器直接给的。
 */
const LONG_PRESS_MS = 450;

/**
 * 输入区「＋」里的便捷指令（用户 2026-09-21 要求）。
 *
 * 背景：`#` 在 Dramatis 里是「这一段是动作、不是台词」的标记（LAYOUT 规格），
 * 但玩家得先知道有这回事才会用——把写法直接摆进菜单，点一下即插入，
 * 光标落在标记之后，接着写就行。
 *
 * `caret` 是插入后光标该停的位置（相对插入内容开头）：`#` 之后是 1，
 * 引号要落在两个引号**中间**所以也是 1。
 */
const QUICK_COMMANDS: { label: string; insert: string; caret: number; note: string }[] = [
  { label: '# 动作', insert: '#', caret: 1, note: '后面写你要做的事；动作不进气泡，和台词分开' },
  { label: '「台词」', insert: '「」', caret: 1, note: '光标落在引号中间，写你要说的话' },
];

/**
 * 主对话（LAYOUT「主对话状态」）。
 *
 * 形态是**群聊**：圆形头像、名字、聊天气泡，动作另起一段且不进气泡。
 * 输入区底部那排按钮是规格里点名要有的：加号设置对话模式，场景设置与切换。
 */
export function MainChat({
  conversation,
  scene,
  messages,
  cast,
  streamText,
  streamSpeaker,
  reasoningText,
  phase = 'idle',
  busy,
  ready,
  archived,
  focus = null,
  showIntent = false,
  bridge = null,
  manualMode = false,
  onBridgeReply,
  onBridgeAnalysis,
  onBridgeSkip,
  onSend,
  onStop,
  onRegenerate,
  onEdit,
  onDelete,
  onToggleMode,
  onOpenScene,
  onDropInstance,
  onReassign,
}: Props) {
  const coarsePointer = useCoarsePointer();
  const [input, setInput] = useState('');
  const [editingId, setEditingId] = useState<MessageId | null>(null);
  const [editingText, setEditingText] = useState('');
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [highlightId, setHighlightId] = useState<MessageId | null>(null);
  /**
   * 右键 / 长按打开的那张小菜单（用户 2026-09-21 的要求）。
   *
   * 桌面：右键任意一条消息 → 菜单；鼠标悬停也会露出几个常用操作。
   * 手机：长按（iOS 走触摸计时，安卓的右键事件就是长按）。
   * 菜单里除了编辑/删除/重抽，还带 Token 用量——那行字以前常驻在气泡下面，太抢眼。
   */
  const [menuFor, setMenuFor] = useState<MessageId | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pressTimer = useRef<number | null>(null);
  /** 长按那一刻手指在哪：菜单就开在那儿，闭着眼睛也知道自己按的是哪条。 */
  const pressPoint = useRef({ x: 0, y: 0 });

  /**
   * 长按之后浏览器还会补一次 click；不吞掉它，刚打开的菜单会被
   * 上面那个「点任意处关闭」立刻收走，用户看到的就是「长按没反应」。
   */
  const swallowNextClick = useRef(false);

  const openMenu = (id: MessageId, x: number, y: number): void => {
    setMenuFor(id);
    setMenuAt({ x, y });
  };
  const closeMenu = (): void => {
    setMenuFor(null);
    setMenuAt(null);
  };

  /*
   * 菜单挂在 body 上（聊天气泡住在滚动容器里，绝对定位会被那块 `overflow` 裁掉——
   * 实测最下面那条消息的菜单整个看不见，量出来的坐标是对的，人在屏幕上找不到它）。
   * 既然挂出来了，就得自己保证它不出屏：量一次实际尺寸，推回可视区。
   */
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (menuFor === null || menuAt === null || node === null) return;

    const rect = node.getBoundingClientRect();
    const margin = 8;
    let dx = 0;
    let dy = 0;
    if (rect.right > window.innerWidth - margin) dx = window.innerWidth - margin - rect.right;
    if (rect.left + dx < margin) dx = margin - (rect.left + dx);
    if (rect.bottom > window.innerHeight - margin) dy = window.innerHeight - margin - rect.bottom;
    if (rect.top + dy < margin) dy = margin - (rect.top + dy);
    if (dx === 0 && dy === 0) return;

    setMenuAt({ x: menuAt.x + dx, y: menuAt.y + dy });
  }, [menuFor, menuAt]);

  /** 长按开始计时。安卓上长按也会派发 contextmenu，两条路都开同一个菜单，重复无副作用。 */
  const startPress = (id: MessageId, x: number, y: number): void => {
    cancelPress();
    pressPoint.current = { x, y };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      swallowNextClick.current = true;
      openMenu(id, pressPoint.current.x, pressPoint.current.y);
    }, LONG_PRESS_MS);
  };

  /** 手指一移开或一滑动就取消：那是在滚动，不是长按。 */
  const cancelPress = (): void => {
    if (pressTimer.current === null) return;
    window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  // 组件卸载（切对话 / 切账户）时别把计时器留着，否则它会在后台开一个已经没人看的菜单
  useEffect(
    () => () => {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (menuFor === null) return;
    /*
     * 点菜单里面不算「点外面」：菜单里有个下拉（改归属），选它的时候
     * 不能让菜单先自己关掉。以前靠菜单上的 stopPropagation，那会在
     * 一个纯容器 div 上挂 onClick——a11y 规则会报，也没必要。
     */
    const onAnyClick = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('.row-menu') !== null) return;
      setMenuFor(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuFor(null);
    };
    window.addEventListener('click', onAnyClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onAnyClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /*
   * 输入框跟着字数长高（最多 200px，再多就自己滚）。
   * 长度交给浏览器量（scrollHeight），不自己算行数——换行、中英文混排、
   * 手机上的软键盘都会影响实际高度，只有它自己知道。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这里就是要跟着 input 重跑；它读的是 DOM 量出来的高度，代码里不出现 input 的值
  useEffect(() => {
    const node = inputRef.current;
    if (node === null) return;
    node.style.height = 'auto';
    node.style.height = `${String(Math.min(node.scrollHeight, 200))}px`;
  }, [input]);

  const contentLength = messages.reduce((total, message) => total + message.content.length, 0) + streamText.length;

  useEffect(() => {
    if (contentLength === 0) return;
    // 正在跳原句时别把用户又拽到底部——下面那条 effect 会自己滚到位
    if (focus !== null) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [contentLength, focus]);

  /**
   * 跳到原句（T11）。
   *
   * 高亮的时长是刻意的：闪一下就走，用户看得到「就是这一条」，
   * 又不会让整屏一直有人在发光。
   */
  useEffect(() => {
    if (focus === null) return;
    const node = document.querySelector(`[data-message-id="${focus.id}"]`);
    if (node === null) return;

    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightId(focus.id);
    const timer = window.setTimeout(() => setHighlightId(null), 2600);
    return () => window.clearTimeout(timer);
  }, [focus]);

  // 只有最后一条角色回复可以重抽：重抽更早的消息会让后面的对话失去前提
  const lastCharacterId = [...messages].reverse().find((message) => message.role === 'character')?.id ?? null;

  const submit = (): void => {
    if (!ready || busy || archived) return;
    const text = input.trim();
    if (text === '') return;
    onSend(text);
    setInput('');
  };

  /**
   * 把一段标记插到光标处（「＋」里的便捷指令用它）。
   *
   * 光标是**插在中间**而不是扔到最后：点「# 动作」的人下一步就是写字，
   * 让他还要再按一下方向键属于没做完。
   */
  const insertAtCursor = (text: string, caretOffset: number): void => {
    const node = inputRef.current;
    const start = node?.selectionStart ?? input.length;
    const end = node?.selectionEnd ?? input.length;
    setInput(`${input.slice(0, start)}${text}${input.slice(end)}`);
    setModeMenuOpen(false);
    window.requestAnimationFrame(() => {
      const target = inputRef.current;
      if (target === null) return;
      target.focus();
      target.setSelectionRange(start + caretOffset, start + caretOffset);
    });
  };

  const nameOf = (message: Message): string => {
    if (message.role === 'player') return '我';
    const speaker = cast.find((instance) => instance.id === message.speakerInstanceId);
    return speaker?.displayName ?? message.speakerName;
  };

  /**
   * 归属评估（T18）。
   *
   * 纯规则、不调模型；结果只用来提示。每次渲染都算一遍是刻意的——评估很便宜
   * （几次字符串匹配），而缓存它只会让「改了归属之后提示不刷新」这类 bug 有机会出现。
   */
  const attributionOf = (message: Message) =>
    assessAttribution({
      content: message.content,
      speaker: {
        instanceId: message.speakerInstanceId ?? ('' as InstanceId),
        displayName: nameOf(message),
      },
      cast,
    });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 拖拽天生是鼠标动作；键盘路径在角色详情里（在场状态可切换）
    <section
      className={dragOver ? 'chat-surface drop-active' : 'chat-surface'}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        const dropped = event.dataTransfer.getData('text/dramatis-instance');
        if (dropped !== '') onDropInstance(dropped as InstanceId);
      }}
    >
      <div className="chat-body">
        {archived ? (
          <div className="notice warn">
            <strong>这是一条已归档的对话</strong>
            <p>情绪、关系与记忆已经回滚到它开始之前；这里只用于回顾，不能再接着说话。</p>
          </div>
        ) : null}

        {messages.length === 0 && streamText === '' ? (
          <p className="hint">
            {conversation.kind === 'side'
              ? '让管理员帮你起草角色卡、世界书，或者设置当前场景。'
              : '说点什么。右栏的角色可以直接拖进来。'}
          </p>
        ) : null}

        {messages.map((message) => (
          <article
            key={message.id}
            data-message-id={message.id}
            className={`message-row ${message.role}${highlightId === message.id ? ' highlighted' : ''}${
              menuFor === message.id ? ' menu-open' : ''
            }`}
            onContextMenu={(event) => {
              event.preventDefault();
              openMenu(message.id, event.clientX, event.clientY);
            }}
            onTouchStart={(event) => {
              const point = event.touches[0];
              startPress(message.id, point?.clientX ?? 0, point?.clientY ?? 0);
            }}
            onTouchEnd={cancelPress}
            onTouchMove={cancelPress}
            onTouchCancel={cancelPress}
            onClickCapture={(event) => {
              if (!swallowNextClick.current) return;
              swallowNextClick.current = false;
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {message.role === 'character' ? <Avatar name={nameOf(message)} /> : null}

            <div className="message-column">
              {message.role === 'character' ? <span className="message-name">{nameOf(message)}</span> : null}

              {/*
                他自己声明的意图（P1-6）。放在气泡上方而不是塞进正文：
                它是「为什么这么回」的注解，不是他说出口的话。
              */}
              {/*
                他的心理活动**默认收起来**（用户要求：别把角色的心理摆在明面上）。
                措辞按来源分：他自己写的、导演调用推出来的、还是从推理流里摘的。
              */}
              {message.intent === undefined ? null : (
                <details className="intent-line" open={showIntent || undefined}>
                  <summary>
                    {message.intentSource === 'reasoning'
                      ? '他当时在想什么（点开看）'
                      : message.intentSource === 'planned'
                        ? '他这一轮想做什么（点开看）'
                        : '他自己写的意图（点开看）'}
                  </summary>
                  <p>{message.intent}</p>
                </details>
              )}

              {/*
                归属可疑提示（T18）。只提示、不自动改：硬改归属比错位更糟，
                所以把「更像是谁说的」摆出来，用户点一下才动数据。
              */}
              {message.role === 'character' && attributionOf(message).suspicious ? (
                <div className="attr-warn">
                  <span>
                    ⚠ 这条可能不是「{nameOf(message)}」说的：{attributionOf(message).reasons[0]}
                  </span>
                  {attributionOf(message).candidates.map((candidate) => (
                    <button
                      key={candidate.instanceId}
                      type="button"
                      className="ghost"
                      disabled={busy || archived}
                      title={candidate.reason}
                      onClick={() => onReassign(message.id, candidate.instanceId)}
                    >
                      改成「{candidate.displayName}」说的
                    </button>
                  ))}
                </div>
              ) : null}

              {editingId === message.id ? (
                <>
                  <textarea rows={4} value={editingText} onChange={(event) => setEditingText(event.target.value)} />
                  <div className="bubble-actions">
                    <button
                      type="button"
                      onClick={() => {
                        onEdit(message.id, editingText);
                        setEditingId(null);
                      }}
                    >
                      保存
                    </button>
                    <button type="button" className="ghost" onClick={() => setEditingId(null)}>
                      取消
                    </button>
                  </div>
                </>
              ) : (
                <MessageBody message={message} speakerName={nameOf(message)} showSpeaker={false}>
                  {message.id === lastCharacterId ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy || archived || manualMode}
                      title={
                        manualMode
                          ? '网页版模式下不重抽：删掉这条回复，再发一遍那句话，就会重新给你一段提示词'
                          : '撤销这条回复，让角色重新说一次'
                      }
                      onClick={() => onRegenerate(message.id)}
                    >
                      重抽
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy || archived}
                    onClick={() => {
                      setEditingId(message.id);
                      setEditingText(message.content);
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="ghost danger"
                    disabled={busy || archived}
                    onClick={() => {
                      if (window.confirm('删除这条消息？')) onDelete(message.id);
                    }}
                  >
                    删除
                  </button>
                  <span className="row-menu-more">右键看更多</span>
                </MessageBody>
              )}

              {menuFor === message.id
                ? createPortal(
                    <div
                      className="row-menu"
                      ref={menuRef}
                      style={menuAt === null ? undefined : { left: menuAt.x, top: menuAt.y }}
                    >
                      {message.id === lastCharacterId ? (
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy || archived || manualMode}
                          onClick={() => {
                            closeMenu();
                            onRegenerate(message.id);
                          }}
                        >
                          重抽
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy || archived}
                        onClick={() => {
                          closeMenu();
                          setEditingId(message.id);
                          setEditingText(message.content);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="ghost danger"
                        disabled={busy || archived}
                        onClick={() => {
                          closeMenu();
                          if (window.confirm('删除这条消息？')) onDelete(message.id);
                        }}
                      >
                        删除
                      </button>
                      {cast.length > 1 && message.role === 'character' ? (
                        <label className="attr-pick">
                          改归属
                          <select
                            value={message.speakerInstanceId ?? ''}
                            disabled={busy || archived}
                            onChange={(event) => {
                              closeMenu();
                              onReassign(message.id, event.target.value as InstanceId);
                            }}
                          >
                            {cast.map((member) => (
                              <option key={member.id} value={member.id}>
                                {member.displayName}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                      {formatUsage(message.usage) === '' ? null : (
                        <span className="hint">{formatUsage(message.usage)}</span>
                      )}
                    </div>,
                    document.body,
                  )
                : null}
            </div>
          </article>
        ))}

        {reasoningText !== '' ? (
          <details className="reasoning" open={busy || undefined}>
            <summary>思考过程</summary>
            <pre>{reasoningText}</pre>
          </details>
        ) : null}

        {/*
          流式的第一步是「让用户看见它在动」。
          推理模型会先流一大段推理流，气泡在这期间是空的；没有下面这一块，
          观感就是「等半天，整段话突然砸下来」（用户原话）。
        */}
        {busy && streamText === '' ? (
          <article className="message-row character pending">
            <Avatar name={streamSpeaker === '' ? '…' : streamSpeaker} />
            <div className="message-column">
              <span className="message-name">{streamSpeaker === '' ? '正在准备' : streamSpeaker}</span>
              <p className="pending-line">
                <span className="pending-dot" />
                {phase === 'planning' ? '正在判断这一轮谁开口…' : '正在写…'}
              </p>
              {reasoningText === '' ? null : <p className="reasoning-peek">{tailOf(reasoningText)}</p>}
            </div>
          </article>
        ) : null}

        {streamText !== '' ? (
          <article className="message-row character">
            <Avatar name={streamSpeaker} />
            <div className="message-column streaming">
              <span className="message-name">{streamSpeaker}</span>
              {/* 流式气泡与落盘后的渲染用同一套规则，否则「我」会在生成完的一瞬间跳成名字 */}
              {renderMessageContent(streamText, {
                speakerName: streamSpeaker,
                thirdPersonActions: true,
              }).map((segment, index) =>
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

        <div ref={bottomRef} />
      </div>

      {/*
        网页版桥接（没有 API Key 时的第一条路）：面板就摆在输入框上方，
        因为它和输入框是同一步——先贴出去，再把结果贴回来。
      */}
      {bridge === null || onBridgeReply === undefined || onBridgeAnalysis === undefined ? null : (
        <WebBridgePanel
          bridge={bridge}
          busy={busy}
          disabled={archived}
          onReply={onBridgeReply}
          onAnalysis={onBridgeAnalysis}
          onSkip={onBridgeSkip ?? (() => {})}
        />
      )}

      {manualMode && bridge === null && messages.length === 0 ? (
        <p className="hint bridge-hint">
          还没填 API Key——不要紧，先这么玩：把话发出去，应用会给你一段<strong>提示词</strong>， 贴进 DeepSeek
          网页版，再把它的回复粘回来就行。想省掉这一步，去「设置 → 模型接入」填一个 Key。
        </p>
      ) : null}

      {/*
        输入区（用户 2026-09-21：照 Codex 的样子重做）。

        结构上就一件事：**一个盒子**。输入框和下面那排控件都住在这个盒子里，
        焦点态由盒子统一表示（`.composer-box:focus-within`），所以不用再画
        「大输入框 + 外面一排带边框的小按钮」那种两层结构。
      */}
      <div className="composer">
        <div className="composer-box">
          <textarea
            ref={inputRef}
            value={input}
            disabled={!ready || archived}
            placeholder={
              archived
                ? '已归档的对话不能再说话'
                : ready
                  ? coarsePointer
                    ? '说点什么……（回车换行，点右下角发送）'
                    : '说点什么……（Enter 发送，Shift+Enter 换行）'
                  : '先导入角色卡'
            }
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              if (coarsePointer) return;
              event.preventDefault();
              submit();
            }}
          />

          <div className="composer-tools">
            <div className="mode-anchor">
              <button
                type="button"
                className="composer-chip"
                disabled={archived}
                title="设置当前对话的模式"
                aria-label="对话模式"
                onClick={() => setModeMenuOpen((open) => !open)}
              >
                <IconPlus />
              </button>
              {modeMenuOpen ? (
                <div className="mode-menu">
                  <p className="hint">对话模式（只影响这条对话）</p>
                  {MODE_LABELS.map((mode) => (
                    <label key={mode.key} className="mode-option">
                      <input
                        type="checkbox"
                        // 老数据里没有 intentFirst 这个字段，缺省视为开
                        checked={
                          mode.key === 'intentFirst'
                            ? conversation.modes.intentFirst !== false
                            : conversation.modes[mode.key] === true
                        }
                        disabled={archived}
                        onChange={(event) => onToggleMode(mode.key, event.target.checked)}
                      />
                      <span>
                        <strong>{mode.label}</strong>
                        <span className="hint">{mode.note}</span>
                      </span>
                    </label>
                  ))}

                  {/*
                    便捷指令（用户 2026-09-21）：把 `#` 这种写法摆到用户手边，
                    点一下插到光标处，接着写就行——不用记格式，也不用去翻文档。
                  */}
                  <p className="hint">便捷指令</p>
                  {QUICK_COMMANDS.map((command) => (
                    <button
                      key={command.label}
                      type="button"
                      className="ghost quick-command"
                      disabled={archived}
                      title={command.note}
                      onClick={() => insertAtCursor(command.insert, command.caret)}
                    >
                      <code>{command.label}</code>
                      <span className="hint">{command.note}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className="composer-chip"
              disabled={archived}
              title="输入或切换当前场景"
              onClick={onOpenScene}
            >
              <IconScene />
              <span className="composer-chip-label">场景{scene === null ? '' : `：${shorten(scene.title, 10)}`}</span>
            </button>

            <span className="composer-location">
              {scene === null || scene.location.trim() === '' ? '地点未指定' : shorten(scene.location, 18)}
            </span>

            <div className="topbar-spacer" />

            {busy ? (
              <button
                type="button"
                className="composer-action stop"
                title="停止这一轮"
                aria-label="停止"
                onClick={onStop}
              >
                <IconStop />
              </button>
            ) : (
              <button
                type="button"
                /*
                 * 桥接开着的时候不让再发一句：那会把「正等着贴回来」的这一步冲掉，
                 * 而已经落盘的玩家消息又撤不回来。先把手上的这一轮转完。
                 */
                disabled={!ready || archived || input.trim() === '' || bridge !== null}
                title={bridge === null ? undefined : '先把这一轮贴回来（或点「放弃这一轮」）再发下一句'}
                /* 没配 Key 时这颗键不是「发送」而是「生成提示词」，得让读屏也听得出来 */
                aria-label={manualMode && bridge === null ? '生成提示词' : '发送'}
                className={manualMode && bridge === null ? 'composer-action labelled' : 'composer-action'}
                onClick={submit}
              >
                <IconSend />
                {manualMode && bridge === null ? <span>生成提示词</span> : null}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
