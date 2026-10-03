import { memo, type ReactNode, useRef } from 'react';
import { LIBRARY_SURFACE_ID, LIBRARY_VIEWS, useLibraryView } from '../lib/library-view';
import { countRender } from '../lib/render-count';

interface Props {
  counts: Record<'personas' | 'cards' | 'worldbooks', number>;
  /** 顶层入口：创建新世界，并在其中开启首条对话。 */
  onNewConversation: () => void;
  /** 「创建」走副对话，由 AI 帮忙起草，用户决定去留。 */
  onCreateWithAi: () => void;
  /** 导入角色卡或世界书（按 JSON 结构自动分辨）。 */
  onImportFile: (file: File) => void;
  /** 打开设置弹窗。 */
  onOpenSettings: () => void;
  /** 打开独立账户弹窗（数据容器与多设备同步）。 */
  onOpenAccount: () => void;
  disabled: boolean;
  /** 世界与对话列表。 */
  list: ReactNode;
}

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
  counts,
  onNewConversation,
  onCreateWithAi,
  onImportFile,
  onOpenSettings,
  onOpenAccount,
  disabled,
  list,
}: Props) {
  countRender('LeftRail');
  const library = useLibraryView();
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
        {LIBRARY_VIEWS.map((view) => (
          <button
            key={view.id}
            type="button"
            className={library.activeView === view.id ? 'ghost active' : 'ghost'}
            data-library-trigger={view.id}
            aria-expanded={library.activeView === view.id}
            aria-pressed={library.activeView === view.id}
            aria-controls={LIBRARY_SURFACE_ID}
            title={view.hint}
            onClick={() => void library.toggle(view.id)}
          >
            {view.id === 'personas' ? view.label : `查看已有${view.label}`}
            <span className="library-count">{counts[view.id]}</span>
          </button>
        ))}
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

      <div className="rail-body">{list}</div>

      <footer className="rail-foot">
        {/*
          底部两个按钮分别打开账户与设置，布局沿用已有比例。
          账号是常看的东西（换设备、给朋友 id、抄恢复码），不该埋在设置的二级页里。
        */}
        <button
          type="button"
          className="ghost account-button"
          data-dialog-trigger="account"
          disabled={disabled}
          onClick={onOpenAccount}
        >
          账户
        </button>
        <button
          type="button"
          className="ghost"
          data-dialog-trigger="settings"
          disabled={disabled}
          onClick={onOpenSettings}
        >
          设置
        </button>
      </footer>
    </aside>
  );
}

/** 世界与对话列表始终保留；素材开关只消费局部视图状态。 */
export const LeftRail = memo(LeftRailImpl);
