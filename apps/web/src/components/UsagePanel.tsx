import {
  type BudgetDraftSave,
  type BudgetEditorDraft,
  type BudgetLimits,
  type BudgetState,
  budgetCurrencyRows,
  budgetDraftSaveBlockReason,
  budgetDraftSignature,
  budgetLimitsSignature,
  clearBudgetCostDraft,
  confirmBudgetMigration,
  createBudgetDraft,
  evaluateBudget,
  reconcileBudgetDraft,
  type UsageGroup,
  type UsageSummary,
  type UsageTotals,
  validateBudgetDraft,
} from '@dramatis/core';
import { useEffect, useId, useRef, useState } from 'react';
import { formatTime } from '../lib/format';
import { CATEGORY_LABELS, formatCalibrationNote, formatCost, formatTokens } from '../lib/usage';

interface Props {
  /** Explicit identity supplied by the caller; summaries/limits cannot identify a world. */
  worldId?: string | null;
  world: UsageSummary | null;
  conversation: UsageSummary | null;
  latestTurn: UsageSummary | null;
  /** 本局的调用预算与熔断状态（P1-9）。 */
  budget: BudgetState;
  /** 已经保存的上限（草稿的初值）。 */
  limits: BudgetLimits | null;
  onSaveBudget: (limits: BudgetLimits | null) => void | Promise<void>;
  /** 当前对话名，用来给「本对话」那一段做标题。 */
  conversationTitle: string;
}

