import type { ReactNode } from 'react';
import { IconMenu } from './Icons';

interface Props {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** 浏览器不给 IndexedDB：数据只存在内存里。这条警告任何屏幕都留着。 */
  degraded: boolean;
  backgroundPending: number;
  /**
   * 窄屏（≤640px）。
   *
   * 手机上这条栏是**唯一的导航**：左上角开左栏，中间是在场角色（半高、可横滑），
   * 右上角是主/副切换与面板——用户 2026-09-24 要求照 DeepSeek 手机端的布局排
   * （他们的原话：面板放右上角，切换主副放在面板左边，开左栏的按钮放 DeepSeek 那个位置）。
   */
  narrow: boolean;
  /** 窄屏时插在顶栏中间的角色条（与顶栏齐平、半高）。 */
  castStrip?: ReactNode;
  /** 窄屏时右上角的那两颗（主/副切换、面板）。 */
  chatControls?: ReactNode;
}

/**
 * 顶栏（LAYOUT「顶栏」）。
 *
 * 桌面：左上角折叠左栏，其余留给未来的「世界视图」——这条栏刻意是窄的、空的。
 * 手机：不再预留空白，顶上就是导航（见上面的 `narrow`）。
 *
 * 两处**已经删掉**的东西（用户 2026-09-24 拍板）：
 * - 「全屏」按钮：整个功能弃掷，装成应用（PWA）那条路照旧，引导文案也改了；
 * - 「存储：indexeddb」：位置信息在「设置 → 数据 → 本机存储」里已经写着，顶栏不重复。
 *   但「数据不会保存」这条**保留**——它是丢数据的警告，不是位置说明。
 */
export function TopBar({
  collapsed,
  onToggleCollapsed,
  degraded,
  backgroundPending,
  narrow,
  castStrip,
  chatControls,
}: Props) {
  return (
    <header className={narrow ? 'topbar narrow' : 'topbar'}>
      <button
        type="button"
        className="ghost rail-toggle"
        title={collapsed ? '展开左栏' : '折叠左栏'}
        aria-label={collapsed ? '展开左栏' : '折叠左栏'}
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
      >
        {narrow ? <IconMenu size={20} /> : collapsed ? '≫' : '≪'}
      </button>

      {/* 手机上不放品牌文字：顶栏的每一像素都留给导航与在场角色 */}
      {narrow ? null : (
        <span className="brand-inline">
          <strong>Dramatis</strong>
          <span className="hint">世界视图预留</span>
        </span>
      )}

      {narrow ? castStrip : null}

      <div className="topbar-spacer" />

      {narrow ? chatControls : null}

      {backgroundPending > 0 ? <span className="tag">后台任务 {backgroundPending}</span> : null}

      {degraded ? (
        <span className="tag danger-tag" title="当前浏览器不允许使用 IndexedDB，数据只存在内存里">
          数据不会保存
        </span>
      ) : null}
    </header>
  );
}
