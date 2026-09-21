import { WEB_BRIDGE_TARGET } from '@dramatis/core';
import { useEffect, useState } from 'react';
import { askLocalBridge, type LocalBridgeStatus, probeLocalBridge } from '../lib/local-bridge';

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
}

interface Props {
  bridge: WebBridgeState;
  busy: boolean;
  disabled: boolean;
  onReply: (text: string) => void;
  onAnalysis: (text: string) => void;
  /** 世界管理员（副对话）那一种：收下的是要解析成素材草稿的文本。 */
  onAdmin?: (text: string) => void;
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

export function WebBridgePanel({ bridge, busy, disabled, onReply, onAnalysis, onAdmin, onSkip }: Props) {
  const [paste, setPaste] = useState('');
  const [copied, setCopied] = useState(false);
  /** 本地助手（顺序 38）：没起进程就是 null，起了就是它的状态。 */
  const [helper, setHelper] = useState<LocalBridgeStatus | null>(null);
  const [helperBusy, setHelperBusy] = useState(false);
  const [helperError, setHelperError] = useState<string | null>(null);

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
  const [stage, setStage] = useState(bridge.stage);
  if (stage !== bridge.stage) {
    setStage(bridge.stage);
    setPaste('');
    setCopied(false);
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
    const pullClipboard = (): void => {
      if (document.visibilityState !== 'visible') return;
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          const trimmed = text.trim();
          if (trimmed === '') return;
          setPaste((latest) => (latest.trim() === '' ? trimmed : latest));
        })
        .catch(() => {
          // 没给剪贴板权限：什么都不说，用户手动粘贴即可
        });
    };
    window.addEventListener('focus', pullClipboard);
    document.addEventListener('visibilitychange', pullClipboard);
    return () => {
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
  const submit = (): void => {
    if (paste.trim() === '' || busy || disabled) return;
    if (isReply) onReply(paste);
    else if (isAdmin) onAdmin?.(paste);
    else onAnalysis(paste);
  };

  /**
   * 本地助手那条路（顺序 38）：把同一段提示词交给本机那个助手，
   * 它替你打进模型网页、等回复、把文字交回来——然后走**与手动粘贴完全同一条**
   * 收下路径（`submit` 用的那几个 handler），所以解析、落盘、校验一份都不少。
   */
  const askHelper = async (): Promise<void> => {
    if (helperBusy || busy || disabled) return;
    setHelperError(null);
    setHelperBusy(true);
    try {
      const text = await askLocalBridge(bridge.prompt);
      setPaste(text);
      if (text.trim() === '') throw new Error('助手回来了，但没读到回复内容（页面结构可能变了）。');
      if (isReply) onReply(text);
      else if (isAdmin) onAdmin?.(text);
      else onAnalysis(text);
    } catch (error) {
      setHelperError(error instanceof Error ? error.message : String(error));
    } finally {
      setHelperBusy(false);
    }
  };

  return (
    <section className="web-bridge">
      <header className="bridge-head">
        <strong>
          {isAdmin
            ? `让 ${WEB_BRIDGE_TARGET.name} 替世界管理员起草`
            : isReply
              ? `① 让 ${WEB_BRIDGE_TARGET.name} 写「${bridge.speakerName ?? ''}」这一轮`
              : '② 顺手把这一轮的记忆也写一下'}
        </strong>
        <span className="hint">
          {isAdmin
            ? '没配 API Key，所以起草这一步由你手动转一手：贴过去、贴回来，草稿由应用解析成角色卡 / 世界书 / 场景。'
            : isReply
              ? '没配 API Key，所以这一轮由你手动转一手：贴过去、贴回来，剩下的交给应用。'
              : '可选。贴回来之后，这一轮就会被谁记住、谁对谁起了变化——不贴也能接着聊。'}
        </span>
      </header>

      <div className="bridge-steps">
        {/*
          本地助手（顺序 38）：只有本机真的跑着那个进程、并且已经连上模型网页时才出现。
          没起进程 = 这块整段不渲染，用户看到的还是「复制 → 打开 → 贴回来」那三步。
        */}
        {helper?.attached === true ? (
          <button
            type="button"
            className="ghost bridge-helper"
            disabled={disabled || busy || helperBusy}
            title="让本机的助手替你打开的那一页发送、等回复、再交回来（它驱动的是网页本身，不是官方接口）"
            onClick={() => void askHelper()}
          >
            {helperBusy ? '本地助手正在等它写完…' : '一键用本地助手（免复制粘贴）'}
          </button>
        ) : null}
        <button
          type="button"
          className="ghost"
          disabled={disabled}
          onClick={() => {
            void copyText(bridge.prompt).then((ok) => setCopied(ok));
          }}
        >
          {copied ? '已复制 ✓' : isReply || isAdmin ? '1. 复制提示词' : '1. 复制这一步的提示词'}
        </button>
        <a className="bridge-link" href={WEB_BRIDGE_TARGET.url} target="_blank" rel="noreferrer">
          2. 打开 {WEB_BRIDGE_TARGET.name}
        </a>
        <span className="hint">{WEB_BRIDGE_TARGET.hint}</span>
      </div>

      <details className="bridge-prompt">
        <summary>看一眼这段提示词（{bridge.prompt.length} 字）</summary>
        <pre>{bridge.prompt}</pre>
      </details>

      {/* 助手那条路的解释与报错都摆在这儿：它做的事越自动，越要说清它是什么 */}
      {helper?.attached === true ? (
        <p className="hint">
          本地助手在跑：它会驱动你**已经登录**的那个 {WEB_BRIDGE_TARGET.name} 标签页。
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

      <label>
        3. 把网页版的回复整段贴回这里
        <textarea
          rows={6}
          value={paste}
          disabled={disabled}
          placeholder={
            isAdmin
              ? '整段贴回来（含 ```json 代码块）：它写着有点乱也没关系，解析是宽容的'
              : isReply
                ? '「……」他/她说了什么，就贴什么'
                : '贴那段 JSON；它写着有点乱也没关系，解析是宽容的'
          }
          onChange={(event) => setPaste(event.target.value)}
        />
      </label>

      <div className="save-bar">
        <button type="button" disabled={disabled || busy || paste.trim() === ''} onClick={submit}>
          {busy ? '处理中…' : isAdmin ? '收下这次起草' : isReply ? '收下这条回复' : '收下这段记忆'}
        </button>
        <button type="button" className="ghost" disabled={disabled || busy} onClick={onSkip}>
          {isAdmin ? '放弃这次起草' : isReply ? '放弃这一轮' : '跳过（这一轮先不记）'}
        </button>
      </div>
    </section>
  );
}
