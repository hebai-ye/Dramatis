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

/** 块落点的人话（顺序 60）：世界书的 position 现在真的有用，得让人看得见。 */
const PLACEMENT_LABELS: Record<string, string> = {
  before_char: '人设前',
  after_char: '人设后',
  before_scene: '场景前',
  after_scene: '场景后',
  at_depth: '插进历史',
  default: '默认位置',
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

  const { report, messages, blocks, memoryStats, historyStats } = prompt;
  const memoryTotal = memoryStats.recall + memoryStats.mention + memoryStats.source;

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
      {/* 历史怎么带的（顺序 58）：这个角色看得见多少、场记覆盖后收起多少、提到又取回几条 */}
      <p className="hint history-stats">
        历史 {historyStats.total} 条：可见 {historyStats.visible} 条 · 场记覆盖后收起 {historyStats.collapsed} 条 ·
        提到取回 {historyStats.recalled} 条
      </p>
      {/* 记忆各是怎么想起来的（顺序 57）：常规召回之外，被取代的原文只在被提到或问过去时回来 */}
      <p className="hint memory-origins">
        记忆 {memoryTotal} 条：常规召回 {memoryStats.recall} 条 · 提到才想起 {memoryStats.mention} 条 · 印象来源{' '}
        {memoryStats.source} 条
      </p>

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
            <li key={block.id} title={block.id}>
              <span className="tag">{block.kind}</span>
              <strong>{block.label}</strong>
              {/* 世界书每条命中各成一块（顺序 60），落点要看得见：人设前 / 场景后 / 插进历史第几条 */}
              {block.placement === undefined || block.placement === 'default' ? null : (
                <span className="tag">
                  {PLACEMENT_LABELS[block.placement] ?? block.placement}
                  {block.depth === undefined ? '' : ` ${String(block.depth)}`}
                </span>
              )}
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
