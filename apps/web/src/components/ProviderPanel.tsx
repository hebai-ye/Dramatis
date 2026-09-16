import { useState } from 'react';
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

function toNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function ProviderPanel({ api, disabled }: Props) {
  const [showKey, setShowKey] = useState(false);
  const active = api.active;

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

      {active ? (
        <>
          <div className="grid-2">
            <label>
              名称
              <input
                type="text"
                value={active.name}
                disabled={disabled}
                onChange={(event) => void api.updateProfile(active.id, { name: event.target.value })}
              />
            </label>
            <label>
              模型名
              <input
                type="text"
                value={active.model}
                disabled={disabled}
                onChange={(event) => void api.updateProfile(active.id, { model: event.target.value })}
              />
            </label>
          </div>

          <label>
            接口地址
            <input
              type="text"
              list="endpoint-presets"
              value={active.baseUrl}
              disabled={disabled}
              onChange={(event) => void api.updateProfile(active.id, { baseUrl: event.target.value })}
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
            API Key
            <span className="inline">
              <input
                type={showKey ? 'text' : 'password'}
                value={api.apiKey}
                disabled={disabled}
                placeholder="sk-..."
                onChange={(event) => void api.setApiKey(event.target.value)}
              />
              <button type="button" className="ghost" onClick={() => setShowKey((value) => !value)}>
                {showKey ? '隐藏' : '显示'}
              </button>
            </span>
          </label>

          <label>
            密钥保存方式
            <select
              value={api.keyMode}
              disabled={disabled}
              onChange={(event) => void api.setKeyMode(event.target.value === 'device' ? 'device' : 'session')}
            >
              <option value="session">仅本次会话（最安全）</option>
              <option value="device">保存在本机浏览器（最方便）</option>
            </select>
          </label>
          <p className="hint warn">{describeKeyStore(api.keyKind)}</p>

          <div className="grid-3">
            <label>
              温度
              <input
                type="number"
                step="0.05"
                min="0"
                max="2"
                value={active.temperature}
                disabled={disabled}
                onChange={(event) =>
                  void api.updateProfile(active.id, {
                    temperature: toNumber(event.target.value, active.temperature),
                  })
                }
              />
            </label>
            <label>
              上下文窗口
              <input
                type="number"
                step="1024"
                min="1024"
                value={active.maxTokens}
                disabled={disabled}
                onChange={(event) =>
                  void api.updateProfile(active.id, { maxTokens: toNumber(event.target.value, active.maxTokens) })
                }
              />
            </label>
            <label>
              预留回复
              <input
                type="number"
                step="256"
                min="0"
                value={active.reserveForReply}
                disabled={disabled}
                onChange={(event) =>
                  void api.updateProfile(active.id, {
                    reserveForReply: toNumber(event.target.value, active.reserveForReply),
                  })
                }
              />
            </label>
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
