interface Props {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  backendKind: string;
  degraded: boolean;
  backgroundPending: number;
}

/**
 * 顶栏（LAYOUT「顶栏」）。
 *
 * 规格里写得很清楚：左上角是**折叠左栏**，其余部分目前不设功能，
 * 预留给未来的「世界视图」——以节点网络显示角色、物品、事件之间的联系。
 *
 * 所以这条栏是窄的，而且大部分是空的：宁可为将来的蓝图留一块干净的画布，
 * 也不要把导航再塞回来。世界切换与素材管理都在左栏，不在顶上。
 */
export function TopBar({ collapsed, onToggleCollapsed, backendKind, degraded, backgroundPending }: Props) {
  return (
    <header className="topbar">
      <button
        type="button"
        className="ghost rail-toggle"
        title={collapsed ? '展开左栏' : '折叠左栏'}
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
      >
        {collapsed ? '≫' : '≪'}
      </button>

      <span className="brand-inline">
        <strong>Dramatis</strong>
        <span className="hint">世界视图预留</span>
      </span>

      <div className="topbar-spacer" />

      {backgroundPending > 0 ? <span className="tag">后台任务 {backgroundPending}</span> : null}

      {degraded ? (
        <span className="tag danger-tag" title="当前浏览器不允许使用 IndexedDB，数据只存在内存里">
          数据不会保存
        </span>
      ) : (
        <span className="hint">存储：{backendKind || '…'}</span>
      )}
    </header>
  );
}
