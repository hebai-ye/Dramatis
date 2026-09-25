import { type Card, type CardId, createBlankCard, resolveCardSystemPrompt } from '@dramatis/core';
import { useEffect, useState } from 'react';

interface Props {
  cards: Card[];
  disabled: boolean;
  onSave: (card: Card) => void;
  onDelete: (id: CardId) => void;
}

function ListEditor({
  values,
  onChange,
  disabled,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  return (
    <div className="list-editor">
      {values.map((value, index) => (
        <div className="inline" key={`${String(index)}-${value.slice(0, 8)}`}>
          <textarea
            rows={2}
            value={value}
            disabled={disabled}
            onChange={(event) => {
              const next = [...values];
              next[index] = event.target.value;
              onChange(next);
            }}
          />
          <button
            type="button"
            className="ghost danger"
            disabled={disabled}
            onClick={() => onChange(values.filter((_, position) => position !== index))}
          >
            删
          </button>
        </div>
      ))}
      <button type="button" className="ghost" disabled={disabled} onClick={() => onChange([...values, ''])}>
        ＋ 添加一条
      </button>
    </div>
  );
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
  const [showAdvanced, setShowAdvanced] = useState(false);

  const selected = cards.find((card) => card.id === selectedId) ?? null;

  // 换卡或外部更新时同步草稿，但不要覆盖正在编辑的内容
  useEffect(() => {
    if (!selected) {
      setDraft(null);
      return;
    }
    setDraft((previous) =>
      previous?.id === selected.id
        ? previous
        : { ...selected, systemPrompt: resolveCardSystemPrompt(selected.systemPrompt) },
    );
  }, [selected]);

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

          <label>
            场景设定
            <textarea
              rows={3}
              value={draft.scenario}
              disabled={disabled}
              placeholder="开新世界时会填进场景"
              onChange={(event) => patch({ scenario: event.target.value })}
              onBlur={commit}
            />
          </label>

          <label>
            开场白
            <textarea
              rows={3}
              value={draft.firstMessage}
              disabled={disabled}
              onChange={(event) => patch({ firstMessage: event.target.value })}
              onBlur={commit}
            />
          </label>

          <div>
            <p className="hint">备选开场白（每次开新世界会随机遇到不同的开场）</p>
            <ListEditor
              values={draft.alternateGreetings}
              disabled={disabled}
              onChange={(next) => {
                // 列表的增删是离散操作，直接落盘；
                // patch 之后再 commit 会读到旧草稿，所以这里显式传新值
                const updated = { ...draft, alternateGreetings: next };
                setDraft(updated);
                onSave(updated);
              }}
            />
          </div>

          <button type="button" className="ghost" onClick={() => setShowAdvanced((value) => !value)}>
            {showAdvanced ? '收起高级字段' : '展开高级字段'}
          </button>

          {showAdvanced ? (
            <>
              <label>
                对话示例
                <textarea
                  rows={4}
                  value={draft.exampleMessages}
                  disabled={disabled}
                  placeholder="用来固定说话方式的样例对话"
                  onChange={(event) => patch({ exampleMessages: event.target.value })}
                  onBlur={commit}
                />
              </label>
              <label>
                系统提示（覆盖默认规则）
                <textarea
                  rows={3}
                  value={draft.systemPrompt}
                  disabled={disabled}
                  onChange={(event) => patch({ systemPrompt: event.target.value })}
                  onBlur={commit}
                />
              </label>
              <label>
                后置指令
                <textarea
                  rows={2}
                  value={draft.postHistoryInstructions}
                  disabled={disabled}
                  onChange={(event) => patch({ postHistoryInstructions: event.target.value })}
                  onBlur={commit}
                />
              </label>
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
            </>
          ) : null}

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
