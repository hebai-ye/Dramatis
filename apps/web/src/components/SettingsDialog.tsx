import type { Conversation, ConversationId, Persona } from '@dramatis/core';
import { useState } from 'react';
import type { AppearanceApi } from '../lib/appearance';
import type { ProvidersApi } from '../lib/providers';
import type { StorageApi } from '../lib/storage';
import { formatBytes } from '../lib/storage';
import type { SyncApi } from '../lib/sync';
import { AppearancePanel } from './AppearancePanel';
import { PersonaLibrary } from './PersonaLibrary';
import { ProviderPanel } from './ProviderPanel';
import { SyncPanel } from './SyncPanel';

/**
 * 设置弹窗（用户要求：点「设置」弹窗，里面分几个大类）。
 *
 * 原来是「左栏切成设置页」——那样设置与素材管理在同一根轴线上，用户得先切回来
 * 才能看世界列表；而设置本身有六个大类，挤在一列里要滚很久。现在是一层弹窗 +
 * 左侧分类：模型配置 / 个性化 / 身份 / 同步 / 数据 / 已归档。
 *
 * 弹窗不自己存任何状态：所有内容都是现成的面板（ProviderPanel / AppearancePanel /
 * SyncPanel / …），它们各自读写自己的那一份配置。
 */

export type SettingsCategory = 'model' | 'appearance' | 'account' | 'data' | 'archive';

const CATEGORIES: { id: SettingsCategory; label: string; hint: string }[] = [
  { id: 'model', label: '模型配置', hint: '接口地址、模型名、Key' },
  { id: 'appearance', label: '个性化', hint: '色调、对话区背景、显示' },
  { id: 'account', label: '账户', hint: '我是谁、多设备同步' },
  { id: 'data', label: '数据', hint: '封存导出 / 本机存储' },
  { id: 'archive', label: '已归档', hint: '归档过的对话' },
];

export const SETTINGS_CATEGORY_LABELS: Record<SettingsCategory, string> = {
  model: '模型配置',
  appearance: '个性化',
  account: '账户',
  data: '数据',
  archive: '已归档',
};

