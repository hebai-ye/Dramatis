import {
  type ConversationId,
  type InstanceId,
  type IntentMode,
  type RoomId,
  type SceneId,
  WEB_BRIDGE_TARGET,
} from '@dramatis/core';
import { useEffect, useRef, useState } from 'react';
import { askLocalBridge, type LocalBridgeStatus, probeLocalBridge } from '../lib/local-bridge';
import { Modal } from './Modal';

/**
 * 网页版桥接面板（没有 API Key 时的第一条路）。
 *
 * 它只做一件事：把应用**本来要发出去的那段提示词**交给用户，再把网页版的回复收回来。
 * 提示词不是另写的——就是 `runTurn` 装配出来的那一份（世界书命中、记忆召回、
 * 视角裁剪、预算降级全都在里面），所以「网页版玩出来的体验」与「填了 Key 的体验」
 * 差在自动化程度上，不差在内容上。
 *
 * 三种用法：主对话先收角色回复、再（可选）收这一轮的记忆与情绪（第二阶段可跳过，
 * 跳过只是「这一轮没被记住」）；副对话收世界管理员起草的素材（带工具调用的 JSON 块）。
 */

export interface PendingBridgeTurn {
  accountKey?: string;
  roomId: RoomId;
  conversationId: ConversationId;
  sceneId: SceneId;
  turnId: string;
  playerText: string;
  speakerIds: InstanceId[];
  nextIndex: number;
  /** 每位的导演意图随桥接进度保存；第二份提示词不能丢掉其 hold_back 判断。旧状态可无。 */
  speakerPlans?: { intent: string | null; mode: IntentMode }[];
  /** 静默/动作回合贴回时也不能让网页版的台词混入。旧状态缺省 false。 */
  actionsOnly?: boolean;
}

export interface WebBridgeState {
  /**
   * `reply` 收角色回复；`analysis` 收这一轮的记忆与情绪；
   * `admin` 收世界管理员起草的素材（副对话）。
   */
  stage: 'reply' | 'analysis' | 'admin';
  /** 这一轮属于哪个回合（主对话的两个阶段共用；副对话不需要）。 */
  turnId?: string;
  /** 正等着谁开口（`reply` 阶段用）。 */
  speakerInstanceId?: string;
  /** 正等着谁开口（显示用）。 */
  speakerName?: string;
  /** 要贴进网页版的那段文本。 */
  prompt: string;
  sourceLabel?: string;
  sourceKey?: string;
  /** 首位贴回前还不是已提交回合；刷新后凭它核对场景并接着逐人贴回。 */
  pendingTurn?: PendingBridgeTurn;
}

interface Props {
  bridge: WebBridgeState;
  busy: boolean;
  disabled: boolean;
  onReply: (text: string) => void;
  onAnalysis: (text: string) => void;
  /** 世界管理员（副对话）那一种：收下的是要解析成素材草稿的文本。 */
  onAdmin?: ((text: string) => void) | ((text: string) => Promise<import('../lib/admin').BridgeCommitOutcome>);
  onInspect?: () => Promise<import('../lib/admin').BridgeCommitOutcome>;
  onSkip: () => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非 https 或没给剪贴板权限时退一步：选中提示词，用户自己按 Ctrl+C
    return false;
  }
}

