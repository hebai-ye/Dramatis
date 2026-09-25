import type { KeyStore, ProviderPrice, ProviderRole } from '@dramatis/core';
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
  /** 口令加密那一档用：新建库或解锁已有库。空字符串表示「还没填」。 */
  vaultPassphrase: string;
  /** 单价按字符串收：空字符串表示「没填」，比 0 更诚实。 */
  priceInput: string;
  priceOutput: string;
  priceCurrency: string;
}

function priceField(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/** 下拉框的字符串 → 档位。认不出来的按「仅本次会话」（最保守那档）。 */
function keyModeOf(value: string): KeyStorageMode {
  return value === 'device' ? 'device' : value === 'encrypted' ? 'encrypted' : 'session';
}

/** 档位 → 描述用哪个 kind（描述文案住在 keystore.ts，只有一份）。 */
function keyKindOf(mode: KeyStorageMode): KeyStore['kind'] {
  return mode === 'encrypted' ? 'encrypted' : mode === 'device' ? 'plain' : 'memory';
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
    vaultPassphrase: '',
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
    left.vaultPassphrase === right.vaultPassphrase &&
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
  const [clipboardBusy, setClipboardBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  /** 口令库的报错（口令不对 / 文件坏了）：就地显示，不弹窗。 */
  const [vaultError, setVaultError] = useState<string | null>(null);
  const active = api.active;
  const { activeId, keyMode } = api;
  const controlsDisabled = disabled || saveBusy || clipboardBusy;

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
    if (draft === null || active === null || saveBusy || clipboardBusy) return;
    setVaultError(null);
    setSaveBusy(true);
    try {
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
        vaultPassphrase: draft.vaultPassphrase,
      });
      // 口令用完了就从草稿里擦掉：它只在这一刻需要，留在界面上没有好处
      setDraft((previous) => (previous === null ? previous : { ...previous, vaultPassphrase: '' }));
      setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
    } catch (error) {
      // 口令不对 / 库坏了：**不要**当成「保存成功」，也不要清掉用户填的 Key
      setVaultError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaveBusy(false);
    }
  };

  return (
    <section className="panel" aria-busy={saveBusy || clipboardBusy}>
      <label>
        当前配置
        <select
          value={api.activeId ?? ''}
          disabled={controlsDisabled}
          onChange={(event) => {
            if (event.target.value === '__new__') {
              void api.addProfile({ name: '新配置', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
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
                disabled={controlsDisabled}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </label>
            <label>
              模型名
              <input
                type="text"
                value={draft.model}
                disabled={controlsDisabled}
                onChange={(event) => patch({ model: event.target.value })}
              />
            </label>
          </div>

          {draft.baseUrl.startsWith('https://api.deepseek.com') &&
          (draft.model === 'deepseek-chat' || draft.model === 'deepseek-reasoner') ? (
            <p className="hint warn">
              DeepSeek 已公告停用这个旧模型名。建议改为 deepseek-flash 或 deepseek-v4-pro 后保存；密钥保持原样。
            </p>
          ) : null}

          <label>
            接口地址
            <input
              type="text"
              list="endpoint-presets"
              value={draft.baseUrl}
              disabled={controlsDisabled}
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
              disabled={controlsDisabled}
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
                disabled={controlsDisabled}
                placeholder="sk-..."
                onChange={(event) => patch({ apiKey: event.target.value })}
              />
              <button
                type="button"
                className="ghost"
                disabled={controlsDisabled}
                aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                aria-pressed={showKey}
                onClick={() => setShowKey((value) => !value)}
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </span>
          </label>

          {/*
            顺序 7：「官方 Key 极简引导」。

            只在**还没填 Key** 时出现——已经填好的人不需要再看一遍说明。
            三步里有一步是「去注册、去充值」，那是用户以为最麻烦的部分，
            所以把入口直连到 API keys 页，并给一个「粘贴 Key」入口。
            粘贴只修改草稿，仍需点「保存」才会写入密钥库。
          */}
          {draft.apiKey.trim() === '' ? (
            <div className="key-guide">
              <strong>还没有 Key？三步就好（大约两分钟）</strong>
              <ol>
                <li>
                  打开{' '}
                  <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
                    DeepSeek 开放平台
                  </a>
                  （注册 / 登录；充值在同一个控制台的「充值」页，最低几块钱就能聊很久）。
                </li>
                <li>在「API keys」里创建一个，名字随便起；它只显示这一次，当场复制。</li>
                <li>回到这里点「粘贴 Key」，再点表单底部的「保存」。</li>
              </ol>
              <div className="save-bar">
                <button
                  type="button"
                  disabled={controlsDisabled}
                  title="从剪贴板读取 sk- 开头的 Key，填入草稿；点保存后生效"
                  onClick={() => {
                    void (async () => {
                      setVaultError(null);
                      setClipboardBusy(true);
                      try {
                        const text = (await navigator.clipboard.readText()).trim();
                        if (text === '') throw new Error('剪贴板是空的：先在开放平台复制那个 Key。');
                        if (!text.startsWith('sk-')) {
                          throw new Error('剪贴板里的东西不像 API Key（一般是 sk- 开头）。先在开放平台复制。');
                        }
                        setDraft((previous) => (previous === null ? previous : { ...previous, apiKey: text }));
                      } catch (error) {
                        setVaultError(error instanceof Error ? error.message : String(error));
                      } finally {
                        setClipboardBusy(false);
                      }
                    })();
                  }}
                >
                  {clipboardBusy ? '读取中…' : '粘贴 Key'}
                </button>
                <span className="hint">读剪贴板要浏览器许可；不让读就手动粘贴，效果一样</span>
              </div>
            </div>
          ) : null}

          <label>
            密钥保存方式
            <select
              value={draft.keyMode}
              disabled={controlsDisabled}
              onChange={(event) => patch({ keyMode: keyModeOf(event.target.value) })}
            >
              <option value="session">仅本次会话（最安全）</option>
              <option value="device">保存在本机浏览器（最方便）</option>
              <option value="encrypted">用一句口令加密后保存在本机（顺序 10）</option>
            </select>
          </label>
          <p className="hint warn">
            {describeKeyStore(keyKindOf(draft.keyMode))}
            {draft.keyMode === api.keyMode ? '' : '（保存后生效）'}
          </p>

          {/*
            口令加密那一档（顺序 10）。

            两件事在界面上是同一条口令：**新建库**（本机还没有）与**解锁**（已经有）。
            所以只给一个输入框 + 一个按钮，按钮上的字跟着状态变——
            不给用户出「先选是新建还是解锁」这种我们自己才知道的选择题。
          */}
          {draft.keyMode === 'encrypted' ? (
            <label>
              {api.vaultExists ? '口令（解锁本机的口令库）' : '口令（用来加密这台机器上的 Key）'}
              <span className="inline">
                <input
                  type="password"
                  value={draft.vaultPassphrase}
                  disabled={controlsDisabled}
                  placeholder={api.vaultExists ? '这台机器上已有口令库' : '设一句只有你知道的（忘记就只能重填 Key）'}
                  autoComplete="off"
                  onChange={(event) => patch({ vaultPassphrase: event.target.value })}
                />
                <button
                  type="button"
                  className="ghost"
                  disabled={controlsDisabled || draft.vaultPassphrase.trim() === ''}
                  title="用这句口令打开本机的口令库（解不开就说明口令不对）"
                  onClick={() => {
                    setVaultError(null);
                    void api
                      .unlockVault(draft.vaultPassphrase)
                      .then(() => patch({ vaultPassphrase: '' }))
                      .catch((error: unknown) => setVaultError(error instanceof Error ? error.message : String(error)));
                  }}
                >
                  解锁
                </button>
              </span>
            </label>
          ) : null}

          {api.vaultLocked ? (
            <p className="hint warn">
              这台机器上的 Key 是用口令加密存的，现在还没解锁——这一轮会走网页版桥接。
              在上面填口令点「解锁」，或者点「保存」把这次填的 Key 存进库里。
            </p>
          ) : null}

          {vaultError === null ? null : (
            <div className="notice error" role="alert">
              <p>{vaultError}</p>
            </div>
          )}

          {/*
            用户一定会问「我填进去的 Key 到底被谁看见」。答案要写在**填的地方**，
            而不是藏在文档里——顺序 8 那一项就是这件事。
          */}
          <details className="key-facts">
            <summary>这个 Key 会被谁看见？（点开看）</summary>
            <ul>
              <li>
                <strong>你的浏览器</strong>：选「仅本次会话」时只在内存里，关掉页面就没了；选「保存在本机浏览器」时 会
                <strong>明文</strong>写进本站的
                localStorage（同源脚本都读得到，所以别在这个域上装来路不明的脚本或扩展）。
              </li>
              <li>
                <strong>模型服务商</strong>：会。请求由浏览器<strong>直连</strong>服务商（形如{' '}
                <code>https://api.deepseek.com</code>），Key 放在 <code>Authorization</code>{' '}
                请求头里——不经过本项目的任何中转。
              </li>
              <li>
                <strong>同步服务端</strong>：不会。服务端只存密文与哈希，连「Key」这个字段都没有；模型配置也不在同步
                白名单里，导出封存时同样不带它。
              </li>
              <li>
                <strong>给你发这个网页的人</strong>：<strong>能</strong>。这是唯一的信任边界——能改这个网页的人
                就能读你填进来的 Key。自己部署=自己；用别人的站点，等于把这项能力交给站主。
              </li>
            </ul>
            <p className="hint">
              想更稳：用「仅本次会话」（默认），或者自己在服务器上跑一份这个网页。任务清单里还有一步
              「口令加密落盘」——做完之后即使选「保存在本机浏览器」，磁盘上也是密文。
            </p>
          </details>

          <div className="grid-3">
            <label>
              温度
              <input
                type="number"
                step="0.05"
                min="0"
                max="2"
                value={draft.temperature}
                disabled={controlsDisabled}
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
                disabled={controlsDisabled}
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
                disabled={controlsDisabled}
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
                disabled={controlsDisabled}
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
                disabled={controlsDisabled}
                onChange={(event) => patch({ priceOutput: event.target.value })}
              />
            </label>
            <label>
              币种
              <input
                type="text"
                maxLength={4}
                value={draft.priceCurrency}
                disabled={controlsDisabled}
                onChange={(event) => patch({ priceCurrency: event.target.value })}
              />
            </label>
          </div>
          <p className="hint">
            单价由你自己填（各家价格不同、还会变）。填了之后，运行时的「用量」页会把 token 换算成钱； 留空就只报 token
            数，绝不会用编出来的价格糊弄你。
          </p>

          <div className="save-bar">
            <button type="button" disabled={controlsDisabled || !dirty} onClick={() => void save()}>
              {saveBusy ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={controlsDisabled || !dirty}
              title="放弃这次改动，恢复成已保存的值"
              onClick={() => {
                setDraft(draftOf(api));
                setSavedAt(null);
              }}
            >
              撤销
            </button>
            <span className="hint" role="status">
              {dirty ? '有未保存的改动' : savedAt === null ? '改动只在点保存后生效' : `已保存（${savedAt}）`}
            </span>
          </div>

          <button
            type="button"
            className="ghost danger"
            disabled={controlsDisabled || api.profiles.length <= 1}
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
