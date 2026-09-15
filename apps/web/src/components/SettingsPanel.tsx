import type { Settings } from '../lib/settings';

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  disabled: boolean;
}

/** 常见服务商的兼容端点，填域名也可以，内核会自动补 /v1。 */
const ENDPOINT_PRESETS = [
  { label: 'DeepSeek', value: 'https://api.deepseek.com' },
  { label: 'OpenAI', value: 'https://api.openai.com/v1' },
  { label: 'Moonshot Kimi', value: 'https://api.moonshot.cn/v1' },
  { label: '阿里百炼', value: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { label: '智谱 GLM', value: 'https://open.bigmodel.cn/api/paas/v4' },
  { label: 'Ollama 本地', value: 'http://localhost:11434/v1' },
  { label: 'LM Studio 本地', value: 'http://localhost:1234/v1' },
];

function toNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function SettingsPanel({ settings, onChange, disabled }: Props) {
  return (
    <section className="panel">
      <h2>模型接入</h2>
      <p className="hint">请求由浏览器直连服务商，Dramatis 不代理，也不上传你的 Key。</p>

      <label>
        接口地址
        <input
          type="text"
          list="endpoint-presets"
          value={settings.baseUrl}
          disabled={disabled}
          onChange={(event) => onChange({ baseUrl: event.target.value })}
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
        <input
          type="password"
          value={settings.apiKey}
          disabled={disabled}
          placeholder="sk-..."
          onChange={(event) => onChange({ apiKey: event.target.value })}
        />
      </label>

      <label>
        模型名
        <input
          type="text"
          value={settings.model}
          disabled={disabled}
          onChange={(event) => onChange({ model: event.target.value })}
        />
      </label>

      <div className="grid-3">
        <label>
          温度
          <input
            type="number"
            step="0.05"
            min="0"
            max="2"
            value={settings.temperature}
            disabled={disabled}
            onChange={(event) => onChange({ temperature: toNumber(event.target.value, settings.temperature) })}
          />
        </label>
        <label>
          上下文窗口
          <input
            type="number"
            step="1024"
            min="1024"
            value={settings.maxTokens}
            disabled={disabled}
            onChange={(event) => onChange({ maxTokens: toNumber(event.target.value, settings.maxTokens) })}
          />
        </label>
        <label>
          为回复预留
          <input
            type="number"
            step="256"
            min="0"
            value={settings.reserveForReply}
            disabled={disabled}
            onChange={(event) =>
              onChange({ reserveForReply: toNumber(event.target.value, settings.reserveForReply) })
            }
          />
        </label>
      </div>

      <label>
        你的名字（persona）
        <input
          type="text"
          value={settings.playerName}
          disabled={disabled}
          onChange={(event) => onChange({ playerName: event.target.value })}
        />
      </label>

      <p className="hint warn">
        M0 阶段 Key 存在浏览器 localStorage。搬到设备安全存储是 M4 的任务。
      </p>
    </section>
  );
}
