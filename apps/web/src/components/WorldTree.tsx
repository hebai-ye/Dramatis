import type { Conversation, ConversationId, RoomId, RoomSummary } from '@dramatis/core';

interface Props {
  worlds: RoomSummary[];
  activeWorldId: RoomId | null;
  /** 当前世界的对话；已归档的不在这里，改从设置里打开。 */
  conversations: Conversation[];
  activeConversationId: ConversationId | null;
  disabled: boolean;
  onOpenWorld: (id: RoomId) => void;
  onOpenConversation: (id: ConversationId) => void;
  onArchiveConversation: (conversation: Conversation) => void;
  onDeleteConversation: (conversation: Conversation) => void;
  onDeleteWorld: (id: RoomId) => void;
}

/**
 * 世界与对话列表（LAYOUT「左栏 · 中间」）。
 *
 * 层级是**世界 = 项目，一个世界下可以开多个对话**。角色、世界书、身份挂在
 * 世界上（跨对话共用），场景与消息挂在对话上。
 *
 * 归档的入口放在每条对话上：归档的含义是「这条时间线没有发生过」，
 * 所以它必须离那条对话足够近，用户才不会误以为是在删世界。
 */
export function WorldTree({
  worlds,
  activeWorldId,
  conversations,
  activeConversationId,
  disabled,
  onOpenWorld,
  onOpenConversation,
  onArchiveConversation,
  onDeleteConversation,
  onDeleteWorld,
}: Props) {
  if (worlds.length === 0) {
    return (
      <div className="rail-empty">
        <p className="hint">还没有世界。</p>
        <p className="hint">导入一张角色卡，或者点上面的「新对话」开始。</p>
      </div>
    );
  }

  return (
    <ul className="world-list">
      {worlds.map((world) => {
        const isActive = world.id === activeWorldId;
        const mainCount = isActive
          ? conversations.filter((item) => item.kind === 'main').length
          : world.conversationCount;

        return (
          <li key={world.id} className={isActive ? 'world active' : 'world'}>
            <div className="world-row">
              <button
                type="button"
                className="world-open"
                disabled={disabled}
                title={`${String(world.messageCount)} 条消息 · ${String(world.instanceCount)} 名角色`}
                onClick={() => onOpenWorld(world.id)}
              >
                <span className="world-title">{world.title}</span>
                <span className="hint">
                  {String(mainCount)} 条对话 · {String(world.instanceCount)} 名角色
                </span>
              </button>
              <button
                type="button"
                className="ghost danger"
                disabled={disabled}
                title="删除这个世界（素材库里的角色卡与世界书会保留）"
                onClick={() => {
                  if (window.confirm(`确定删除「${world.title}」？全部对话、角色状态与记忆都会被清空。`)) {
                    onDeleteWorld(world.id);
                  }
                }}
              >
                ✕
              </button>
            </div>

            {isActive ? (
              <ul className="conversation-list">
                {conversations.length === 0 ? <li className="hint">这个世界还没有对话</li> : null}
                {conversations.map((conversation) => (
                  <li key={conversation.id} className={conversation.id === activeConversationId ? 'active' : ''}>
                    <button
                      type="button"
                      className="conversation-open"
                      disabled={disabled}
                      onClick={() => onOpenConversation(conversation.id)}
                    >
                      <span>
                        {conversation.kind === 'side' ? '⚙ ' : ''}
                        {conversation.title}
                      </span>
                      <span className="tag">{conversation.kind === 'side' ? '副对话' : '主对话'}</span>
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={disabled}
                      title="归档：把情绪、关系、记忆回滚到这条对话开始之前，对话本身保留"
                      onClick={() => onArchiveConversation(conversation)}
                    >
                      归档
                    </button>
                    <button
                      type="button"
                      className="ghost danger"
                      disabled={disabled}
                      title="彻底删除这条对话（不可恢复）"
                      onClick={() => {
                        if (window.confirm(`彻底删除「${conversation.title}」？消息与记忆都会一起消失。`)) {
                          onDeleteConversation(conversation);
                        }
                      }}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
