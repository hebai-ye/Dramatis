import type { Conversation, ConversationId } from '@dramatis/core';
import type { AppearanceApi } from '../lib/appearance';
import type { ProvidersApi } from '../lib/providers';
import type { StorageApi } from '../lib/storage';
import { useDialogActions } from './DialogShell';
import { IconArchive, IconDatabase, IconSettings, IconSliders } from './Icons';
import { LazyPanel } from './LazyPanel';

export type SettingsCategory = 'model' | 'appearance' | 'data' | 'archive';

export const SETTINGS_CATEGORY_LABELS: Record<SettingsCategory, string> = {
  model: '模型配置',
  appearance: '外观与显示',
  data: '数据与备份',
  archive: '已归档对话',
};

const CATEGORIES: { id: SettingsCategory; hint: string; icon: typeof IconSettings }[] = [
  { id: 'model', hint: '接口地址、模型名与 Key', icon: IconSettings },
  { id: 'appearance', hint: '色调、背景与对话显示', icon: IconSliders },
  { id: 'data', hint: '封存导入导出与本机浏览器存储', icon: IconDatabase },
  { id: 'archive', hint: '回顾、导出与删除归档对话', icon: IconArchive },
];

const loadProviderPanel = () => import('./ProviderPanel').then((module) => ({ default: module.ProviderPanel }));
const loadAppearancePanel = () => import('./AppearancePanel').then((module) => ({ default: module.AppearancePanel }));
const loadDataPanel = () => import('./DataSettingsPanel').then((module) => ({ default: module.DataSettingsPanel }));
const loadArchivePanel = () =>
  import('./ArchivedConversationsPanel').then((module) => ({ default: module.ArchivedConversationsPanel }));

interface Props {
  category: SettingsCategory;
  onCategoryChange: (category: SettingsCategory) => void;
  providers: ProvidersApi;
  appearance: AppearanceApi;
  archivedConversations: Conversation[];
  activeConversationId: ConversationId | null;
  disabled: boolean;
  onOpenArchived: (id: ConversationId) => void;
  onDeleteArchived: (conversation: Conversation) => Promise<{ ok: boolean; message: string }>;
  onExportArchive: () => Promise<{ ok: boolean; message: string } | null>;
  onImportArchive: () => Promise<{ ok: boolean; message: string } | null>;
  onExportTranscript: (id: ConversationId) => Promise<{ ok: boolean; message: string } | null>;
  storage: StorageApi;
  backendKind: string;
}

/** Lightweight settings content; DialogShell owns closing, focus and leaving confirmation. */
export function SettingsDialog(props: Props) {
  const { requestAction } = useDialogActions();
  return (
    <div className="settings-body">
      <nav className="settings-nav" aria-label="设置分类">
        {CATEGORIES.map(({ id, hint, icon: CategoryIcon }) => (
          <button
            key={id}
            type="button"
            className={id === props.category ? 'ghost active' : 'ghost'}
            aria-current={id === props.category ? 'page' : undefined}
            onClick={() => {
              if (id !== props.category) requestAction(() => props.onCategoryChange(id));
            }}
          >
            <strong>
              <CategoryIcon />
              {SETTINGS_CATEGORY_LABELS[id]}
            </strong>
            <span className="hint">{hint}</span>
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {props.category === 'model' ? (
          <LazyPanel
            key="model"
            load={loadProviderPanel}
            label="模型配置"
            panelProps={{ api: props.providers, disabled: props.disabled }}
          />
        ) : null}
        {props.category === 'appearance' ? (
          <LazyPanel
            key="appearance"
            load={loadAppearancePanel}
            label="外观与显示"
            panelProps={{ api: props.appearance, disabled: props.disabled }}
          />
        ) : null}
        {props.category === 'data' ? (
          <LazyPanel
            key="data"
            load={loadDataPanel}
            label="数据与备份"
            panelProps={{
              activeConversationId: props.activeConversationId,
              disabled: props.disabled,
              onExportArchive: props.onExportArchive,
              onImportArchive: props.onImportArchive,
              storage: props.storage,
              backendKind: props.backendKind,
            }}
          />
        ) : null}
        {props.category === 'archive' ? (
          <LazyPanel
            key="archive"
            load={loadArchivePanel}
            label="已归档对话"
            panelProps={{
              archivedConversations: props.archivedConversations,
              activeConversationId: props.activeConversationId,
              disabled: props.disabled,
              onOpenArchived: props.onOpenArchived,
              onDeleteArchived: props.onDeleteArchived,
              onExportTranscript: props.onExportTranscript,
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
