import type { BudgetLimits, BudgetState, UsageGroup, UsageSummary, UsageTotals } from '@dramatis/core';
import { useEffect, useState } from 'react';
import { formatTime } from '../lib/format';
import { CATEGORY_LABELS, formatCalibrationNote, formatCost, formatMoney, formatTokens } from '../lib/usage';

interface Props {
  world: UsageSummary | null;
  conversation: UsageSummary | null;
  /** 本局的调用预算与熔断状态（P1-9）。 */
  budget: BudgetState;
  /** 已经保存的上限（草稿的初值）。 */
  limits: BudgetLimits | null;
  onSaveBudget: (limits: BudgetLimits | null) => void;
  /** 当前对话名，用来给「本对话」那一段做标题。 */
  conversationTitle: string;
}

/** 上限的草稿：按字符串收，「留空」比 0 更诚实。 */
interface BudgetDraft {
  calls: string;
  cost: string;
}

function toDraft(limits: BudgetLimits | null | undefined): BudgetDraft {
  return {
    calls: limits?.maxExtraCalls == null ? '' : String(limits.maxExtraCalls),
    cost: limits?.maxCost == null ? '' : String(limits.maxCost),
  };
}

function toLimits(draft: BudgetDraft): BudgetLimits | null {
  const calls = draft.calls.trim() === '' ? null : Number(draft.calls);
  const cost = draft.cost.trim() === '' ? null : Number(draft.cost);
  const limits: BudgetLimits = {
    maxExtraCalls: calls !== null && Number.isFinite(calls) && calls > 0 ? calls : null,
    maxCost: cost !== null && Number.isFinite(cost) && cost > 0 ? cost : null,
  };
  return limits.maxExtraCalls === null && limits.maxCost === null ? null : limits;
}

/**
 * 本局预算（ROADMAP P1-9 的熔断）。
 *
 * 管的是**生成之外的调用**：意图判断、一轮分析、分层摘要。到上限就停这些，
 * 角色回复照常——聊到一半突然说不出话，比多花几分钱糟糕得多。
 */
function BudgetEditor({
  limits,
  state,
  currency,
  onSave,
}: {
  limits: BudgetLimits | null | undefined;
  state: BudgetState;
  currency: string | null;
  onSave: (limits: BudgetLimits | null) => void;
}) {
  const [draft, setDraft] = useState<BudgetDraft>(() => toDraft(limits));
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // 换世界或在别处改过上限时重置草稿；依赖是具体值，避免把正在输入的内容冲掉
  const signature = `${String(limits?.maxExtraCalls ?? '')}|${String(limits?.maxCost ?? '')}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖就是上面那串值
  useEffect(() => {
    setDraft(toDraft(limits));
    setSavedAt(null);
  }, [signature]);

  const current = JSON.stringify(toLimits(draft)) !== JSON.stringify(toLimits(toDraft(limits)));

  return (
    <section className="panel">
      <h2>本局上限</h2>
      <div className="grid-2">
        <label>
          额外调用上限
          <input
            type="number"
            min="1"
            step="1"
            placeholder="留空＝不限"
            value={draft.calls}
            onChange={(event) => {
              setDraft((previous) => ({ ...previous, calls: event.target.value }));
              setSavedAt(null);
            }}
          />
        </label>
        <label>
          花费上限
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="留空＝不限"
            value={draft.cost}
            onChange={(event) => {
              setDraft((previous) => ({ ...previous, cost: event.target.value }));
              setSavedAt(null);
            }}
          />
        </label>
      </div>
      <p className="hint">
        到上限后只停后台调用（意图判断、一轮分析、分层摘要），角色回复照常生成。 花费上限要先在设置里填单价才生效。
      </p>

      <ul className="usage-list">
        <li>
          <span className="usage-name">本局已用</span>
          <span className="usage-figure">
            {state.extraCalls} 次额外调用
            {state.cost === null ? '' : ` · ${formatMoney(state.cost, currency)}`}
          </span>
        </li>
        {state.remainingCalls === null ? null : (
          <li>
            <span className="usage-name">还能再调</span>
            <span className="usage-figure">{state.remainingCalls} 次</span>
          </li>
        )}
      </ul>

      {state.burned ? (
        <div className="notice warn">
          <strong>已熔断</strong>
          <p>{state.reason}——后台调用已停，聊天不受影响。调高上限或清空即可恢复。</p>
        </div>
      ) : null}

      <div className="save-bar">
        <button
          type="button"
          disabled={!current}
          onClick={() => {
            onSave(toLimits(draft));
            setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
          }}
        >
          保存上限
        </button>
        <span className="hint">
          {current ? '有未保存的改动' : savedAt === null ? '改动只在点保存后生效' : `已保存（${savedAt}）`}
        </span>
      </div>
    </section>
  );
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

/**
 * 用量与花费（ROADMAP P3-7 / T7）。
 *
 * 这里的数字全部来自落盘的流水，刷新与重启都不丢——五十回合长跑时因为计数是
 * 会话级的，中途重载两次就把全程账单冲掉了，只能给量级估算。现在可以直接回答
 * 「这一局跑了多少、花了多少」。
 *
 * 花费只在配了单价时出现：没配就只报 token，绝不用一个编出来的价格糊弄。
 */
export function UsagePanel({ world, conversation, conversationTitle, budget, limits, onSaveBudget }: Props) {
  const calibrationNote = world === null ? null : formatCalibrationNote(world.total);

  if (world === null || world.total.calls === 0) {
    return (
      <>
        <section className="panel">
          <h2>用量与花费</h2>
          <p className="hint">还没有账单。每一次模型调用都会在这里记一笔，刷新和重启都不会丢。</p>
          <p className="hint">
            花费需要单价：在设置 → 模型接入里填「每百万 token 的输入 / 输出价格」，这里就会换算成钱。
          </p>
        </section>
        <BudgetEditor limits={limits} state={budget} currency={null} onSave={onSaveBudget} />
      </>
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
        {calibrationNote === null ? null : <p className="hint">{calibrationNote}</p>}
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

      <BudgetEditor limits={limits} state={budget} currency={world.total.currency} onSave={onSaveBudget} />
    </>
  );
}
