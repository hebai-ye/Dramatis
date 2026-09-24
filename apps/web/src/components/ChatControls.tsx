interface Props {
  isSide: boolean;
  disabled: boolean;
  panelOpen: boolean;
  onToggleKind: () => void;
  onTogglePanel: () => void;
}

/**
 * 手机顶栏右上角的那两颗（用户 2026-09-24 要求）。
 *
 * 1. **主/副对话合并成一个按钮**（原话：设为一个，点击切换即可）。一个按钮同时
 *    显示「现在在哪一边、点一下去哪一边」：里面是「主」「副」两个字，当前那个高亮。
 *    为什么不做成纯图标：这两个概念没有通用图标，手机上认不出来反而是负担。
 * 2. **面板在最右**——放最右是因为它在手机上是个覆盖层（点开铺满对话区），
 *    放在拇指最容易够到的角上。
 */
export function ChatControls({ isSide, disabled, panelOpen, onToggleKind, onTogglePanel }: Props) {
  const kindLabel = isSide ? '切回主对话' : '切到副对话（世界管理员）';

  return (
    <div className="chat-controls">
      <button
        type="button"
        className="ghost kind-toggle"
        disabled={disabled}
        title={kindLabel}
        aria-label={kindLabel}
        onClick={onToggleKind}
      >
        <span className={isSide ? 'kind-half' : 'kind-half active'}>主</span>
        <span className={isSide ? 'kind-half active' : 'kind-half'}>副</span>
      </button>

      <button
        type="button"
        className={panelOpen ? 'ghost panel-toggle active' : 'ghost panel-toggle'}
        disabled={disabled}
        title="运行时面板：场景、阵容、记忆、Prompt"
        aria-label="面板"
        aria-expanded={panelOpen}
        onClick={onTogglePanel}
      >
        面板
      </button>
    </div>
  );
}
