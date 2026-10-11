import type { ImportRecoveryWarning } from '../lib/session';

export function ImportRecoveryNotice({
  recoveredImports,
  warnings,
}: {
  recoveredImports: number;
  warnings: readonly ImportRecoveryWarning[];
}) {
  if (recoveredImports === 0 && warnings.length === 0) return null;
  const messages = [...new Set(warnings.map((warning) => warning.message))];
  return (
    <aside
      role="status"
      aria-label="导入恢复检查"
      style={{ padding: '0.75rem 1rem', flexShrink: 0, overflowWrap: 'anywhere', maxHeight: '30vh', overflowY: 'auto' }}
    >
      {recoveredImports > 0 ? <p style={{ margin: 0 }}>已撤掉 {recoveredImports} 个未完成导入的世界。</p> : null}
      {messages.length > 0 ? (
        <>
          <strong>导入恢复检查需要处理</strong>
          {messages.map((message) => (
            <p key={message} style={{ margin: '0.25rem 0 0' }}>
              {message}
            </p>
          ))}
        </>
      ) : null}
    </aside>
  );
}
