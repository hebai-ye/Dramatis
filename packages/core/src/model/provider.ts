import { newId, nowIso } from './ids.js';

/**
 * 模型服务配置（ROADMAP P0-8）。
 *
 * 注意这里**没有 apiKey 字段**：密钥只存在 `KeyStore` 里，实体只保存引用。
 * 这样实体本身可以安全地参与同步（P2-6），密钥永远不会离开设备。
 */
export type ProviderRole =
  /** 正式生成用。 */
  | 'main'
  /** 后台任务专用，通常配更便宜的模型（P1-9）。 */
  | 'background'
  /** 两者都可用。 */
  | 'both';

export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /** KeyStore 中的键名。 */
  keyRef: string;
  temperature: number;
  /** 模型上下文窗口。 */
  maxTokens: number;
  /** 为回复预留的空间。 */
  reserveForReply: number;
  role: ProviderRole;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProviderProfileInput {
  name: string;
  baseUrl: string;
  model: string;
  keyRef?: string;
  temperature?: number;
  maxTokens?: number;
  reserveForReply?: number;
  role?: ProviderRole;
}

export function createProviderProfile(input: CreateProviderProfileInput): ProviderProfile {
  const id = newId();
  const now = nowIso();

  return {
    id,
    name: input.name.trim() === '' ? '未命名服务' : input.name.trim(),
    baseUrl: input.baseUrl,
    model: input.model,
    keyRef: input.keyRef ?? `provider:${id}`,
    temperature: input.temperature ?? 0.9,
    maxTokens: input.maxTokens ?? 16384,
    reserveForReply: input.reserveForReply ?? 1024,
    role: input.role ?? 'both',
    createdAt: now,
    updatedAt: now,
  };
}
