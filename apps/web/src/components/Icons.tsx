import type { ReactNode } from 'react';

/**
 * 输入区用的几个内联图标（用户 2026-09-21：输入区照 Codex 的样子重做）。
 *
 * 图标共用 16×16 坐标系与 1.6 描边；工具栏用 16px，手机顶栏用 20px。
 * `currentColor` 跟随按钮的 hover / focus / active / disabled 状态与主题色。
 * 一律 `aria-hidden`：按钮自己提供可访问名称。
 */

interface IconProps {
  size?: 16 | 20;
}

function Frame({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      style={{ display: 'block' }}
      viewBox="0 0 16 16"
      width={size}
    >
      {children}
    </svg>
  );
}

/** 加号：设置这一条对话的模式（原来是一个「＋」字）。 */
export function IconPlus({ size }: IconProps) {
  return (
    <Frame size={size}>
      <path d="M8 3.4v9.2M3.4 8h9.2" />
    </Frame>
  );
}

/** 地图钉：输入或切换当前场景。 */
export function IconScene({ size }: IconProps) {
  return (
    <Frame size={size}>
      <path d="M8 14.2c1.9-1.9 4.1-4.3 4.1-6.6a4.1 4.1 0 1 0-8.2 0c0 2.3 2.2 4.7 4.1 6.6Z" />
      <circle cx="8" cy="7.4" r="1.5" />
    </Frame>
  );
}

/** 向上的箭头：发送（Codex 那颗按钮就是这个形状）。 */
export function IconSend({ size }: IconProps) {
  return (
    <Frame size={size}>
      <path d="M8 13.4V3.1M3.7 7.4 8 3.1l4.3 4.3" />
    </Frame>
  );
}

/** 方块：停止（跑起来时顶掉发送键，位置不动，那一排不会跳）。 */
export function IconStop({ size }: IconProps) {
  return (
    <Frame size={size}>
      <rect fill="currentColor" height="7.4" rx="1.6" stroke="none" width="7.4" x="4.3" y="4.3" />
    </Frame>
  );
}

/**
 * 三横：手机顶栏左上角打开左栏（用户要求照 DeepSeek 的样子放这里）。
 *
 * 桌面仍然用 `≫` / `≪` 两个方向字符——那里空间够，文字能直接说明「展开/折叠」。
 */
export function IconMenu({ size }: IconProps) {
  return (
    <Frame size={size}>
      <path d="M3 4.6h10M3 8h10M3 11.4h10" />
    </Frame>
  );
}

/** 关闭、移除；具体危险语义仍由按钮文字与颜色表达。 */
export function IconClose({ size }: IconProps) {
  return (
    <Frame size={size}>
      <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />
    </Frame>
  );
}

/** 世界与对话树的层级方向。 */
export function IconChevron({ size }: IconProps) {
  return (
    <Frame size={size}>
      <path d="m6.1 3.8 4.2 4.2-4.2 4.2" />
    </Frame>
  );
}

/** 世界管理员与设置入口。 */
export function IconSettings({ size }: IconProps) {
  return (
    <Frame size={size}>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M6.6 2.1h2.8l.4 1.3 1.2.7 1.3-.3 1.4 2.4-.9 1v1.6l.9 1-1.4 2.4-1.3-.3-1.2.7-.4 1.3H6.6l-.4-1.3-1.2-.7-1.3.3-1.4-2.4.9-1V7.2l-.9-1 1.4-2.4 1.3.3 1.2-.7.4-1.3Z" />
    </Frame>
  );
}

/** 归档对话。 */
export function IconArchive({ size }: IconProps) {
  return (
    <Frame size={size}>
      <rect x="2.3" y="3.1" width="11.4" height="3.1" rx=".8" />
      <path d="M3.5 6.2v6.6h9V6.2M6.3 9.1h3.4" />
    </Frame>
  );
}

/** 编辑名称或内容。 */
export function IconEdit({ size }: IconProps) {
  return (
    <Frame size={size}>
      <path d="m10.5 2.8 2.7 2.7-7.7 7.7-3.1.4.4-3.1 7.7-7.7Z" />
      <path d="m8.9 4.4 2.7 2.7" />
    </Frame>
  );
}
