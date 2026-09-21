import type { EncryptedRecord } from '../crypto/records.js';
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
  /** 账户里当前选中的配置；随账户同步，但不参与调用参数。 */
  active?: boolean;
  /** 单价，缺省表示「没填」——账单只报 token，不编钱。 */
  price?: ProviderPrice | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 随账户同步的模型凭据（账户重构 A6/A7）。
 *
 * `encryptedSecret` 由账户同步主密钥加密；同步层还会再加密整条记录，
 * 所以服务端拿到的是双层密文。换到新设备后，用同一个同步主密钥解出 Key，
 * 再按本机选择写入 KeyStore。
 */
export interface ProviderCredential {
  id: string;
  providerId: string;
  /** 加密 AAD 中的稳定修订号；不能用同步层的 updatedAt。 */
  revision: string;
  encryptedSecret: EncryptedRecord;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
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
  active?: boolean;
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
    /*
     * 默认窗口与回复预留（2026-09-21 用户要求：按「800 条用户输入」设）。
     *
     * 算给你看：一轮 = 玩家一句（约 25 字）+ 角色一段（约 120 字）≈ 145 字 ≈ 74 token。
     * 800 轮 ≈ 59k token；再加上系统提示、角色卡、场景、记忆索引（实测约 3k token），
     * 总量约 62k。所以：
     *
     * - **65536**：这是 DeepSeek-chat 自己的真实窗口，取它作默认值既够 800 轮，
     *   又不会把用户推到一个「模型根本不接受」的窗口上（128k 的模型可以自己改大）。
     * - **4096** 的回复预留：一句一千字的回复也就 ~500 token，4k 是宽裕的余量；
     *   原来那 1k 在长回复时会被顶到边。
     *
     * 超出窗口时不会失败：装配层的预算守卫会**从最旧的历史开始丢**（budget.ts 第一级），
     * 所以「800 条」是「装得下就装」，不是「装不下就报错」。
     */
    maxTokens: input.maxTokens ?? 65536,
    reserveForReply: input.reserveForReply ?? 4096,
    role: input.role ?? 'both',
    active: input.active ?? false,
    price: input.price ?? null,
    createdAt: now,
    updatedAt: now,
  };
}