export function WebBridgePanel({ bridge, busy, disabled, onReply, onAnalysis, onAdmin, onInspect, onSkip }: Props) {
  const [paste, setPaste] = useState('');
  const [copied, setCopied] = useState(false);
  const [invalidSource, setInvalidSource] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copyBusyRef = useRef(false);
  const copyRequestId = useRef(0);
  const promptRef = useRef(bridge.prompt);
  const promptDetailsRef = useRef<HTMLDetailsElement>(null);
  /** 本地助手（顺序 38）：没起进程就是 null，起了就是它的状态。 */
  const [helper, setHelper] = useState<LocalBridgeStatus | null>(null);
  const [helperBusy, setHelperBusy] = useState(false);
  const [helperError, setHelperError] = useState<string | null>(null);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [applying, setApplying] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [clipboardFilled, setClipboardFilled] = useState(false);
  const [lateReply, setLateReply] = useState('');
  const gate = useRef({
    step: '',
    mode: 'idle' as 'idle' | 'helper' | 'applying' | 'uncertain',
    generation: 0,
    revision: 0,
    helperUsed: false,
    mounted: true,
    invalid: false,
  });
  useEffect(() => {
    gate.current.mounted = true;
    return () => {
      gate.current.mounted = false;
      gate.current.generation++;
    };
  }, []);

  /*
   * 打开面板时问一次本机有没有助手在跑（一次请求，不轮询）。
   * 没起进程、或者浏览器不让访问本机地址时都是「没有」——那就照旧手动复制粘贴，
   * 这条路永远是兜底。
   */
  useEffect(() => {
    let cancelled = false;
    void probeLocalBridge().then((status) => {
      if (!cancelled) setHelper(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * 换阶段就清空粘贴框，免得把上一段的回复错手交给下一步。
   * 用「渲染时对账」而不是 effect：effect 要等一次提交才生效，中间那一帧
   * 粘贴框里还留着上一步的内容，手快的人会点错。
   */
  const bridgeStep = JSON.stringify([
    bridge.stage,
    bridge.turnId,
    bridge.sourceKey,
    bridge.prompt,
    bridge.speakerInstanceId,
    bridge.pendingTurn?.nextIndex ?? 0,
  ]);
  const stepRef = useRef(bridgeStep);
  stepRef.current = bridgeStep;
  if (gate.current.step !== bridgeStep)
    gate.current = {
      step: bridgeStep,
      mode: 'idle',
      generation: gate.current.generation + 1,
      revision: 0,
      helperUsed: false,
      mounted: true,
      invalid: false,
    };
  const [stage, setStage] = useState(bridgeStep);
  if (stage !== bridgeStep) {
    setStage(bridgeStep);
    setPaste('');
    setCopied(false);
    copyRequestId.current += 1;
    copyBusyRef.current = false;
    setCopyBusy(false);
    setCopyError(false);
    setHelperBusy(false);
    setHelperError(null);
  }
  if (promptRef.current !== bridge.prompt) {
    promptRef.current = bridge.prompt;
    copyRequestId.current += 1;
    copyBusyRef.current = false;
    setCopied(false);
    setCopyBusy(false);
    setCopyError(false);
    setHelperBusy(false);
    setApplying(false);
    setUncertain(false);
    setInvalidSource(false);
    setConfirmSkip(false);
    setClipboardFilled(false);
    setLateReply('');
    setHelperError(null);
  }

  /**
   * 回到这个页面时，把剪贴板里的东西自动填进粘贴框。
   *
   * 省掉的正是「复制回来 → 点输入框 → 粘贴」这三下：从 DeepSeek 网页版复制完切回来，
   * 框里已经是他刚复制的答案，只需要点「收下」。
   *
   * 三条约束：① 只在框还空着时填，绝不覆盖他已经写的字；② 读剪贴板需要许可，
   * 被拒就静默放弃（照旧手动粘贴）；③ 只在窗口重新获得焦点时读一次，不轮询。
   */
  useEffect(() => {
    let cancelled = false;
    const pullClipboard = (): void => {
      const step = stepRef.current;
      if (document.visibilityState !== 'visible') return;
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (cancelled || stepRef.current !== step) return;
          const trimmed = text.trim();
          if (trimmed === '') return;
          setPaste((latest) => {
            if (latest.trim() !== '' || gate.current.mode === 'applying' || gate.current.mode === 'uncertain')
              return latest;
            gate.current.revision++;
            setClipboardFilled(true);
            return trimmed;
          });
        })
        .catch(() => {
          // 没给剪贴板权限：什么都不说，用户手动粘贴即可
        });
    };
    window.addEventListener('focus', pullClipboard);
    document.addEventListener('visibilitychange', pullClipboard);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', pullClipboard);
      document.removeEventListener('visibilitychange', pullClipboard);
    };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const isReply = bridge.stage === 'reply';
  const isAdmin = bridge.stage === 'admin';
  const applyAdmin = async (inspect = false): Promise<void> => {
    if (
      busy ||
      disabled ||
      gate.current.mode === 'applying' ||
      gate.current.mode === 'helper' ||
      (!inspect && (gate.current.mode === 'uncertain' || gate.current.invalid))
    )
      return;
    if (!inspect && paste.trim() === '') return;
    const generation = gate.current.generation;
    gate.current.mode = 'applying';
    setApplying(true);
    setHelperError(null);
    try {
      const result = await (inspect ? onInspect?.() : onAdmin?.(paste));
      if (!gate.current.mounted || generation !== gate.current.generation) return;
      const unknown = !result || result.status === 'uncertain';
      gate.current.mode = unknown ? 'uncertain' : 'idle';
      setUncertain(unknown);
      if (result?.status === 'rejected' && /来源|变化|旧起草|原世界|有效来源/.test(result.reason)) {
        gate.current.invalid = true;
        setInvalidSource(true);
      }
      if (
        result &&
        (result.status === 'uncertain' || result.status === 'rejected' || result.status === 'saved-read-failed')
      )
        setHelperError(result.reason);
    } catch (error) {
      if (gate.current.mounted && generation === gate.current.generation) {
        gate.current.mode = 'uncertain';
        setUncertain(true);
        setHelperError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (gate.current.mounted && generation === gate.current.generation) setApplying(false);
    }
  };
  const submit = (): void => {
    if (paste.trim() === '' || busy || disabled || gate.current.mode !== 'idle' || gate.current.invalid) return;
    if (isReply) onReply(paste);
    else if (isAdmin) void applyAdmin();
    else onAnalysis(paste);
  };

  const copyPrompt = async (): Promise<void> => {
    if (copyBusyRef.current) return;
    copyBusyRef.current = true;
    const requestId = ++copyRequestId.current;
    const prompt = bridge.prompt;
    setCopyBusy(true);
    setCopied(false);
    setCopyError(false);
    try {
      const ok = await copyText(prompt);
      if (requestId !== copyRequestId.current) return;
      if (ok) {
        setCopied(true);
      } else {
        setCopyError(true);
        // 展开已有提示词区，用户可以自行选择内容并按 Ctrl+C；不把焦点从当前控件移走。
        if (promptDetailsRef.current) promptDetailsRef.current.open = true;
      }
    } finally {
      if (requestId === copyRequestId.current) {
        copyBusyRef.current = false;
        setCopyBusy(false);
      }
    }
  };

  /**
   * 本地助手那条路（顺序 38）：把同一段提示词交给本机那个助手，
   * 它替你打进模型网页、等回复、把文字交回来——然后走**与手动粘贴完全同一条**
   * 收下路径（`submit` 用的那几个 handler），所以解析、落盘、校验一份都不少。
   */
  const askHelper = async (): Promise<void> => {
    if (
      gate.current.mode !== 'idle' ||
      gate.current.invalid ||
      (isAdmin && gate.current.helperUsed) ||
      busy ||
      disabled
    )
      return;
    gate.current.mode = 'helper';
    gate.current.helperUsed = true;
    setHelperError(null);
    setHelperBusy(true);
    const step = bridgeStep;
    const generation = gate.current.generation,
      revision = gate.current.revision;
    try {
      const text = await askLocalBridge(bridge.prompt);
      if (stepRef.current !== step || !gate.current.mounted || generation !== gate.current.generation) return;
      if (text.trim() === '') throw new Error('助手回来了，但没读到回复内容（页面结构可能变了）。');
      if (isAdmin) {
        if (gate.current.revision === revision) {
          setPaste(text);
          setClipboardFilled(false);
        } else setLateReply(text);
        return;
      }
      setPaste(text);
      if (isReply) onReply(text);
      else onAnalysis(text);
    } catch (error) {
      if (stepRef.current === step && gate.current.mounted && generation === gate.current.generation)
        setHelperError(error instanceof Error ? error.message : String(error));
    } finally {
      if (stepRef.current === step && gate.current.mounted && generation === gate.current.generation) {
        gate.current.mode = 'idle';
        setHelperBusy(false);
      }
    }
  };

  return (
    <section className="web-bridge">
      <header className="bridge-head">
        <strong>
          {isAdmin
            ? '等待网页版回复'
            : isReply
              ? `① 让 ${WEB_BRIDGE_TARGET.name} 写「${bridge.speakerName ?? ''}」（第 ${String((bridge.pendingTurn?.nextIndex ?? 0) + 1)}/${String(bridge.pendingTurn?.speakerIds.length ?? 1)} 位）`
              : '② 顺手把这一轮的记忆也写一下'}
        </strong>
        <span className="hint">
          {isAdmin
            ? '贴回后请先核对，再应用回复。角色卡、世界书和身份会生成待采纳草稿；场景更改会直接生效。'
            : isReply
              ? '没配 API Key，所以这一轮由你手动转一手：贴过去、贴回来，剩下的交给应用。'
              : '可选。贴回来之后，这一轮就会被谁记住、谁对谁起了变化——不贴也能接着聊。'}
        </span>
      </header>

      {bridge.sourceLabel === undefined ? null : <p className="hint">起草来源：{bridge.sourceLabel}</p>}
      <div className="bridge-steps">
        {/*
          本地助手（顺序 38）：只有本机真的跑着那个进程、并且已经连上模型网页时才出现。
          没起进程 = 这块整段不渲染，用户看到的还是「复制 → 打开 → 贴回来」那三步。
        */}
        {helper?.attached === true ? (
          <button
            type="button"
            className="ghost bridge-helper"
            disabled={
              disabled ||
              busy ||
              helperBusy ||
              applying ||
              uncertain ||
              invalidSource ||
              (isAdmin && gate.current.helperUsed)
            }
            title="让本机的助手替你打开的那一页发送、等回复、再交回来（它驱动的是网页本身，不是官方接口）"
            onClick={() => void askHelper()}
          >
            {helperBusy ? '本地助手正在等它写完…' : '一键用本地助手（免复制粘贴）'}
          </button>
        ) : null}
        {isAdmin && helperBusy ? (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              gate.current.generation++;
              gate.current.mode = 'idle';
              setHelperBusy(false);
              setHelperError('已改用手动贴回。网页请求可能仍在运行，本次不再重复发送。');
            }}
          >
            改用手动贴回
          </button>
        ) : null}
        <button type="button" className="ghost" disabled={disabled || copyBusy} onClick={() => void copyPrompt()}>
          {copyBusy
            ? '正在复制…'
            : copied
              ? '已复制 ✓'
              : isReply || isAdmin
                ? '1. 复制提示词'
                : '1. 复制这一步的提示词'}
        </button>
        <a className="bridge-link" href={WEB_BRIDGE_TARGET.url} target="_blank" rel="noreferrer">
          2. 打开 {WEB_BRIDGE_TARGET.name}
        </a>
        <span className="hint">{WEB_BRIDGE_TARGET.hint}</span>
      </div>

      <details className="bridge-prompt" ref={promptDetailsRef} {...(copyError ? { open: true } : {})}>
        <summary>看一眼这段提示词（{bridge.prompt.length} 字）</summary>
        <pre>{bridge.prompt}</pre>
      </details>
      {copyError ? (
        <p className="notice error" role="status">
          自动复制失败。提示词已展开；请手动选择上方内容并按 Ctrl+C（Mac 上按 ⌘C）。
        </p>
      ) : null}

      {/* 助手那条路的解释与报错都摆在这儿：它做的事越自动，越要说清它是什么 */}
      {helper?.attached === true ? (
        <p className="hint">
          本地助手在跑：它会驱动你已经登录的那个 {WEB_BRIDGE_TARGET.name} 标签页。
          它不是官方接口——自动化操作网页可能违反对方的服务条款，用不用你自己判断；
          助手只在本机跑，提示词不经过第三方。想关掉就直接结束那个进程。
        </p>
      ) : helper?.reachable === true ? (
        <p className="hint">
          本机的助手进程起来了，但没找到 {WEB_BRIDGE_TARGET.name} 的标签页： 用它启动 Chrome（带
          --remote-debugging-port=9222）并打开那一页登录，再刷新这里。
        </p>
      ) : null}
      {helperError === null ? null : (
        <div className="notice error">
          <p>{helperError}</p>
        </div>
      )}
      {clipboardFilled ? <p className="hint">已从剪贴板填入，请核对后应用。</p> : null}
      {lateReply ? (
        <details>
          <summary>助手返回了回复；已保留你正在编辑的内容</summary>
          <pre>{lateReply}</pre>
        </details>
      ) : null}

      <label>
        3. 把网页版的回复整段贴回这里
        <textarea
          rows={6}
          value={paste}
          disabled={disabled || applying || uncertain}
          placeholder={
            isAdmin
              ? '整段贴回来（含 ```json 代码块）：它写着有点乱也没关系，解析是宽容的'
              : isReply
                ? '「……」他/她说了什么，就贴什么'
                : '贴那段 JSON；它写着有点乱也没关系，解析是宽容的'
          }
          onChange={(event) => {
            gate.current.revision++;
            setClipboardFilled(false);
            setPaste(event.target.value);
          }}
        />
      </label>

      <div className="save-bar">
        <button
          type="button"
          disabled={disabled || busy || helperBusy || applying || uncertain || invalidSource || paste.trim() === ''}
          onClick={submit}
        >
          {busy || applying ? '处理中…' : isAdmin ? '应用回复' : isReply ? '收下这条回复' : '收下这段记忆'}
        </button>
        {isAdmin && uncertain && onInspect ? (
          <button type="button" disabled={busy || disabled || applying} onClick={() => void applyAdmin(true)}>
            只读核对保存结果
          </button>
        ) : null}
        <button
          type="button"
          className="ghost"
          disabled={disabled || busy || helperBusy || applying || uncertain}
          onClick={() => {
            if (gate.current.mode !== 'idle') return;
            if (isAdmin && paste.trim() !== '') setConfirmSkip(true);
            else onSkip();
          }}
        >
          {isAdmin
            ? '放弃这次起草'
            : isReply
              ? (bridge.pendingTurn?.nextIndex ?? 0) === 0
                ? '放弃这一轮'
                : '跳过剩余回复'
              : '跳过（这一轮先不记）'}
        </button>
      </div>
      {confirmSkip ? (
        <Modal
          label="放弃这次起草"
          head={<strong>放弃这次起草？</strong>}
          onClose={() => setConfirmSkip(false)}
          footer={
            <button
              type="button"
              onClick={() => {
                if (gate.current.mode === 'idle') {
                  setConfirmSkip(false);
                  onSkip();
                }
              }}
            >
              确认放弃
            </button>
          }
        >
          <p>粘贴框中的回复将被丢弃。尚未应用的回复不会写入世界。</p>
        </Modal>
      ) : null}
    </section>
  );
}
