export interface VipPlan {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly durationDays: number;
  readonly maxBytes: number;
  readonly priceFen: number;
  readonly creditNanoyuan: string;
}

const version = '2026-10-01-v1';

/** 服务端决定整期权益；金额以十进制字符串跨越 JSON 边界。 */
export const VIP_PLANS: readonly VipPlan[] = Object.freeze([
  Object.freeze({
    id: 'vip-month-256',
    version,
    name: '月度256MB',
    durationDays: 30,
    maxBytes: 256 * 1024 ** 2,
    priceFen: 1000,
    creditNanoyuan: '5000000000',
  }),
  Object.freeze({
    id: 'vip-quarter-512',
    version,
    name: '季度512MB',
    durationDays: 90,
    maxBytes: 512 * 1024 ** 2,
    priceFen: 3000,
    creditNanoyuan: '15000000000',
  }),
  Object.freeze({
    id: 'vip-year-1g',
    version,
    name: '年度1GB',
    durationDays: 365,
    maxBytes: 1024 ** 3,
    priceFen: 6800,
    creditNanoyuan: '34000000000',
  }),
  Object.freeze({
    id: 'vip-year-5g',
    version,
    name: '年度5GB',
    durationDays: 365,
    maxBytes: 5 * 1024 ** 3,
    priceFen: 9800,
    creditNanoyuan: '49000000000',
  }),
]);

export const API_PLANS = VIP_PLANS;

export function getVipPlan(id: unknown): VipPlan {
  const plan = VIP_PLANS.find((candidate) => candidate.id === id);
  if (!plan) throw new Error('未知VIP套餐。');
  return plan;
}
