import type { DraftField } from '../lib/useDraftField';

const STATUS_LABEL = { pending: '待保存', saving: '保存中…', saved: '已保存', error: '保存未完成' } as const;

export function DraftSaveFeedback({ field, label }: { field: DraftField; label: string }) {
  return (
    <div className="edit-save-feedback">
      <p className={field.error ? 'hint error' : 'hint'} role={field.error ? 'alert' : 'status'}>
        {label} · {STATUS_LABEL[field.status]}
        {field.error ? `：${field.error}。草稿已保留。` : ''}
      </p>
      {field.error ? (
        <button type="button" className="ghost" onClick={() => void field.flush()}>
          重试保存
        </button>
      ) : null}
    </div>
  );
}
