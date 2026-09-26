import {
  type CastName,
  type CharacterInstance,
  type Conversation,
  type ConversationModes,
  DEFAULT_HISTORY_NEAR_WINDOW,
  historyPolicyOf,
  type InstanceId,
  type Message,
  type MessageId,
  type ReplyLength,
  replyLengthOf,
  type Scene,
  unlimitedModeOf,
} from '@dramatis/core';
import { type MouseEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { countRender } from '../lib/render-count';
import { isNearBottom } from '../lib/scroll';
import type { UnlimitedPromptApi } from '../lib/useUnlimitedPrompt';
import { useCoarsePointer } from '../lib/viewport';
import { Composer } from './Composer';
import { IconPlus, IconScene } from './Icons';
import { type MessageHandlers, MessageList } from './MessageItem';
import { StreamingBubble } from './StreamingBubble';
import { WebBridgePanel, type WebBridgeState } from './WebBridgePanel';

interface Props {
  conversation: Conversation;
  scene: Scene | null;
  messages: Message[];
  cast: CharacterInstance[];
  avatars: Readonly<Record<string, string | null>>;
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
  /**
   * 手机顶栏点角色条时递进来的「把这段文字插到光标处」（用户 2026-09-24 要求）。
   *
   * 带 `seq` 的理由与 `focus` 一样：同一个名字连点两次，第二次也要真的插进去。
   * 只插文字、不改任何数据——插进去之后用户自己接着写，或直接发送。
   */
  insertRequest?: { text: string; seq: number } | null;
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
  /** 改对话模式：传要改的那几个字段（对话级，落 `ConversationModes`）。 */
  onChangeModes: (patch: Partial<ConversationModes>) => void;
  /**
   * 无限制模式的提示词（用户数据，存在本机）。
   *
   * 它**不是**仓库里的常量：网页是公开托管的静态站点，写进代码就等于编译进公开可下载的
   * JS（`packages/core/src/prompt/unlimited.ts` 的注释里记了来龙去脉）。
   */
  unlimitedPrompt: UnlimitedPromptApi;
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

const MODE_OPTIONS: Array<{
  key: string;
  label: string;
  note: string;
  read: (modes: ConversationModes) => boolean;
  write: (checked: boolean) => Partial<ConversationModes>;
}> = [
  {
    key: 'playerFirst',
    label: '角色等我先说',
    note: '所有角色都必须在你发言之后才能接话',
    read: (modes) => modes.playerFirst === true,
    write: (checked) => ({ playerFirst: checked }),
  },
  {
    key: 'silent',
    label: '静默模式',
    note: '你连续说话期间，其他角色只能做动作，不能开口',
    read: (modes) => modes.silent === true,
    write: (checked) => ({ silent: checked }),
  },
  {
    key: 'intentFirst',
    label: '意图先行',
    note: '发言前先花一次便宜调用判断「这一轮谁开口、他想做什么」；关掉可以省一次调用',
    // 老数据里没有 intentFirst 这个字段，缺省视为开
    read: (modes) => modes.intentFirst !== false,
    write: (checked) => ({ intentFirst: checked }),
  },
  {
    key: 'historyMode',
    label: '场记覆盖后收起远处原文',
    note: `已被场记压过、又不在最近 ${String(DEFAULT_HISTORY_NEAR_WINDOW)} 条里的原文不再逐条带给模型，由场记、章节与记忆代表；你提到关键词时会取回原文。关掉就是原文全带（超出窗口才从最旧的丢）`,
    read: (modes) => historyPolicyOf(modes).mode === 'recap-aware',
    write: (checked) => ({ historyMode: checked ? 'recap-aware' : 'full' }),
  },
  /*
   * 无限制模式（用户 2026-09-25 点名）。
   *
   * 它替换了原来那个「高级系统提示 · 当前对话」输入框：提示词不再一条对话一份地手打，
   * 而是住在代码里的一个常量（`packages/core/src/prompt/unlimited.ts`），
   * 这里只留一个开关。开关是**对话级**的，与其它模式一致。
   *
   * 提示词为空时开关照常显示，但不会改变提示词（下面会说明一句）。
   */
  {
    key: 'unlimited',
    label: '无限制模式',
    note: '把内置的那段提示词整块加进这条对话的系统提示（不可丢弃，预算紧张时也不让位）',
    read: (modes) => unlimitedModeOf(modes),
    write: (checked) => ({ unlimited: checked }),
  },
];

/**
 * 回答长度（顺序 67e，用户点名）。
 *
 * 178 轮真实模型长跑里，回复从平均 171 字涨到 325 字，而且越写越像旁白。
 * 长度不能靠硬截断收拾（那会切掉半句话），所以给用户三个档位，
 * 由提示词里的规则去管；缺省「标准」与老数据一致。
 */
const REPLY_LENGTH_OPTIONS: Array<{ value: ReplyLength; label: string; note: string }> = [
  { value: 'short', label: '偏短', note: '两三句、60 字以内，节奏快' },
  { value: 'normal', label: '标准', note: '三到五句、150 字以内（默认）' },
  { value: 'long', label: '偏长', note: '可以写到 400 字，适合铺陈场景' },
];

function shorten(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s*\n\s*/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}……`;
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
 *
 * 顺序 59 之后它自己不再拿流式文本：正在生成的那条由 `StreamingBubble` 订阅 store 自己画，
 * 已落盘的消息由 `MessageList`（memo）画——输入框打字、token 到达都不再重画整个列表。
 */
function MainChatImpl({
  conversation,
  scene,
  messages,
  cast,
  avatars,
  busy,
  ready,
  archived,
  focus = null,
  insertRequest = null,
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
  onChangeModes,
  unlimitedPrompt,
  onOpenScene,
  onDropInstance,
  onReassign,
}: Props) {
  countRender('MainChat');
  const coarsePointer = useCoarsePointer();
  /**
   * 消息列表只要「谁在场、叫什么」（顺序 62）。
   *
   * `cast` 是角色实例数组，而实例的情绪/关系**每轮都会被后台分析改写**——
   * 一改就是新数组，600 条消息跟着重画一遍（实测一轮 36 次整表重画）。
   * 名字没变时这里保持同一个引用，`MessageList` 的 memo 才拦得住。
   */
  const castKey = cast.map((member) => `${member.id}:${member.displayName}`).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: 故意的——只在名字变了时才换引用
  const castNames = useMemo<CastName[]>(
    () => cast.map((member) => ({ id: member.id, displayName: member.displayName })),
    [castKey],
  );
  const [input, setInput] = useState('');
  const [editingId, setEditingId] = useState<MessageId | null>(null);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  /**
   * 无限制模式提示词的编辑草稿（2026-09-25）。
   *
   * 与旧版「高级系统提示」的草稿同一个套路：编辑期间只动本地草稿，显式保存才写库。
   * `unlimitedPrompt.text` 只在初次加载与保存后变化，所以这个 effect 不会打断正在输入的内容。
   */
  const [unlimitedDraft, setUnlimitedDraft] = useState(unlimitedPrompt.text);
  useEffect(() => {
    setUnlimitedDraft(unlimitedPrompt.text);
  }, [unlimitedPrompt.text]);
  const unlimitedReady = unlimitedPrompt.text.trim() !== '';
  /**
   * 旧版「高级系统提示 · 当前对话」（顺序 67e 的输入框）还留着内容的证据。
   *
   * 界面不再提供编辑入口，但那段文字**仍然在装配**——用户当初写下的要求不该因为
   * 一次界面重构就悄悄失效。留着就说明一句，并给一个显式的清空入口。
   */
  const legacyAdvancedPrompt = conversation.modes.advancedSystemPrompt?.trim() ?? '';
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

  const openMenu = useCallback((id: MessageId, x: number, y: number): void => {
    setMenuFor(id);
    setMenuAt({ x, y });
  }, []);
  const closeMenu = useCallback((): void => {
    setMenuFor(null);
    setMenuAt(null);
  }, []);

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

  /** 手指一移开或一滑动就取消：那是在滚动，不是长按。 */
  const cancelPress = useCallback((): void => {
    if (pressTimer.current === null) return;
    window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  }, []);

  /** 长按开始计时。安卓上长按也会派发 contextmenu，两条路都开同一个菜单，重复无副作用。 */
  const startPress = useCallback(
    (id: MessageId, x: number, y: number): void => {
      cancelPress();
      pressPoint.current = { x, y };
      pressTimer.current = window.setTimeout(() => {
        pressTimer.current = null;
        swallowNextClick.current = true;
        openMenu(id, pressPoint.current.x, pressPoint.current.y);
      }, LONG_PRESS_MS);
    },
    [cancelPress, openMenu],
  );

  const swallowClick = useCallback((event: MouseEvent<HTMLElement>): void => {
    if (!swallowNextClick.current) return;
    swallowNextClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

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
    const onAnyClick = (event: globalThis.MouseEvent): void => {
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

  /*
   * 新消息落下来时要不要跟到底部（审计 B17）。
   *
   * 以前是无条件滚到底：用户往上翻着看旧剧情，后台一条消息落库就被拽回底部。
   * 现在只在「本来就贴着底部（80px 内）」或「是自己刚发的那句」时跟；否则只亮一个
   * 「有新消息」的小按钮，点了再下去。流式长出来的那部分由 StreamingBubble 自己按同样的规矩跟。
   */
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const onBodyScroll = useCallback(() => {
    const node = bodyRef.current;
    if (node === null) return;
    const near = isNearBottom(node);
    nearBottomRef.current = near;
    if (near) setHasNewBelow(false);
  }, []);
  const jumpToBottom = useCallback(() => {
    nearBottomRef.current = true;
    setHasNewBelow(false);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const lastMessage = messages[messages.length - 1];
  const lastMessageKey = lastMessage === undefined ? '' : `${lastMessage.id}:${String(lastMessage.content.length)}`;
  const lastIsPlayer = lastMessage?.role === 'player';
  const conversationKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastMessageKey === '') return;
    // 正在跳原句时别把用户又拽到底部——下面那条 effect 会自己滚到位
    if (focus !== null) return;
    // 刚切进一条对话：总是从底部开始看
    const switched = conversationKeyRef.current !== conversation.id;
    conversationKeyRef.current = conversation.id;
    if (switched || lastIsPlayer || nearBottomRef.current) {
      nearBottomRef.current = true;
      setHasNewBelow(false);
      bottomRef.current?.scrollIntoView({ behavior: switched ? 'auto' : 'smooth' });
      return;
    }
    setHasNewBelow(true);
  }, [lastMessageKey, lastIsPlayer, focus, conversation.id]);

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
  const lastCharacterId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message !== undefined && message.role === 'character') return message.id;
    }
    return null;
  }, [messages]);

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

  /*
   * 顶栏角色条点一下 → 把名字插到光标处（用户 2026-09-24 要求）。
   *
   * 插完**聚焦输入框并把光标放在名字后面**：下一步就是写你要问他的那句话，
   * 不该再让人点一下输入框。`insertRequest` 换了引用才跑，所以同一个名字连点两次
   * 也会插两次（`seq` 由 App 递增）。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在请求变化时插一次；把 input 放进依赖会因为「插入本身改了 input」而自己触发自己
  useEffect(() => {
    if (insertRequest === null) return;
    const node = inputRef.current;
    const start = node?.selectionStart ?? input.length;
    const end = node?.selectionEnd ?? input.length;
    setInput(`${input.slice(0, start)}${insertRequest.text}${input.slice(end)}`);
    window.requestAnimationFrame(() => {
      const target = inputRef.current;
      if (target === null) return;
      target.focus();
      const caret = start + insertRequest.text.length;
      target.setSelectionRange(caret, caret);
    });
  }, [insertRequest]);

  const startEdit = useCallback((id: MessageId): void => setEditingId(id), []);
  const cancelEdit = useCallback((): void => setEditingId(null), []);
  const saveEdit = useCallback(
    (id: MessageId, content: string): void => {
      onEdit(id, content);
      setEditingId(null);
    },
    [onEdit],
  );

  /** 每条消息共用的那组回调：一个稳定的对象，几百条 MessageItem 才能被 memo 跳过。 */
  const handlers = useMemo<MessageHandlers>(
    () => ({
      onContextMenu: openMenu,
      onPressStart: startPress,
      onPressCancel: cancelPress,
      onClickCapture: swallowClick,
      onStartEdit: startEdit,
      onCancelEdit: cancelEdit,
      onEdit: saveEdit,
      onRegenerate,
      onDelete,
      onReassign,
    }),
    [
      openMenu,
      startPress,
      cancelPress,
      swallowClick,
      startEdit,
      cancelEdit,
      saveEdit,
      onRegenerate,
      onDelete,
      onReassign,
    ],
  );

  const menuMessage = menuFor === null ? null : (messages.find((message) => message.id === menuFor) ?? null);

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
      <div className="chat-body" ref={bodyRef} onScroll={onBodyScroll}>
        {archived ? (
          <div className="notice warn">
            <strong>这是一条已归档的对话</strong>
            <p>情绪、关系与记忆已经回滚到它开始之前；这里只用于回顾，不能再接着说话。</p>
          </div>
        ) : null}

        {messages.length === 0 && !busy ? (
          <p className="hint">
            {conversation.kind === 'side'
              ? '让管理员帮你起草角色卡、世界书，或者设置当前场景。'
              : '说点什么。右栏的角色可以直接拖进来。'}
          </p>
        ) : null}

        <MessageList
          messages={messages}
          cast={castNames}
          avatars={avatars}
          lastCharacterId={lastCharacterId}
          editingId={editingId}
          highlightId={highlightId}
          menuFor={menuFor}
          showIntent={showIntent}
          busy={busy}
          archived={archived}
          manualMode={manualMode}
          handlers={handlers}
        />

        <StreamingBubble
          key={conversation.id}
          busy={busy}
          suspendAutoScroll={focus !== null}
          bottomRef={bottomRef}
          cast={castNames}
          avatars={avatars}
        />

        {hasNewBelow ? (
          <button type="button" className="jump-to-latest" onClick={jumpToBottom}>
            ↓ 有新消息
          </button>
        ) : null}

        <div ref={bottomRef} />
      </div>

      {menuMessage !== null
        ? createPortal(
            <div
              className="row-menu"
              ref={menuRef}
              style={menuAt === null ? undefined : { left: menuAt.x, top: menuAt.y }}
            >
              {menuMessage.id === lastCharacterId ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={busy || archived || manualMode}
                  onClick={() => {
                    closeMenu();
                    onRegenerate(menuMessage.id);
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
                  setEditingId(menuMessage.id);
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
                  if (window.confirm('删除这条消息？')) onDelete(menuMessage.id);
                }}
              >
                删除
              </button>
              {cast.length > 1 && menuMessage.role === 'character' ? (
                <label className="attr-pick">
                  改归属
                  <select
                    value={menuMessage.speakerInstanceId ?? ''}
                    disabled={busy || archived}
                    onChange={(event) => {
                      closeMenu();
                      onReassign(menuMessage.id, event.target.value as InstanceId);
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
              {formatUsage(menuMessage.usage) === '' ? null : (
                <span className="hint">{formatUsage(menuMessage.usage)}</span>
              )}
            </div>,
            document.body,
          )
        : null}

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
      <Composer
        value={input}
        onChange={setInput}
        inputRef={inputRef}
        disabled={!ready || archived}
        busy={busy}
        /*
         * 桥接开着的时候不让再发一句：那会把「正等着贴回来」的这一步冲掉，
         * 而已经落盘的玩家消息又撤不回来。先把手上的这一轮转完。
         */
        bridgeOpen={bridge !== null}
        manualMode={manualMode && bridge === null}
        bridgeTitle="先把这一轮贴回来（或点「放弃这一轮」）再发下一句"
        onSend={submit}
        onStop={onStop}
        placeholder={
          archived
            ? '已归档的对话不能再说话'
            : ready
              ? coarsePointer
                ? '说点什么……（回车换行，点右下角发送）'
                : '说点什么……（Enter 发送，Shift+Enter 换行）'
              : '先导入角色卡'
        }
        tools={
          <>
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
                  {MODE_OPTIONS.map((mode) => (
                    <label key={mode.key} className="mode-option">
                      <input
                        type="checkbox"
                        checked={mode.read(conversation.modes)}
                        disabled={archived}
                        onChange={(event) => onChangeModes(mode.write(event.target.checked))}
                      />
                      <span>
                        <strong>{mode.label}</strong>
                        <span className="hint">{mode.note}</span>
                      </span>
                    </label>
                  ))}

                  <p className="hint">回答长度</p>
                  {REPLY_LENGTH_OPTIONS.map((option) => (
                    <label key={option.value} className="mode-option">
                      <input
                        type="radio"
                        name={`reply-length-${conversation.id}`}
                        checked={replyLengthOf(conversation.modes) === option.value}
                        disabled={archived}
                        onChange={() => onChangeModes({ replyLength: option.value })}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <span className="hint">{option.note}</span>
                      </span>
                    </label>
                  ))}

                  {/*
                    无限制模式的正文是**用户数据**，所以粘贴框在这儿、存在本机。
                    它不会进代码、不会进网页包（`packages/core/src/prompt/unlimited.ts` 顶上
                    记了为什么）；代价是不参与同步，换设备要重新粘一次。
                  */}
                  <label className="mode-menu-label" htmlFor={`unlimited-prompt-${conversation.id}`}>
                    无限制模式的提示词
                  </label>
                  <p className="hint">
                    只存在这台设备上（不进代码、不进网页包，也不同步）。
                    {unlimitedReady ? `当前 ${unlimitedPrompt.text.trim().length} 字。` : '还没填。'}
                  </p>
                  <textarea
                    id={`unlimited-prompt-${conversation.id}`}
                    className="mode-text-input"
                    value={unlimitedDraft}
                    maxLength={4000}
                    rows={5}
                    disabled={archived}
                    placeholder="粘贴你自己的提示词"
                    onChange={(event) => setUnlimitedDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    className="ghost mode-menu-button"
                    disabled={archived || unlimitedDraft === unlimitedPrompt.text}
                    onClick={() => void unlimitedPrompt.save(unlimitedDraft)}
                  >
                    保存提示词
                  </button>

                  {unlimitedModeOf(conversation.modes) && !unlimitedReady ? (
                    <p className="hint">无限制模式已经打开，但提示词还是空的：现在它不会改变提示词。</p>
                  ) : null}

                  {/*
                    旧版「高级系统提示」还有内容：说明它仍在生效，并给一个显式的清空入口。
                    不静默丢弃，也不静默继续生效——两样都让人摸不着头脑。
                  */}
                  {legacyAdvancedPrompt === '' ? null : (
                    <>
                      <p className="hint">
                        这条对话还留着旧版「高级系统提示」（{legacyAdvancedPrompt.length} 字），仍在生效。
                      </p>
                      <button
                        type="button"
                        className="ghost mode-menu-button"
                        disabled={archived}
                        onClick={() => onChangeModes({ advancedSystemPrompt: '' })}
                      >
                        清空旧提示
                      </button>
                    </>
                  )}

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
          </>
        }
      />
    </section>
  );
}

/** memo：App 因数据变化重渲染时，只要传给它的 props 没变（回调都是稳定的），主对话整块跳过。 */
export const MainChat = memo(MainChatImpl);
