/**
 * 界面上重复出现的选项表与数字格式（顺序 65 收敛重复）。
 *
 * 这几份原本各写了两遍：`PRESENCE_OPTIONS` 在角色栏与角色详情里、
 * `CAST_POLICY_OPTIONS` 在场景面板与场景弹窗里、`signed()` 在两处数值显示里。
 * 收敛时发现两份**已经漂了**（不是完全一样），下面把两处漂移单独标出来。
 */
import type { CastPolicy, Presence } from '@dramatis/core';

/**
 * 角色在某个世界里的状态。
 *
 * ⚠️ 收敛时的一处**有意统一**：角色栏那份少了 `absent`（已离场），所以从角色栏
 * 的下拉里根本选不出「已离场」——只能进角色详情改。以更全的那份为准。
 */
export const PRESENCE_OPTIONS: Array<{ value: Presence; label: string; note: string }> = [
  { value: 'onstage', label: '在场', note: '会说话，也会记得发生的事' },
  { value: 'muted', label: '沉默', note: '在场但不发言，仍然记得' },
  { value: 'offscreen', label: '在幕后', note: '不在这个场景，但时间仍在流逝' },
  { value: 'absent', label: '已离场', note: '暂时不参与这条世界线' },
];

/**
 * 这一场戏允许谁入场。
 *
 * ⚠️ 收敛时的一处**有意统一**：`locked` 的说明原本一处写「不得引入任何新角色」、
 * 一处写「AI 不得引入任何新角色」，取后者（说清是谁不许引入）。
 */
export const CAST_POLICY_OPTIONS: Array<{ value: CastPolicy; label: string; note: string }> = [
  { value: 'locked', label: '锁定名单', note: 'AI 不得引入任何新角色' },
  { value: 'invite_only', label: '仅限召唤', note: '只有你点名的角色才能入场' },
  { value: 'triggered', label: '条件触发', note: '设定被触发时才入场' },
  { value: 'open', label: '自由入场', note: '符合条件的角色可自行登场' },
];

/** 带正负号的两位小数：情绪与关系都是 -1..1 的量，符号比数字本身更重要。 */
export function signed(value: number): string {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(2)}`;
}
