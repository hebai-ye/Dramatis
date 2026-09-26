import type { Card, CharacterInstance, InstanceId, Scene } from '@dramatis/core';
import { memo } from 'react';
import { countRender } from '../lib/render-count';
import { avatarOf } from '../lib/portraits';
import { Avatar } from './MessageBody';

interface Props {
  instances: CharacterInstance[];
  scene: Scene | null;
  cards: Card[];
  disabled: boolean;
  onOpenDetail: (id: InstanceId) => void;
  /** 素材库里还没进入这个世界的卡。 */
  availableCards: Card[];
  onAddInstance: (card: Card) => void;
}

/**
 * 右缘窄栏（LAYOUT「右缘窄栏」）。
 *
 * 规格特别强调「这一栏是真实存在的，不是草稿纸格线」：
 * - 显示各角色
 * - 把角色从这里**拖进对话**，角色进入当前场景
 * - 在这里打开角色，显示角色详细信息
 *
 * 拖拽比按钮更贴合「把角色拉进来」这个动作，所以加入场景走拖拽；
 * 不在场景里的人显示成暗的，让人一眼看出谁还没上台。
 */
function CastRailImpl({ instances, scene, cards, disabled, onOpenDetail, availableCards, onAddInstance }: Props) {
  countRender('CastRail');
  const cardName = (instance: CharacterInstance): string =>
    cards.find((card) => card.id === instance.cardId)?.name ?? instance.displayName;

  return (
    <aside className="cast-rail">
      <span className="rail-caption">角色</span>

      <div className="cast-rail-list">
        {instances.map((instance) => {
          const onstage = scene === null ? false : scene.cast.includes(instance.id);
          return (
            <button
              type="button"
              key={instance.id}
              className={onstage ? 'cast-card onstage' : 'cast-card'}
              draggable={!disabled}
              disabled={disabled}
              title={`${instance.displayName}（${cardName(instance)}）——拖进对话即可入场`}
              onClick={() => onOpenDetail(instance.id)}
              onDragStart={(event) => {
                event.dataTransfer.setData('text/dramatis-instance', instance.id);
                event.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <Avatar name={instance.displayName} size={30} avatar={avatarOf(cards.find((card) => card.id === instance.cardId))} />
              <span className="cast-card-name">{instance.displayName}</span>
              <span className="cast-card-state">{onstage ? '在场' : '在场外'}</span>
            </button>
          );
        })}
      </div>

      {availableCards.length > 0 ? (
        <div className="cast-rail-extra">
          <span className="rail-caption">未加入</span>
          {availableCards.map((card) => (
            <button
              type="button"
              key={card.id}
              className="cast-card dim"
              disabled={disabled}
              title={`把「${card.name}」拉进这个世界`}
              onClick={() => onAddInstance(card)}
            >
              <Avatar name={card.name} size={30} avatar={avatarOf(card)} />
              <span className="cast-card-name">{card.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

/** memo（顺序 59）：名单、场景、卡都没变时整块跳过。 */
export const CastRail = memo(CastRailImpl);
