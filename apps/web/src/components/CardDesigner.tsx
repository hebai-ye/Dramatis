import { type Card, type CardId, createBlankCard } from '@dramatis/core';
import { useEffect, useRef, useState } from 'react';
import { avatarOf, PORTRAITS, portraitOf } from '../lib/portraits';
import { AvatarCropper } from './AvatarCropper';
import { Avatar } from './MessageBody';

interface Props {
  cards: Card[];
  disabled: boolean;
  onSave: (card: Card) => void;
  onDelete: (id: CardId) => void;
}

/**
 * 角色卡设计器（侧边栏的设定功能）。
 *
 * 编辑的是模板层：改这里只影响卡本身，不会动已有角色实例的记忆与关系。
 * 这是 Card / Instance 分离的直接结果——卡可以迭代，世界线不受影响。
 *
 * 提交策略：字段改动先进本地草稿，失焦时才落盘。逐字写库既不必要，
 * 也容易在快速输入时产生抖动。
 */
export function CardDesigner({ cards, disabled, onSave, onDelete }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Card | null>(null);
  const [showPortraits, setShowPortraits] = useState(false);
  const [cropSource, setCropSource] = useState<File | string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const imageInput = useRef<HTMLInputElement | null>(null);

  const selected = cards.find((card) => card.id === selectedId) ?? null;

  // 换卡或外部更新时同步草稿，但不要覆盖正在编辑的内容
  useEffect(() => {
    if (!selected) {
      setDraft(null);
      return;
    }
    setDraft((previous) => (previous?.id === selected.id ? previous : { ...selected }));
  }, [selected]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedId 是触发器——换一张卡就把上一张的裁切草稿与错误清掉，代码里不需要读它的值
  useEffect(() => {
    setCropSource(null);
    setImageError(null);
  }, [selectedId]);

  const patch = (changes: Partial<Card>): void => {
    setDraft((previous) => (previous ? { ...previous, ...changes } : previous));
  };

  const commit = (): void => {
    if (draft) onSave(draft);
  };

  const createCard = (): void => {
    const blank = createBlankCard();
    onSave(blank);
    setSelectedId(blank.id);
    setDraft(blank);
  };

  return (
    <div className="stack">
      <div className="inline">
        <select
          value={selectedId ?? ''}
          disabled={disabled}
          onChange={(event) => setSelectedId(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">选择一张卡…</option>
          {cards.map((card) => (
            <option key={card.id} value={card.id}>
              {card.name}
              {card.source.kind === 'manual' ? '（手写）' : ''}
            </option>
          ))}
        </select>
        <button type="button" className="ghost" disabled={disabled} onClick={createCard}>
          ＋ 新建
        </button>
      </div>

      {draft === null ? (
        <p className="hint">这里写的是角色卡模板。改卡不会影响已经在跑的对话——角色实例有自己的记忆与关系。</p>
      ) : (
        <>
          <div className="grid-2">
            <label>
              名字
              <input
                type="text"
                value={draft.name}
                disabled={disabled}
                onChange={(event) => patch({ name: event.target.value })}
                onBlur={commit}
              />
            </label>
            <label>
              昵称（玩家怎么称呼他）
              <input
                type="text"
                value={draft.nickname}
                disabled={disabled}
                onChange={(event) => patch({ nickname: event.target.value })}
                onBlur={commit}
              />
            </label>
          </div>

          <label>
            描述
            <textarea
              rows={4}
              value={draft.description}
              disabled={disabled}
              placeholder="外貌、身份、背景"
              onChange={(event) => patch({ description: event.target.value })}
              onBlur={commit}
            />
          </label>

          <section className="portrait-picker">
            <div className="portrait-picker-heading">
              <div>
                <strong>角色立绘</strong>
                <p className="hint">可选内置立绘，或上传自己的角色图并裁切对话头像。</p>
              </div>
              <button type="button" className="ghost" onClick={() => setShowPortraits((value) => !value)}>
                {showPortraits ? '收起图库' : '浏览图库'}
              </button>
            </div>
            {portraitOf(draft) ? (
              <div className="portrait-selected">
                <img src={portraitOf(draft) ?? ''} alt={`${draft.name}的立绘`} />
                <div className="portrait-avatar-preview">
                  <Avatar name={draft.name} size={64} avatar={avatarOf(draft)} />
                  <span className="hint">对话头像</span>
                </div>
                <button
                  type="button"
                  className="ghost"
                  disabled={disabled}
                  onClick={() => {
                    const {
                      dramatisPortrait: _bundled,
                      dramatisCustomPortrait: _custom,
                      dramatisCustomAvatar: _avatar,
                      ...extensions
                    } = draft.extensions;
                    const updated = { ...draft, extensions };
                    setDraft(updated);
                    onSave(updated);
                  }}
                >
                  移除立绘
                </button>
              </div>
            ) : null}
            <input
              ref={imageInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
                  setImageError('请选择 PNG、JPEG 或 WebP 图片。');
                  return;
                }
                if (file.size > 12 * 1024 * 1024) {
                  setImageError('图片不能超过 12 MB。');
                  return;
                }
                setImageError(null);
                setCropSource(file);
              }}
            />
            <div className="inline">
              <button type="button" className="ghost" disabled={disabled} onClick={() => imageInput.current?.click()}>
                上传角色图
              </button>
              {typeof draft.extensions.dramatisCustomPortrait === 'string' ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={disabled}
                  onClick={() => setCropSource(draft.extensions.dramatisCustomPortrait as string)}
                >
                  重新选取头像
                </button>
              ) : null}
            </div>
            {imageError ? <p className="notice error">{imageError}</p> : null}
            {cropSource ? (
              <AvatarCropper
                source={cropSource}
                disabled={disabled}
                onCancel={() => setCropSource(null)}
                onConfirm={(portrait, avatar) => {
                  const {
                    dramatisPortrait: _bundled,
                    dramatisCustomPortrait: _oldPortrait,
                    dramatisCustomAvatar: _oldAvatar,
                    ...extensions
                  } = draft.extensions;
                  const updated = {
                    ...draft,
                    extensions: { ...extensions, dramatisCustomPortrait: portrait, dramatisCustomAvatar: avatar },
                  };
                  setDraft(updated);
                  onSave(updated);
                  setCropSource(null);
                }}
              />
            ) : null}
            {showPortraits ? (
              <section className="portrait-grid" aria-label="可选角色立绘">
                {PORTRAITS.map((portrait) => (
                  <button
                    type="button"
                    key={portrait.src}
                    className={portraitOf(draft) === portrait.src ? 'portrait-tile selected' : 'portrait-tile'}
                    disabled={disabled}
                    title={`${String(portrait.number).padStart(2, '0')} · ${portrait.name}（${portrait.namingStyle}）`}
                    onClick={() => {
                      const {
                        dramatisCustomPortrait: _custom,
                        dramatisCustomAvatar: _avatar,
                        ...extensions
                      } = draft.extensions;
                      const updated = {
                        ...draft,
                        extensions: { ...extensions, dramatisPortrait: portrait.src },
                      };
                      setDraft(updated);
                      onSave(updated);
                      setCropSource(null);
                    }}
                  >
                    <img src={portrait.thumbnail} alt="" loading="lazy" />
                    <span>
                      {String(portrait.number).padStart(2, '0')} · {portrait.name}
                    </span>
                  </button>
                ))}
              </section>
            ) : null}
          </section>

          <label>
            性格
            <textarea
              rows={3}
              value={draft.personality}
              disabled={disabled}
              placeholder="说话方式、价值观、忌讳"
              onChange={(event) => patch({ personality: event.target.value })}
              onBlur={commit}
            />
          </label>

          {/*
            顺序 90：场景设定、开场白、备选开场白、对话示例、系统提示与后置指令都被删了
            （用户裁定「彻底删除已有数据」）。下面这些是卡上还剩的元信息——它们不再藏在
            「展开高级字段」后面：能被编辑的字段本来就都该看得见。
          */}
          <div className="grid-2">
            <label>
              作者
              <input
                type="text"
                value={draft.creator}
                disabled={disabled}
                onChange={(event) => patch({ creator: event.target.value })}
                onBlur={commit}
              />
            </label>
            <label>
              版本
              <input
                type="text"
                value={draft.characterVersion}
                disabled={disabled}
                onChange={(event) => patch({ characterVersion: event.target.value })}
                onBlur={commit}
              />
            </label>
          </div>
          <label>
            标签（用逗号分隔）
            <input
              type="text"
              value={draft.tags.join('、')}
              disabled={disabled}
              onChange={(event) =>
                patch({
                  tags: event.target.value
                    .split(/[,，、]/)
                    .map((tag) => tag.trim())
                    .filter((tag) => tag !== ''),
                })
              }
              onBlur={commit}
            />
          </label>
          <p className="hint">
            来源：{draft.source.spec}
            {draft.source.specVersion !== '' ? ` v${draft.source.specVersion}` : ''}
          </p>

          <div className="inline">
            <button type="button" disabled={disabled} onClick={commit}>
              保存
            </button>
            <button
              type="button"
              className="ghost danger"
              disabled={disabled}
              title="只从素材库移除；已经用到这张卡的角色实例不受影响"
              onClick={() => {
                if (window.confirm(`从素材库删除「${draft.name}」？已经建立的角色实例不受影响。`)) {
                  onDelete(draft.id);
                  setSelectedId(null);
                  setDraft(null);
                }
              }}
            >
              删除卡
            </button>
          </div>
        </>
      )}
    </div>
  );
}
