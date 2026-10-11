import { diffWorldBook, type WorldBook } from '@dramatis/core';

const labels: Record<string, string> = {
  name: '书名',
  id: '条目 ID',
  title: '标题',
  keys: '主关键词',
  secondaryKeys: '次关键词',
  content: '正文',
  constant: '常驻',
  selective: '启用次关键词筛选',
  selectiveLogic: '次关键词逻辑',
  order: '排序权重',
  position: '插入位置',
  depth: '插入深度',
  probability: '触发概率',
  useProbability: '启用概率',
  disabled: '停用',
  caseSensitive: '区分大小写',
  matchWholeWords: '匹配完整词语',
  scanDepth: '扫描深度',
  preventRecursion: '阻止递归',
  excludeRecursion: '排除递归',
  group: '分组',
  extensions: '扩展属性',
};

function display(value: unknown, formatBoolean = false): string {
  if (typeof value === 'string') return value || '（空）';
  if (formatBoolean && typeof value === 'boolean') return value ? '是' : '否';
  return value == null ? '（无）' : JSON.stringify(value, null, 2);
}

function entryTitle(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const title = (value as Record<string, unknown>).title;
  return typeof title === 'string' && title ? title : undefined;
}

function EntryPreview({ value }: { value: unknown }) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const fields = [
    ['content', '正文'],
    ['keys', '主关键词'],
    ['secondaryKeys', '次关键词'],
  ] as const;
  return (
    <div className="world-book-entry-preview">
      {fields.map(([field, label]) =>
        entry[field] === undefined ? null : (
          <p key={field}>
            <strong>{label}：</strong>
            <span>{display(entry[field])}</span>
          </p>
        ),
      )}
    </div>
  );
}

export function WorldBookDiff({ before, after }: { before: WorldBook | null; after: WorldBook }) {
  const changes = diffWorldBook(before, after);
  const addedIds = new Set(
    changes.filter((change) => change.kind === 'add' && change.entryId).map((change) => change.entryId),
  );
  const deletedIds = new Set(
    changes.filter((change) => change.kind === 'delete' && change.entryId).map((change) => change.entryId),
  );
  const modifiedIds = new Set(
    changes.filter((change) => change.kind === 'field' && change.entryId).map((change) => change.entryId),
  );
  const bookChanges = changes.filter((change) => change.kind === 'field' && !change.entryId);

  return (
    <div className="world-book-diff">
      {changes.length === 0 ? (
        <p className="hint">没有内容变更</p>
      ) : (
        <>
          <p className="hint">
            新增 {addedIds.size} 条 · 修改 {modifiedIds.size} 条 · 删除 {deletedIds.size} 条
            {bookChanges.length > 0 ? ` · 书级变化 ${bookChanges.length} 项` : ''}
          </p>
          {changes.map((change) => {
            const entry =
              change.kind === 'add'
                ? change.after
                : change.kind === 'delete'
                  ? change.before
                  : (after.entries.find((item) => item.id === change.entryId) ??
                    before?.entries.find((item) => item.id === change.entryId));
            const title = entryTitle(entry);
            const isEntryObjectChange = change.kind === 'add' || change.kind === 'delete';
            return (
              <details key={`${change.kind}:${change.entryId ?? 'book'}:${change.field ?? ''}`}>
                <summary>
                  {change.kind === 'add' ? '新增条目' : change.kind === 'delete' ? '明确删除条目' : '修改'}
                  {title ? `「${title}」` : ''}
                  {change.field ? ` · ${change.entryId ? '' : '世界书 · '}${labels[change.field] ?? change.field}` : ''}
                </summary>
                {change.entryId ? <p className="hint">条目 ID：{change.entryId}</p> : null}
                {isEntryObjectChange ? (
                  <>
                    <EntryPreview value={entry} />
                    <details>
                      <summary>查看完整条目 JSON</summary>
                      <pre>{display(change.kind === 'add' ? change.after : change.before)}</pre>
                    </details>
                  </>
                ) : (
                  <>
                    <div>
                      <strong>原内容</strong>
                      <pre>{display(change.before, true)}</pre>
                    </div>
                    <div>
                      <strong>新内容</strong>
                      <pre>{display(change.after, true)}</pre>
                    </div>
                  </>
                )}
              </details>
            );
          })}
        </>
      )}
    </div>
  );
}
