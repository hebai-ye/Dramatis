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

/**
 * 单价（每百万 token），用来把用量换算成钱（P3-7 / T7）。
 *
 * 这是**用户自己填的**数字：本项目不做价格表，因为它会过时——模型改名、降价、
 * 各家不同地区价格还不一样。填了才算得出花费，没填就只报 token 数。
 */
export interface ProviderPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  /** 只用于显示，例如 `¥` / `$`。 */
  currency: string;
}

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
  /** 单价，缺省表示「没填」——账单只报 token，不编钱。 */
  price?: ProviderPrice | null;
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
  price?: ProviderPrice | null;
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
    price: input.price ?? null,
    createdAt: now,
    updatedAt: now,
  };
}
