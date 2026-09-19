import type { UsageGroup, UsageSummary, UsageTotals } from '@dramatis/core';
import { CATEGORY_LABELS, formatCost, formatTokens } from '../lib/usage';

interface Props {
  world: UsageSummary | null;
  conversation: UsageSummary | null;
  /** 当前对话名，用来给「本对话」那一段做标题。 */
  conversationTitle: string;
}

function figure(totals: UsageTotals): string {
  const cost = formatCost(totals);
  const tokens = `${formatTokens(totals.promptTokens)} 提示 / ${formatTokens(totals.completionTokens)} 输出`;
  return `${tokens}${cost === null ? '' : ` · ${cost}`}`;
}

function GroupList({
  groups,
  labelOf,
}: {
  groups: Array<UsageGroup<string>>;
  labelOf: (group: UsageGroup<string>) => string;
}) {
  if (groups.length === 0) return <p className="hint">还没有记录。</p>;

  return (
    <ul className="usage-list">
      {groups.map((group) => (
        <li key={group.key}>
          <span className="usage-name">{labelOf(group)}</span>
          <span className="hint">{group.totals.calls} 次</span>
          <span className="usage-figure">{figure(group.totals)}</span>
        </li>
      ))}
    </ul>
  );
}

function formatTime(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * 用量与花费（ROADMAP P3-7 / T7）。
 *
 * 这里的数字全部来自落盘的流水，刷新与重启都不丢——五十回合长跑时因为计数是
 * 会话级的，中途重载两次就把全程账单冲掉了，只能给量级估算。现在可以直接回答
 * 「这一局跑了多少、花了多少」。
 *
 * 花费只在配了单价时出现：没配就只报 token，绝不用一个编出来的价格糊弄。
 */
export function UsagePanel({ world, conversation, conversationTitle }: Props) {
  if (world === null || world.total.calls === 0) {
    return (
      <section className="panel">
        <h2>用量与花费</h2>
        <p className="hint">还没有账单。每一次模型调用都会在这里记一笔，刷新和重启都不会丢。</p>
        <p className="hint">
          花费需要单价：在设置 → 模型接入里填「每百万 token 的输入 / 输出价格」，这里就会换算成钱。
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <h2>用量与花费</h2>
        <ul className="usage-list">
          <li>
            <span className="usage-name">这个世界</span>
            <span className="hint">{world.total.calls} 次调用</span>
            <span className="usage-figure">{figure(world.total)}</span>
          </li>
          {conversation === null ? null : (
            <li>
              <span className="usage-name">本条对话（{conversationTitle}）</span>
              <span className="hint">{conversation.total.calls} 次调用</span>
              <span className="usage-figure">{figure(conversation.total)}</span>
            </li>
          )}
        </ul>
        <p className="hint">
          {formatCost(world.total) === null
            ? '还没设单价，所以只报 token。填上单价后，历史账单也会一起换算出来。'
            : `第一条记录：${formatTime(world.firstAt)}；最近一次：${formatTime(world.lastAt)}。`}
        </p>
      </section>

      <section className="panel">
        <h2>按用途</h2>
        <GroupList groups={world.byCategory} labelOf={(group) => CATEGORY_LABELS[group.key] ?? group.key} />
      </section>

      <section className="panel">
        <h2>按角色（只算生成）</h2>
        <GroupList groups={world.bySpeaker} labelOf={(group) => group.label || '（未知）'} />
        <p className="hint">后台调用不属于任何角色，所以不在这里分摊。</p>
      </section>

      <section className="panel">
        <h2>按模型</h2>
        <GroupList groups={world.byModel} labelOf={(group) => group.label || '（未命名）'} />
      </section>
    </>
  );
}
