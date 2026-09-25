import { memo, type ReactNode, useRef } from 'react';
import { countRender } from '../lib/render-count';

/**
 * 左栏里的三段（列表 / 世界书 / 角色卡）。
 *
 * `settings` 不在其中：设置改成**弹窗**（用户要求），从底部那个按钮直接开，
 * 不再占用左栏的一块地方——否则「看设置」与「看世界列表」得来回切。
 */
export type RailPane = 'list' | 'personas' | 'worldbooks' | 'cards';

interface Props {
  pane: RailPane;
  onPaneChange: (pane: RailPane) => void;
  /** 顶层入口：创建新世界，并在其中开启首条对话。 */
  onNewConversation: () => void;
  /** 「创建」走副对话，由 AI 帮忙起草，用户决定去留。 */
  onCreateWithAi: () => void;
  /** 导入角色卡或世界书（按 JSON 结构自动分辨）。 */
  onImportFile: (file: File) => void;
  /** 打开设置弹窗。 */
  onOpenSettings: () => void;
  /** 打开「个人账户」（同步空间与身份）。 */
  onOpenAccount: () => void;
  disabled: boolean;
  /** 世界与对话列表。 */
  list: ReactNode;
  /** 素材与设置面板，逐个切换。 */
  panel: ReactNode;
}

const PANES: Array<{ id: RailPane; label: string; hint: string }> = [
  { id: 'personas', label: '我的身份', hint: '创建、编辑、删除玩家在对话中扮演的身份' },
  { id: 'worldbooks', label: '世界书', hint: '导入、删除、微调世界设定' },
  { id: 'cards', label: '角色卡', hint: '导入、删除、微调角色模板' },
];

/**
 * 左栏（LAYOUT「左栏」）。
 *
 * 分三段：
 * - 顶部的「新对话」开启新世界；世界内续开在下方世界列表里
 * - 中部：世界与对话列表，可滚动
 * - 底部：设置（已归档的对话也从这里打开）
 *
 * 素材管理（导入、删除、手动微调）留在顶部按钮里，**从零创建走副对话**：
 * 这是规格里刻意分开的两件事——前者是整理已有的东西，后者是让 AI 陪你起草。
 */
function LeftRailImpl({
  pane,
  onPaneChange,
  onNewConversation,
  onCreateWithAi,
  onImportFile,
  onOpenSettings,
  onOpenAccount,
  disabled,
  list,
  panel,
}: Props) {
  countRender('LeftRail');
  const active = PANES.find((item) => item.id === pane) ?? null;
  const fileRef = useRef<HTMLInputElement | null>(null);

  return (
    <aside className="left-rail">
      <input
        ref={fileRef}
        type="file"
        accept=".json,.png,application/json,image/png"
        className="hidden-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onImportFile(file);
          event.target.value = '';
        }}
      />

      <div className="rail-actions">
        <button
          type="button"
          disabled={disabled}
          title="创建新世界，并开启这个世界的首条对话"
          onClick={onNewConversation}
        >
          新对话
        </button>
        <button
          type="button"
          className={pane === 'personas' ? 'ghost active' : 'ghost'}
          disabled={disabled}
          onClick={() => onPaneChange(pane === 'personas' ? 'list' : 'personas')}
        >
          我的身份
        </button>
        <button
          type="button"
          className={pane === 'worldbooks' ? 'ghost active' : 'ghost'}
          disabled={disabled}
          onClick={() => onPaneChange(pane === 'worldbooks' ? 'list' : 'worldbooks')}
        >
          查看已有世界书
        </button>
        <button
          type="button"
          className={pane === 'cards' ? 'ghost active' : 'ghost'}
          disabled={disabled}
          onClick={() => onPaneChange(pane === 'cards' ? 'list' : 'cards')}
        >
          查看已有角色卡
        </button>
        <button
          type="button"
          className="ghost"
          disabled={disabled}
          title="走副对话，由 AI 帮忙起草"
          onClick={onCreateWithAi}
        >
          创建
        </button>
        <button
          type="button"
          className="ghost"
          disabled={disabled}
          title="导入角色卡（PNG / JSON）或世界书（JSON）"
          onClick={() => fileRef.current?.click()}
        >
          导入素材
        </button>
      </div>

      <div className="rail-body">
        {pane === 'list' ? (
          list
        ) : (
          <>
            <header className="rail-panel-head">
              <strong>{active?.label}</strong>
              <span className="hint">{active?.hint}</span>
              <button type="button" className="ghost" onClick={() => onPaneChange('list')}>
                返回列表
              </button>
            </header>
            {panel}
          </>
        )}
      </div>

      <footer className="rail-foot">
        {/*
          底部两个按钮：左边 1/4 是「个人账户」（同步空间与身份），右边 3/4 是「设置」。
          账号是常看的东西（换设备、给朋友 id、抄恢复码），不该埋在设置的二级页里。
        */}
        <button type="button" className="ghost account-button" disabled={disabled} onClick={onOpenAccount}>
          账户
        </button>
        <button type="button" className="ghost" disabled={disabled} onClick={onOpenSettings}>
          设置
        </button>
      </footer>
    </aside>
  );
}

/**
 * memo（顺序 59）。它的 `list` / `panel` 是 App 每次渲染新造的 JSX，所以 App 重渲染时它还是会跟着；
 * 收益同 RuntimePanel：流式与打字那两条路已经不经过 App。拆 App（顺序 66）时再把两块内容做成子组件。
 */
export const LeftRail = memo(LeftRailImpl);
