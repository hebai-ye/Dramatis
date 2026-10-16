import type { AdminArtifact } from '@dramatis/core';
import { DialogShell } from './DialogShell';

const LABELS: Record<string, string> = {
  name: '名称',
  nickname: '自称',
  description: '设定',
  personality: '性格',
  tags: '标签',
  entries: '词条',
  title: '标题',
  keys: '关键词',
  content: '内容',
  constant: '常驻',
  order: '顺序',
  location: '地点',
  worldTime: '时间',
  summary: '场景设定',
};
function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '—';
  return JSON.stringify(value, null, 2);
}
export function AdminDraftPreview({
  artifact,
  sourceLabel,
  onClose,
  returnFocus,
}: {
  artifact: AdminArtifact;
  sourceLabel: string;
  onClose: () => void;
  returnFocus: HTMLElement | null;
}) {
  const payload =
    artifact.payload && typeof artifact.payload === 'object' ? (artifact.payload as Record<string, unknown>) : {};
  return (
    <DialogShell
      label={`草稿预览：${artifact.title}`}
      className="admin-draft-preview"
      appearance="modal"
      onClose={onClose}
      returnFocus={returnFocus}
      head={
        <div>
          <strong>{artifact.title}</strong>
          <p className="hint">{sourceLabel} · 只读草稿</p>
        </div>
      }
    >
      <dl>
        {Object.entries(payload)
          .filter(([key]) => key in LABELS)
          .map(([key, value]) => (
            <div key={key}>
              <dt>{LABELS[key]}</dt>
              <dd>
                <pre>{valueText(value)}</pre>
              </dd>
            </div>
          ))}
      </dl>
      <details>
        <summary>全部草稿字段</summary>
        <pre>{valueText(payload)}</pre>
      </details>
    </DialogShell>
  );
}
