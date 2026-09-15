import type { AssembledPrompt } from '@dramatis/core';

interface Props {
  prompt: AssembledPrompt | null;
}

const STAGE_LABELS: Record<string, string> = {
  'drop-history': '丢弃了最旧的历史',
  'drop-memory': '丢弃了低分记忆',
  'compress-relationship': '压缩了关系描述',
  'compress-persona': '压缩了人设描述',
  'drop-lowest-priority': '兜底丢弃（预算严重不足）',
};

/** M0 的调试面板：让预算守卫的行为可见，而不是一个黑盒。 */
export function PromptInspector({ prompt }: Props) {
  if (!prompt) {
    return (
      <section className="panel">
        <h2>Prompt 检查器</h2>
        <p className="hint">发出第一条消息后，这里会显示本次装配的实际内容与降级情况。</p>
      </section>
    );
  }

  const { report, messages, blocks } = prompt;

  return (
    <section className="panel">
      <h2>Prompt 检查器</h2>
      <div className="stats">
        <span>
          约 <strong>{report.usedTokens}</strong> / {report.maxTokens} token
        </span>
        <span>{blocks.length} 个块</span>
        <span>{messages.length} 条消息</span>
      </div>

      {report.stages.length > 0 ? (
        <div className="notice warn">
          <strong>预算降级已触发</strong>
          <ul>
            {report.stages.map((stage) => (
              <li key={stage}>{STAGE_LABELS[stage] ?? stage}</li>
            ))}
          </ul>
          {report.dropped.length > 0 ? (
            <p className="hint">
              被丢弃：{report.dropped.map((block) => `${block.label}(${block.tokens})`).join('、')}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="hint">预算充裕，没有触发任何降级。</p>
      )}

      <details>
        <summary>各区块（按装配顺序）</summary>
        <ol className="blocks">
          {blocks.map((block) => (
            <li key={block.id}>
              <span className="tag">{block.kind}</span>
              <strong>{block.label}</strong>
              <span className="hint">{block.content.length} 字符</span>
            </li>
          ))}
        </ol>
      </details>

      <details>
        <summary>最终发给模型的 messages</summary>
        {messages.map((message, index) => (
          <pre key={`${message.role}-${String(index)}`} className="raw">
            {`[${message.role}]\n${message.content}`}
          </pre>
        ))}
      </details>
    </section>
  );
}