interface Props {
  category: SettingsCategory;
  onCategoryChange: (category: SettingsCategory) => void;
  onClose: () => void;
  providers: ProvidersApi;
  appearance: AppearanceApi;
  personas: Persona[];
  activePersonaId: string | null;
  archivedConversations: Conversation[];
  activeConversationId: ConversationId | null;
  disabled: boolean;
  onSelectPersona: (persona: Persona) => void;
  onSavePersona: (persona: Persona) => void;
  onDeletePersona: (id: string) => void;
  onOpenArchived: (id: ConversationId) => void;
  onDeleteArchived: (conversation: Conversation) => void;
  onExportArchive: () => Promise<{ ok: boolean; message: string } | null>;
  onImportArchive: () => Promise<{ ok: boolean; message: string } | null>;
  onExportTranscript: (id: ConversationId) => Promise<{ ok: boolean; message: string } | null>;
  storage: StorageApi;
  backendKind: string;
  sync: SyncApi;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function SettingsDialog(props: Props) {
  const { category, onCategoryChange, onClose } = props;
  const [archiveNotice, setArchiveNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [persistNotice, setPersistNotice] = useState<string | null>(null);

  const runArchive = async (action: () => Promise<{ ok: boolean; message: string } | null>): Promise<void> => {
    setArchiveBusy(true);
    setArchiveNotice(null);
    try {
      const result = await action();
      if (result !== null) setArchiveNotice(result);
    } catch (error) {
      setArchiveNotice({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setArchiveBusy(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 遮罩点击关闭是弹窗的通用约定，键盘路径是 Esc 与「关闭」
    <div
      className="dialog-backdrop"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 同上；点击在这里只用于阻止冒泡 */}
      <section
        className="dialog settings-dialog"
        role="dialog"
        aria-label="设置"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <strong>设置</strong>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-nav">
            {CATEGORIES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === category ? 'ghost active' : 'ghost'}
                onClick={() => onCategoryChange(item.id)}
              >
                <strong>{item.label}</strong>
                <span className="hint">{item.hint}</span>
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {category === 'model' ? (
              <section className="panel">
                <h2>模型接入</h2>
                <p className="hint">
                  填好接口地址、模型名与 API Key 之后，角色回复、记忆抽取、情绪推演都会自动跑。
                  <strong>不填也能用</strong>：应用会把每一轮要发的提示词交给你，你贴进 DeepSeek
                  网页版，再把回复粘回来——只是每轮多两次复制粘贴。
                </p>
                <ProviderPanel api={props.providers} disabled={props.disabled} />
              </section>
            ) : null}

            {category === 'appearance' ? <AppearancePanel api={props.appearance} disabled={props.disabled} /> : null}

            {/*
              「账户」= 我是谁 + 多设备同步。左栏底部那个「个人账户」按钮直接开这一档：
              用户要找的是「我的账号」，而账号在这套设计里就是同步空间（id + 密码 + 恢复码）。
            */}
            {category === 'account' ? (
              <>
                <section className="panel">
                  <h2>我是谁</h2>
                  <PersonaLibrary
                    personas={props.personas}
                    activeId={props.activePersonaId}
                    disabled={props.disabled}
                    onSelect={props.onSelectPersona}
                    onSave={props.onSavePersona}
                    onDelete={props.onDeletePersona}
                  />
                </section>

                <section className="panel">
                  <h2>多设备同步</h2>
                  <p className="hint">
                    账号就是「同步空间」：用户 id 与密码由你自己定，没有邮箱、没有验证码，也没有找回密码——
                    所以建空间时显示的恢复码要抄下来。服务端只存密文与哈希。
                  </p>
                  <SyncPanel api={props.sync} disabled={props.disabled} />
                </section>
              </>
            ) : null}

            {category === 'data' ? (
              <>
                <section className="panel">
                  <h2>封存（导出 / 导入）</h2>
                  <p className="hint">
                    导出的是一整个世界：对话、场景、角色与角色卡、消息、记忆、情绪关系、前情章节、世界书、账单——一个文件，
                    换台设备导进来就能接着用。导入永远是<strong>新建一条世界线</strong>，不会覆盖或改动本机已有的数据。
                  </p>
                  <div className="save-bar">
                    <button
                      type="button"
                      disabled={props.disabled || archiveBusy || props.activeConversationId === null}
                      onClick={() => void runArchive(props.onExportArchive)}
                    >
                      {archiveBusy ? '处理中…' : '导出这个世界'}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={props.disabled || archiveBusy}
                      onClick={() => void runArchive(props.onImportArchive)}
                    >
                      导入封存
                    </button>
                  </div>
                  {archiveNotice === null ? null : (
                    <div className={archiveNotice.ok ? 'notice' : 'notice error'}>
                      <p>{archiveNotice.message.replace(/\*\*/g, '')}</p>
                    </div>
                  )}
                </section>

                <section className="panel">
                  <h2>本机存储</h2>
                  <ul className="usage-list">
                    <li>
                      <span className="usage-name">存储后端</span>
                      <span className="usage-figure">{props.backendKind || '…'}</span>
                    </li>
                    <li>
                      <span className="usage-name">持久化</span>
                      <span className="usage-figure">
                        {props.storage.status.supported
                          ? props.storage.status.persisted
                            ? '已获得'
                            : '未获得'
                          : '这个浏览器不支持'}
                      </span>
                    </li>
                    <li>
                      <span className="usage-name">已用 / 配额</span>
                      <span className="usage-figure">
                        {props.storage.status.usage === null || props.storage.status.quota === null
                          ? '未知'
                          : `${formatBytes(props.storage.status.usage)} / ${formatBytes(props.storage.status.quota)}`}
                      </span>
                    </li>
                  </ul>
                  <div className="save-bar">
                    <button
                      type="button"
                      disabled={
                        props.disabled || !props.storage.status.supported || props.storage.status.persisted === true
                      }
                      onClick={() => {
                        setPersistNotice(null);
                        void props.storage.requestPersist().then((granted) => {
                          setPersistNotice(
                            granted
                              ? '拿到了 ✓ 浏览器不会再因为磁盘紧张、或你很久没打开，就悄悄清掉这些数据。'
                              : '浏览器这次没给。Chrome 不弹窗，它按「有没有把这个站点装成应用 / 来过几次」自己判断——下一步：装成应用（下面那个按钮），然后再点一次。没拿到也不影响使用，导出封存照样是最后的保险。',
                          );
                        });
                      }}
                    >
                      申请持久化存储
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setPersistNotice(null);
                        void props.storage.installApp().then((outcome) => {
                          setPersistNotice(
                            outcome === 'accepted'
                              ? '安装开始了。装完回到这里再点一次「申请持久化存储」，一般就能拿到。'
                              : outcome === 'dismissed'
                                ? '这次取消了。想装的话，地址栏右边或浏览器菜单里也有「安装应用 / 添加到主屏幕」。'
                                : '这个浏览器现在没给一键安装的口子：看地址栏右边的安装图标，或者浏览器菜单里的「安装应用」「添加到主屏幕」（安卓上叫「添加到主屏幕」）。',
                          );
                        });
                      }}
                    >
                      {props.storage.canInstall ? '装成应用（更容易拿到持久化）' : '怎么装成应用'}
                    </button>
                  </div>
                  {persistNotice === null ? null : <p className="hint">{persistNotice}</p>}
                  <p className="hint">
                    {props.storage.status.persisted === true
                      ? '已经拿到持久化：浏览器不会因为磁盘紧张或你很久没打开就清掉这些数据。'
                      : '没拿到持久化时，浏览器随时可能回收本地数据。Chrome 上拿到它的正路是把这个站点'}
                    {props.storage.status.persisted === true ? null : <strong>装成应用</strong>}
                    {props.storage.status.persisted === true
                      ? null
                      : '（安卓上叫「添加到主屏幕」），装完再点一次申请；应用也会自动申请一次，所以常来同样会慢慢拿到。无论哪种情况，导出封存都是最稳的备份。'}
                  </p>
                </section>
              </>
            ) : null}

            {category === 'archive' ? (
              <section className="panel">
                <h2>已归档的对话</h2>
                <p className="hint">
                  归档意味着这条时间线没有发生过：情绪、关系与记忆都已经回滚到它开始之前。对话本身保留在这里，
                  只用于回顾——<strong>没有「取消归档」</strong>，要接着往下聊得开一条新对话；但你可以把正文导出带走
                  （导出的是当时一句句说了什么，与「封存」那份可再导入的数据文件不是一回事）。
                </p>
                {props.archivedConversations.length === 0 ? (
                  <p className="hint">还没有归档的对话。</p>
                ) : (
                  <ul className="room-list">
                    {props.archivedConversations.map((conversation) => (
                      <li
                        key={conversation.id}
                        className={conversation.id === props.activeConversationId ? 'active' : ''}
                      >
                        <button
                          type="button"
                          className="room-open"
                          disabled={props.disabled}
                          onClick={() => props.onOpenArchived(conversation.id)}
                        >
                          <span className="room-title">{conversation.title}</span>
                          <span className="hint">
                            归档于 {formatTime(conversation.archivedAt ?? conversation.updatedAt)}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          disabled={props.disabled || archiveBusy}
                          title="把这条对话的正文导出成 Markdown 文件"
                          onClick={() => void runArchive(() => props.onExportTranscript(conversation.id))}
                        >
                          导出正文
                        </button>
                        <button
                          type="button"
                          className="ghost danger"
                          disabled={props.disabled}
                          title="彻底删除，不可恢复"
                          onClick={() => {
                            if (window.confirm(`彻底删除已归档的「${conversation.title}」？`))
                              props.onDeleteArchived(conversation);
                          }}
                        >
                          删除
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {archiveNotice === null ? null : (
                  <div className={archiveNotice.ok ? 'notice' : 'notice error'}>
                    <p>{archiveNotice.message.replace(/\*\*/g, '')}</p>
                  </div>
                )}
              </section>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
