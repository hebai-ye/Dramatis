import type { ProviderPrice, ProviderRole } from '@dramatis/core';
import { useEffect, useState } from 'react';
import type { KeyStorageMode } from '../lib/keystore';
import { describeKeyStore } from '../lib/keystore';
import type { ProvidersApi } from '../lib/providers';

interface Props {
  api: ProvidersApi;
  disabled: boolean;
}

/** 常见服务商的兼容端点。只填域名也可以，内核会自动补 /v1。 */
const ENDPOINT_PRESETS = [
  { label: 'DeepSeek', value: 'https://api.deepseek.com' },
  { label: 'OpenAI', value: 'https://api.openai.com/v1' },
  { label: 'Moonshot Kimi', value: 'https://api.moonshot.cn/v1' },
  { label: '阿里百炼', value: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { label: '智谱 GLM', value: 'https://open.bigmodel.cn/api/paas/v4' },
  { label: 'Ollama 本地', value: 'http://localhost:11434/v1' },
  { label: 'LM Studio 本地', value: 'http://localhost:1234/v1' },
];

const NEW_PROFILE_LABEL = '＋ 新建配置';

/** 面板上的草稿。改字段只动草稿，点保存才落库。 */
interface Draft {
  name: string;
  model: string;
  baseUrl: string;
  role: ProviderRole;
  temperature: number;
  maxTokens: number;
  reserveForReply: number;
  apiKey: string;
  keyMode: KeyStorageMode;
  /** 单价按字符串收：空字符串表示「没填」，比 0 更诚实。 */
  priceInput: string;
  priceOutput: string;
  priceCurrency: string;
}

function priceField(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function draftOf(api: ProvidersApi): Draft | null {
  const active = api.active;
  if (!active) return null;
  const price = active.price ?? null;
  return {
    name: active.name,
    model: active.model,
    baseUrl: active.baseUrl,
    role: active.role,
    temperature: active.temperature,
    maxTokens: active.maxTokens,
    reserveForReply: active.reserveForReply,
    apiKey: api.apiKey,
    keyMode: api.keyMode,
    priceInput: price === null ? '' : priceField(price.inputPerMillion),
    priceOutput: price === null ? '' : priceField(price.outputPerMillion),
    priceCurrency: price === null ? '¥' : price.currency,
  };
}

/**
 * 草稿里的单价 → 存进配置的单价。
 *
 * 两个价格都空着就是「没填」→ null：账单只报 token，不编钱。
 * 只填了一个也算数（另一个按 0 计），这样「输入贵、输出便宜」这类模型也能表达。
 */
function priceOf(draft: Draft): ProviderPrice | null {
  if (draft.priceInput.trim() === '' && draft.priceOutput.trim() === '') return null;
  return {
    inputPerMillion: Number(draft.priceInput) || 0,
    outputPerMillion: Number(draft.priceOutput) || 0,
    currency: draft.priceCurrency.trim() === '' ? '¥' : draft.priceCurrency.trim(),
  };
}

function isSameDraft(left: Draft | null, right: Draft | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.name === right.name &&
    left.model === right.model &&
    left.baseUrl === right.baseUrl &&
    left.role === right.role &&
    left.temperature === right.temperature &&
    left.maxTokens === right.maxTokens &&
    left.reserveForReply === right.reserveForReply &&
    left.apiKey === right.apiKey &&
    left.keyMode === right.keyMode &&
    left.priceInput === right.priceInput &&
    left.priceOutput === right.priceOutput &&
    left.priceCurrency === right.priceCurrency
  );
}

/**
 * 模型接入。
 *
 * 面板是**草稿式**的：字段改动只停留在本地，点「保存」才写进配置与密钥库。
 * 这样用户能在确认之前来回改，也不至于每敲一个字符就落一次盘；「密钥保存方式」
 * 与密钥本身也会一起生效。
 */
export function ProviderPanel({ api, disabled }: Props) {
  const [showKey, setShowKey] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const active = api.active;
  const { activeId, keyMode } = api;

  /**
   * 草稿的重置时机。
   *
   * 只在「换了一份配置」或「那份配置在库里变了」时重置——不能每渲染一次就重置，
   * 否则用户正在输入的内容会被冲掉。所以依赖是一串具体的值，而不是整个 api 对象。
   */
  const signature = [activeId, keyMode, active?.name, active?.model, active?.baseUrl, active?.role].join('|');

  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖就是上面那串值，重新取整个 api 会把草稿冲掉
  useEffect(() => {
    setDraft(draftOf(api));
    setSavedAt(null);
  }, [signature]);

  const dirty = !isSameDraft(draft, draftOf(api));

  const patch = (values: Partial<Draft>): void => {
    setDraft((previous) => (previous === null ? previous : { ...previous, ...values }));
    setSavedAt(null);
  };

  const save = async (): Promise<void> => {
    if (draft === null || active === null) return;
    await api.commitConfig({
      profile: {
        name: draft.name,
        model: draft.model,
        baseUrl: draft.baseUrl,
        role: draft.role,
        temperature: draft.temperature,
        maxTokens: draft.maxTokens,
        reserveForReply: draft.reserveForReply,
        price: priceOf(draft),
      },
      apiKey: draft.apiKey,
      keyMode: draft.keyMode,
    });
    setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  };

  return (
    <section className="panel">
      <h2>模型接入</h2>

      <label>
        当前配置
        <select
          value={api.activeId ?? ''}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value === '__new__') {
              void api.addProfile({ name: '新配置', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' });
              return;
            }
            void api.selectProfile(event.target.value);
          }}
        >
          {api.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · {profile.model}
            </option>
          ))}
          <option value="__new__">{NEW_PROFILE_LABEL}</option>
        </select>
      </label>

      {active && draft ? (
        <>
          <div className="grid-2">
            <label>
              名称
              <input
                type="text"
                value={draft.name}
                disabled={disabled}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </label>
            <label>
              模型名
              <input
                type="text"
                value={draft.model}
                disabled={disabled}
                onChange={(event) => patch({ model: event.target.value })}
              />
            </label>
          </div>

          <label>
            接口地址
            <input
              type="text"
              list="endpoint-presets"
              value={draft.baseUrl}
              disabled={disabled}
              onChange={(event) => patch({ baseUrl: event.target.value })}
            />
          </label>
          <datalist id="endpoint-presets">
            {ENDPOINT_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </datalist>

          <label>
            用途
            <select
              value={draft.role}
              disabled={disabled}
              onChange={(event) => patch({ role: event.target.value as ProviderRole })}
            >
              <option value="both">对话与后台都用</option>
              <option value="main">只用于对话</option>
              <option value="background">只用于后台任务</option>
            </select>
          </label>
          <p className="hint">
            后台任务（记忆抽取、情绪推演）可以单独配一个更便宜的模型。标了「只用于后台任务」的配置会成为
            这些调用专用的通道。
          </p>

          <label>
            API Key
            <span className="inline">
              <input
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                disabled={disabled}
                placeholder="sk-..."
                onChange={(event) => patch({ apiKey: event.target.value })}
              />
              <button type="button" className="ghost" onClick={() => setShowKey((value) => !value)}>
                {showKey ? '隐藏' : '显示'}
              </button>
            </span>
          </label>

          <label>
            密钥保存方式
            <select
              value={draft.keyMode}
              disabled={disabled}
              onChange={(event) => patch({ keyMode: event.target.value === 'device' ? 'device' : 'session' })}
            >
              <option value="session">仅本次会话（最安全）</option>
              <option value="device">保存在本机浏览器（最方便）</option>
            </select>
          </label>
          <p className="hint warn">
            {describeKeyStore(draft.keyMode === 'device' ? 'plain' : 'memory')}
            {draft.keyMode === api.keyMode ? '' : '（保存后生效）'}
          </p>

          <div className="grid-3">
            <label>
              温度
              <input
                type="number"
                step="0.05"
                min="0"
                max="2"
                value={draft.temperature}
                disabled={disabled}
                onChange={(event) => patch({ temperature: Number(event.target.value) || 0 })}
              />
            </label>
            <label>
              上下文窗口
              <input
                type="number"
                step="1024"
                min="1024"
                value={draft.maxTokens}
                disabled={disabled}
                onChange={(event) => patch({ maxTokens: Number(event.target.value) || 1024 })}
              />
            </label>
            <label>
              预留回复
              <input
                type="number"
                step="256"
                min="0"
                value={draft.reserveForReply}
                disabled={disabled}
                onChange={(event) => patch({ reserveForReply: Number(event.target.value) || 0 })}
              />
            </label>
          </div>

          <div className="grid-3">
            <label>
              输入价 / 百万 token
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="留空＝不换算"
                value={draft.priceInput}
                disabled={disabled}
                onChange={(event) => patch({ priceInput: event.target.value })}
              />
            </label>
            <label>
              输出价 / 百万 token
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="留空＝不换算"
                value={draft.priceOutput}
                disabled={disabled}
                onChange={(event) => patch({ priceOutput: event.target.value })}
              />
            </label>
            <label>
              币种
              <input
                type="text"
                maxLength={4}
                value={draft.priceCurrency}
                disabled={disabled}
                onChange={(event) => patch({ priceCurrency: event.target.value })}
              />
            </label>
          </div>
          <p className="hint">
            单价由你自己填（各家价格不同、还会变）。填了之后，运行时的「用量」页会把 token 换算成钱； 留空就只报 token
            数，绝不会用编出来的价格糊弄你。
          </p>

          <div className="save-bar">
            <button type="button" disabled={disabled || !dirty} onClick={() => void save()}>
              保存
            </button>
            <button
              type="button"
              className="ghost"
              disabled={disabled || !dirty}
              title="放弃这次改动，恢复成已保存的值"
              onClick={() => {
                setDraft(draftOf(api));
                setSavedAt(null);
              }}
            >
              撤销
            </button>
            <span className="hint">
              {dirty ? '有未保存的改动' : savedAt === null ? '改动只在点保存后生效' : `已保存（${savedAt}）`}
            </span>
          </div>

          <button
            type="button"
            className="ghost danger"
            disabled={disabled || api.profiles.length <= 1}
            onClick={() => {
              if (window.confirm(`删除配置「${active.name}」？`)) void api.deleteProfile(active.id);
            }}
          >
            删除这个配置
          </button>
        </>
      ) : (
        <p className="hint">还没有模型配置。</p>
      )}
    </section>
  );
}
