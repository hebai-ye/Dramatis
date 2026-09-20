import { WEB_BRIDGE_TARGET } from '@dramatis/core';
import { useEffect, useState } from 'react';

/**
 * 网页版桥接面板（没有 API Key 时的第一条路）。
 *
 * 它只做一件事：把应用**本来要发出去的那段提示词**交给用户，再把网页版的回复收回来。
 * 提示词不是另写的——就是 `runTurn` 装配出来的那一份（世界书命中、记忆召回、
 * 视角裁剪、预算降级全都在里面），所以「网页版玩出来的体验」与「填了 Key 的体验」
 * 差在自动化程度上，不差在内容上。
 *
 * 两阶段：先收角色回复，再（可选）收这一轮的记忆与情绪。第二阶段可以跳过——
 * 跳过只是「这一轮没被记住」，不会把对话卡住。
 */

export interface WebBridgeState {
  /** `reply` 收角色回复；`analysis` 收这一轮的记忆与情绪。 */
  stage: 'reply' | 'analysis';
  /** 这一轮属于哪个回合（两阶段共用）。 */
  turnId: string;
  /** 正等着谁开口。 */
  speakerInstanceId: string;
  /** 正等着谁开口（显示用）。 */
  speakerName: string;
  /** 要贴进网页版的那段文本。 */
  prompt: string;
}

interface Props {
  bridge: WebBridgeState;
  busy: boolean;
  disabled: boolean;
  onReply: (text: string) => void;
  onAnalysis: (text: string) => void;
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

export function WebBridgePanel({ bridge, busy, disabled, onReply, onAnalysis, onSkip }: Props) {
  const [paste, setPaste] = useState('');
  const [copied, setCopied] = useState(false);

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

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const isReply = bridge.stage === 'reply';
  const submit = (): void => {
    if (paste.trim() === '' || busy || disabled) return;
    if (isReply) onReply(paste);
    else onAnalysis(paste);
  };

  return (
    <section className="web-bridge">
      <header className="bridge-head">
        <strong>
          {isReply
            ? `① 让 ${WEB_BRIDGE_TARGET.name} 写「${bridge.speakerName}」这一轮`
            : '② 顺手把这一轮的记忆也写一下'}
        </strong>
        <span className="hint">
          {isReply
            ? '没配 API Key，所以这一轮由你手动转一手：贴过去、贴回来，剩下的交给应用。'
            : '可选。贴回来之后，这一轮就会被谁记住、谁对谁起了变化——不贴也能接着聊。'}
        </span>
      </header>

      <div className="bridge-steps">
        <button
          type="button"
          className="ghost"
          disabled={disabled}
          onClick={() => {
            void copyText(bridge.prompt).then((ok) => setCopied(ok));
          }}
        >
          {copied ? '已复制 ✓' : isReply ? '1. 复制提示词' : '1. 复制这一步的提示词'}
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

      <label>
        3. 把网页版的回复整段贴回这里
        <textarea
          rows={6}
          value={paste}
          disabled={disabled}
          placeholder={isReply ? '「……」他/她说了什么，就贴什么' : '贴那段 JSON；它写着有点乱也没关系，解析是宽容的'}
          onChange={(event) => setPaste(event.target.value)}
        />
      </label>

      <div className="save-bar">
        <button type="button" disabled={disabled || busy || paste.trim() === ''} onClick={submit}>
          {busy ? '处理中…' : isReply ? '收下这条回复' : '收下这段记忆'}
        </button>
        <button type="button" className="ghost" disabled={disabled || busy} onClick={onSkip}>
          {isReply ? '放弃这一轮' : '跳过（这一轮先不记）'}
        </button>
      </div>
    </section>
  );
}
