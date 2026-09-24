import type { ReactNode } from 'react';

/**
 * 输入区用的几个内联图标（用户 2026-09-21：输入区照 Codex 的样子重做）。
 *
 * 为什么不引图标库：一共四个图形，每个十来行路径，内联进来还能直接吃
 * `currentColor`——三套色调切换时它们跟着变色，不用管。尺寸统一 16，
 * 一律 `aria-hidden`：旁边的按钮都有 `aria-label` 或可见文字。
 */

interface IconProps {
  size?: number;
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