/** Only an explicit save writes; selection, confirmation and clearing are draft operations. */
function BudgetEditor({
  worldId,
  limits,
  state,
  summary,
  onSave,
}: {
  worldId?: string | null;
  limits: BudgetLimits | null | undefined;
  state: BudgetState;
  summary: UsageSummary | null;
  onSave: (limits: BudgetLimits | null) => void | Promise<void>;
}) {
  const [editor, setEditor] = useState(() => {
    const draft = createBudgetDraft(limits);
    return { draft, baseSignature: budgetLimitsSignature(limits), cleanSignature: budgetDraftSignature(draft) };
  });
  const [actionErrors, setActionErrors] = useState<string[]>([]);
  const [saveStatus, setSaveStatus] = useState({ busy: false, error: false, unconfirmed: false, message: '' });
  const saveRequest = useRef<BudgetDraftSave | null>(null);
  const saving = useRef(false);
  const currencyListId = useId();
  const signature = budgetLimitsSignature(limits);
  const { draft } = editor;
  const dirty = budgetDraftSignature(draft) !== editor.cleanSignature;
  const conflict = signature !== editor.baseSignature;
  const validation = validateBudgetDraft(draft);
  const hasChanges = validation.ok && budgetLimitsSignature(validation.limits) !== signature;
  const canRetry = saveStatus.error || saveStatus.unconfirmed;
  const saveBlockReason = budgetDraftSaveBlockReason(draft, worldId);

  // A new object with identical values must not erase text; real changes preserve dirty drafts.
  useEffect(() => {
    const request = saveRequest.current;
    const snapshot =
      request === null
        ? null
        : {
            ...request,
            confirmed: request.confirmed && !saveStatus.busy && !saveStatus.error && !saveStatus.unconfirmed,
          };
    setEditor((previous) => reconcileBudgetDraft(previous, limits, snapshot));
  }, [limits, saveStatus.busy, saveStatus.error, saveStatus.unconfirmed]);

  useEffect(
    () => () => {
      // Keyed world changes/unmounts must not let a prior request update this editor.
      saveRequest.current = null;
    },
    [],
  );

  function edit(update: (previous: BudgetEditorDraft) => BudgetEditorDraft) {
    setEditor((previous) => ({ ...previous, draft: update(previous.draft) }));
    setActionErrors([]);
    setSaveStatus({ busy: false, error: false, unconfirmed: false, message: '' });
  }

  async function save() {
    if (budgetDraftSaveBlockReason(draft, worldId) !== null) return;
    if (!validation.ok || conflict || (!hasChanges && !canRetry) || saving.current) return;
    const request = {
      signature: budgetLimitsSignature(validation.limits),
      draftSignature: budgetDraftSignature(draft),
      baseSignature: signature,
      confirmed: false,
    };
    saveRequest.current = request;
    saving.current = true;
    setSaveStatus({ busy: true, error: false, unconfirmed: false, message: '正在提交保存请求，尚未确认落盘。' });
    try {
      const completion = onSave(validation.limits);
      if (completion !== undefined && typeof completion.then === 'function') {
        await completion;
        if (saveRequest.current === request) {
          request.confirmed = true;
          // The reconciliation effect checks CURRENT limits before acknowledging this draft.
          // A late fulfillment must not clear a conflict with a newer external budget.

          setSaveStatus({ busy: false, error: false, unconfirmed: false, message: '保存回调已完成，请核对当前配置。' });
        }
      } else if (saveRequest.current === request) {
        // The existing App callback returns void, discarding the persistence promise.
        // Neither its return nor an optimistic props echo proves durable success.
        setSaveStatus({
          busy: false,
          error: false,
          unconfirmed: true,
          message:
            '已提交，等待状态确认；当前回调未提供落盘结果，配置回显也不等于保存成功。若应用报错，请保留草稿后重试。',
        });
      }
    } catch (error) {
      if (saveRequest.current === request) {
        setSaveStatus({
          busy: false,
          error: true,
          unconfirmed: false,
          message: `保存失败，草稿已保留：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } finally {
      saving.current = false;
    }
  }

  // Optional diagnostics remain compatible with legacy callers of UsagePanel.
  const diagnostics = state.currencyBudgets === undefined ? evaluateBudget(summary, limits ?? null) : state;
  const currencyRows = budgetCurrencyRows(diagnostics, limits);
  const unpricedCalls =
    state.unpricedCalls ?? Math.max(0, (summary?.total.calls ?? 0) - (summary?.total.pricedCalls ?? 0));
  const costPolicy = state.costPolicy ?? (limits?.maxCostByCurrency === undefined ? 'legacy-primary' : 'per-currency');
  const needsSelection =
    state.needsCurrencySelection === true ||
    (costPolicy === 'legacy-primary' && typeof limits?.maxCost === 'number' && limits.maxCost > 0);
  const oldDraft = draft.mode === 'legacy' && draft.legacyCost !== '';
  const currencies = [
    ...new Set([
      'CNY',
      'USD',
      'EUR',
      'GBP',
      'JPY',
      'HKD',
      '¥',
      '$',
      '€',
      ...currencyRows.map((row) => row.currency),
      ...draft.currencies.map((row) => row.currency).filter(Boolean),
    ]),
  ];
  const errors = [...actionErrors, ...(validation.ok ? [] : validation.errors)];

  return (
    <section className="panel">
      <h2>本局上限</h2>
      {typeof worldId !== 'string' || worldId.trim() === '' ? (
        <p className="hint">
          调用方尚未接通明确世界标识，无法保证草稿跨世界隔离；逐币种配置、迁移和清空暂不开放提交。旧 legacy
          模式仅保留兼容保存，不代表已解决上游旧快照回写。
        </p>
      ) : null}
      <p className="hint">
        当前金额策略：{costPolicy === 'per-currency' ? '逐币种' : '旧展示主币种兼容模式'}。
        到上限只停后台调用（意图判断、一轮分析、分层摘要），角色回复照常；不会仅因混用币种就暂停。
      </p>
      {needsSelection ? (
        <div className="notice warn">
          <strong>旧金额上限尚未迁移：存在漏拦风险</strong>
          <p>
            旧标量上限为 {String(limits?.maxCost ?? '未知')}，未绑定币种，仍按旧展示主币种策略运行；
            展示主币种变化可能改变判断。不会自动暂停、换汇或复制此上限。
            只有明确选币种、确认并保存，或主动清除并保存，才会退出旧模式。
          </p>
        </div>
      ) : null}

      <label>
        额外调用上限
        <input
          type="text"
          inputMode="numeric"
          placeholder="留空＝不限"
          disabled={saveStatus.busy}
          value={draft.calls}
          onChange={(event) => edit((previous) => ({ ...previous, calls: event.target.value }))}
        />
      </label>
      <datalist id={currencyListId}>
        {currencies.map((currency) => (
          <option key={currency} value={currency} />
        ))}
      </datalist>

      {oldDraft ? (
        <div className="notice warn">
          <p>迁移草稿：将旧上限 {draft.legacyCost} 仅绑定到你选择的一个币种，不预选展示主币种。</p>
          <label>
            旧上限对应币种（必须主动选择）
            <input
              type="text"
              list={currencyListId}
              placeholder="请选择或输入原币种标签"
              disabled={saveStatus.busy}
              value={draft.migrationCurrency}
              onChange={(event) => edit((previous) => ({ ...previous, migrationCurrency: event.target.value }))}
            />
          </label>
          <button
            type="button"
            disabled={saveStatus.busy}
            onClick={() => {
              const result = confirmBudgetMigration(draft);
              if (result.ok) edit(() => result.draft);
              else setActionErrors(result.errors);
            }}
          >
            确认仅绑定此币种（暂存草稿）
          </button>
          <p className="hint">仅选择币种不会迁移；未确认时保存次数上限也会保留旧金额策略。</p>
        </div>
      ) : (
        <>
          <h3>逐币种金额上限草稿</h3>
          {draft.currencies.map((row) => (
            <div key={row.id}>
              <div className="grid-2">
                <label>
                  币种（原标签）
                  <input
                    type="text"
                    list={currencyListId}
                    placeholder="如 CNY、USD、¥ 或新币种"
                    disabled={saveStatus.busy}
                    value={row.currency}
                    onChange={(event) =>
                      edit((previous) => ({
                        ...previous,
                        currencies: previous.currencies.map((item) =>
                          item.id === row.id ? { ...item, currency: event.target.value } : item,
                        ),
                      }))
                    }
                  />
                </label>
                <label>
                  金额上限
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="有限正数；留空＝该币种未设限"
                    disabled={saveStatus.busy}
                    value={row.amount}
                    onChange={(event) =>
                      edit((previous) => ({
                        ...previous,
                        currencies: previous.currencies.map((item) =>
                          item.id === row.id ? { ...item, amount: event.target.value } : item,
                        ),
                      }))
                    }
                  />
                </label>
              </div>
              <button
                type="button"
                disabled={saveStatus.busy}
                onClick={() =>
                  edit((previous) => ({
                    ...previous,
                    currencies: previous.currencies.filter((item) => item.id !== row.id),
                  }))
                }
              >
                移除此币种上限（暂存草稿）
              </button>
            </div>
          ))}
          {draft.currencies.length === 0 ? <p className="hint">草稿中未设置任何逐币种上限。</p> : null}
          <button
            type="button"
            disabled={saveStatus.busy}
            onClick={() =>
              edit((previous) => ({
                ...previous,
                mode: 'per-currency',
                currencies: [
                  ...previous.currencies,
                  {
                    id: Math.max(-1, ...previous.currencies.map((row) => row.id)) + 1,
                    currency: '',
                    amount: '',
                  },
                ],
              }))
            }
          >
            新增币种（可无历史账单）
          </button>
        </>
      )}
      <button type="button" disabled={saveStatus.busy} onClick={() => edit(clearBudgetCostDraft)}>
        清空全部金额上限（暂存草稿，保留次数上限）
      </button>
      <p className="hint">
        币种允许可打印空格和标点，按原标签精确匹配，不自动 trim。CNY 与「CNY 」不同，CNY 与 ¥、USD 与 $
        也不合并或换汇。未配置的币种明确保持未设限。
      </p>

      {errors.length === 0 ? null : (
        <div className="notice error" role="alert">
          {errors.join('；')}
        </div>
      )}
      {conflict ? (
        <div className="notice warn" role="alert">
          当前配置已在别处改变；你的草稿已保留。为避免覆盖已存币种映射，保存暂不可用，请先核对当前配置。
        </div>
      ) : null}
      {dirty || conflict ? (
        <button
          type="button"
          disabled={saveStatus.busy}
          onClick={() => {
            const fresh = createBudgetDraft(limits);
            saveRequest.current = null;
            setEditor({ draft: fresh, baseSignature: signature, cleanSignature: budgetDraftSignature(fresh) });
            setActionErrors([]);
            setSaveStatus({ busy: false, error: false, unconfirmed: false, message: '' });
          }}
        >
          放弃草稿，载入当前配置
        </button>
      ) : null}
      {saveBlockReason === null ? null : (
        <p className="notice warn" role="status">
          {saveBlockReason}
        </p>
      )}
      <div className="save-bar">
        <button
          type="button"
          disabled={
            saveBlockReason !== null || !validation.ok || (!hasChanges && !canRetry) || conflict || saveStatus.busy
          }
          onClick={() => void save()}
        >
          {saveStatus.busy
            ? '正在提交…'
            : canRetry && !hasChanges
              ? '重试保存上限（点击后写入）'
              : '保存上限（点击后写入）'}
        </button>
        <span className="hint">
          {dirty ? '草稿有改动；确认、增删或清空均须再点保存才写入。' : '编辑不会自动保存。'}
        </span>
      </div>
      {saveStatus.message ? (
        <p className={saveStatus.error ? 'notice error' : 'hint'} role={saveStatus.error ? 'alert' : 'status'}>
          {saveStatus.message}
        </p>
      ) : null}

      <h3>当前配置与用量（不是草稿预览）</h3>
      <ul className="usage-list">
        <li>
          <span className="usage-name">额外调用</span>
          <span className="usage-figure">
            已用 {state.extraCalls} 次 · 上限 {limits?.maxExtraCalls ?? '未设限'} · 剩余{' '}
            {state.remainingCalls ?? '未设限'}
          </span>
        </li>
        {currencyRows.map((row) => (
          <li key={row.currency}>
            <span className="usage-name">{row.currency}</span>
            <span className="usage-figure">
              已知花费 {row.cost === null ? '未知（无已定价账单）' : String(row.cost)}
              {' · '}上限 {row.limit === null ? '未设限' : String(row.limit)}
              {' · '}剩余{' '}
              {row.limit === null
                ? '未设限'
                : row.remaining === null
                  ? '未知（不能据此当作全额可用）'
                  : String(row.remaining)}
              {' · '}触发原因：
              {row.exceeded
                ? `${row.currency} 已知花费达到上限`
                : row.limit === null
                  ? '无逐币种限制'
                  : row.cost === null
                    ? '金额未知，无法判断'
                    : '已知花费未达上限'}
            </span>
          </li>
        ))}
      </ul>
      {currencyRows.length === 0 ? <p className="hint">暂无已定价币种或逐币种配置，不代表免费。</p> : null}
      <div className="notice warn">
        <p>
          {unpricedCalls > 0
            ? `${unpricedCalls} 次调用没有可用价格，费用未知，不能当作免费。`
            : '已知花费只是按已记录用量和单价得到的估算。'}
          服务商未返回 usage 时记为 0 token 也不能证明免费；上限与剩余只反映已知费用，实际账单可能更高。
          未知费用不会自动触发金额熔断，可另设次数上限。
        </p>
      </div>
      {state.burned ? (
        <div className="notice warn">
          <strong>已熔断</strong>
          <p>{state.reason}——后台调用已停，聊天不受影响。调整或清空已触发的上限并保存后重新判断。</p>
        </div>
      ) : null}
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
export function UsagePanel({
  worldId,
  world,
  conversation,
  latestTurn,
  conversationTitle,
  budget,
  limits,
  onSaveBudget,
}: Props) {
  // Explicit identity isolates equal-budget worlds too; this cannot repair upstream stale writes.
  const budgetEditorKey = JSON.stringify(['budget-editor', worldId ?? null]);
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
        <BudgetEditor
          key={budgetEditorKey}
          worldId={worldId}
          limits={limits}
          state={budget}
          summary={world}
          onSave={onSaveBudget}
        />
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
            ? '没有可用的价格快照，所以只报 token，费用未知。新单价只用于后续调用，不会补算旧账单。'
            : `第一条记录：${formatTime(world.firstAt)}；最近一次：${formatTime(world.lastAt)}。`}
        </p>
        {calibrationNote === null ? null : <p className="hint">{calibrationNote}</p>}
      </section>

      {latestTurn === null || latestTurn.total.calls === 0 ? null : (
        <section className="panel">
          <h2>最近一轮</h2>
          <ul className="usage-list">
            <li>
              <span className="usage-name">已记录导演判断</span>
              <span className="usage-figure">
                {latestTurn.byCategory.find((group) => group.key === 'intent')?.totals.calls ?? 0} 次
              </span>
            </li>
            <li>
              <span className="usage-name">已记录角色生成</span>
              <span className="usage-figure">
                {latestTurn.byCategory.find((group) => group.key === 'generation')?.totals.calls ?? 0} 次
              </span>
            </li>
            <li>
              <span className="usage-name">已记录用量</span>
              <span className="usage-figure">{figure(latestTurn.total)}</span>
            </li>
          </ul>
          <p className="hint">
            服务商未返回用量时该次记为 0
            token；即使其他调用有用量，汇总可能低估。失败或中止的调用不计入上述次数，服务商仍可能计费。
          </p>
        </section>
      )}

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

      <BudgetEditor
        key={budgetEditorKey}
        worldId={worldId}
        limits={limits}
        state={budget}
        summary={world}
        onSave={onSaveBudget}
      />
    </>
  );
}
