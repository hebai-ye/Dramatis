import type { AdminTurnObservation, ChatToolCall } from '@dramatis/core';
import { useEffect, useRef, useState } from 'react';
import { useAdminProcess } from '../hooks/useAdminProcess';
import { type AdminProcessScope, type AdminRunSnapshot, adminProcessStore } from '../lib/admin-process-store';

const TOOL_NAMES: Record<string, string> = {
  upsert_character_card: '起草角色卡',
  upsert_world_book: '起草世界书',
  upsert_persona: '起草身份',
  delete_persona: '起草身份删除方案',
  set_scene: '设置场景',
};
const PHASE_NAMES: Record<AdminRunSnapshot['phase'], string> = {
  'saving-input': '保存消息…',
  preparing: '准备请求…',
  'waiting-model': '等待回复',
  'receiving-reasoning': '思考中',
  writing: '正在回复',
  executing: '正在处理工具',
  'waiting-next-model': '等待后续回复',
  'saving-output': '保存回复与草稿…',
  saved: '已完成',
  stopping: '正在停止…',
  stopped: '已停止',
  failed: '未完成',
  partial: '部分完成',
  uncertain: '保存结果待核对',
  'saved-read-failed': '已保存 · 显示未更新',
  'saved-accounting-failed': '已保存 · 用量记录未完成',
};
type ToolReceived = Extract<AdminTurnObservation, { type: 'tool-received' }>;
function toolTitle(call: ChatToolCall) {
  let name = '';
  try {
    const args = JSON.parse(call.function.arguments);
    if (typeof args?.name === 'string') name = args.name;
    else if (typeof args?.location === 'string') name = args.location;
  } catch {
    /* Parameters may be malformed; keep the actual raw text in details. */
  }
  return `${TOOL_NAMES[call.function.name] ?? '不支持的工具'}${name ? `「${name}」` : ''}`;
}
function toolEvents(run: AdminRunSnapshot, tool: ToolReceived) {
  return run.entries
    .filter(
      (e) =>
        'toolIndex' in e.event && e.event.requestIndex === tool.requestIndex && e.event.toolIndex === tool.toolIndex,
    )
    .map((e) => e.event);
}
export function AdminProcessDisclosure({ scope, runId }: { scope: AdminProcessScope; runId: string }) {
  const run = useAdminProcess(scope, { runId });
  const [now, setNow] = useState(Date.now);
  const content = useRef<HTMLDivElement | null>(null),
    follow = useRef(true);
  const running = !!run && run.endedAt === null;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow new entries only while this disclosure is at its bottom.
  useEffect(() => {
    if (content.current && follow.current && run?.expanded.process)
      content.current.scrollTop = content.current.scrollHeight;
  }, [run?.entries, run?.expanded.process]);
  if (!run) return null;
  const tools = run.entries.filter((e): e is typeof e & { event: ToolReceived } => e.event.type === 'tool-received');
  const current = tools.find((e) => {
    const events = toolEvents(run, e.event);
    return events.some((e) => e.type === 'tool-start') && !events.some((e) => e.type === 'tool-end');
  });
  const seconds = Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1000));
  const idle = Math.max(0, Math.floor((now - run.updatedAt) / 1000));
  const title =
    run.phase === 'executing' && current
      ? toolTitle(current.event.call)
      : run.phase === 'preparing' && run.endedAt !== null
        ? '提示词已准备'
        : PHASE_NAMES[run.phase];
  return (
    <div className="admin-process-wrap">
      <details
        className="admin-process"
        open={run.expanded.process ?? false}
        onToggle={(e) => adminProcessStore.setExpanded(scope, runId, 'process', e.currentTarget.open)}
      >
        <summary aria-label={`${title}，详情`}>
          <span aria-live="polite">{title}</span>
          {tools.length > 0 && run.endedAt !== null ? <span className="hint"> · {tools.length} 个动作</span> : null}
          <span className="hint"> · {seconds} 秒</span>
          <span className="admin-process-detail">详情</span>
        </summary>
        <div
          className="admin-process-content"
          ref={content}
          onScroll={(e) => {
            const node = e.currentTarget;
            follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
          }}
        >
          {run.entries.map((entry) => {
            const event = entry.event;
            if (event.type === 'reasoning')
              return (
                <section key={`${entry.key}:${entry.sequence}`} className="admin-thinking">
                  <span className="hint">思考内容 · 本次生成可查看</span>
                  <div>{event.delta}</div>
                </section>
              );
            if (event.type === 'request-start')
              return (
                <p className="hint" key={entry.key}>
                  {event.requestIndex === 0 ? '等待回复' : '等待后续回复'}
                </p>
              );
            if (event.type !== 'tool-received') return null;
            const key = `tool:${event.requestIndex}:${event.toolIndex}`,
              events = toolEvents(run, event);
            const end = events.find((e) => e.type === 'tool-end'),
              started = events.some((e) => e.type === 'tool-start');
            const execution = end?.type === 'tool-end' ? end.execution : null;
            const status = execution
              ? !execution.ok
                ? execution.draft
                  ? '未完成'
                  : '未执行'
                : execution.draft?.kind === 'scene'
                  ? '处理结束 · 见结果'
                  : run.messageId
                    ? '草稿已保存'
                    : '草稿已生成 · 待保存'
              : run.endedAt !== null
                ? started
                  ? '结果待核对'
                  : '未执行'
                : started
                  ? '执行中'
                  : '等待执行';
            return (
              <details
                className="admin-tool-row"
                key={key}
                open={run.expanded[key] ?? false}
                onToggle={(e) => adminProcessStore.setExpanded(scope, runId, key, e.currentTarget.open)}
              >
                <summary>
                  {toolTitle(event.call)}{' '}
                  <span className={`hint${execution && !execution.ok ? ' warn' : ''}`}>{status}</span>
                </summary>
                <div className="admin-tool-detail">
                  <span className="hint">
                    {event.call.function.name} · {event.call.id}
                  </span>
                  <pre>{event.call.function.arguments}</pre>
                  {execution ? <p>{execution.result}</p> : null}
                </div>
              </details>
            );
          })}
          {run.sceneEffects.map((effect) => (
            <p key={effect.target.sceneId} className={effect.activeLinked ? 'hint' : 'hint warn'}>
              {effect.target.worldTitle} / {effect.target.conversationTitle} / {effect.target.sceneTitle} ·{' '}
              {effect.activeLinked ? '场景已保存并关联' : '场景记录已写入，关联待核对'}
            </p>
          ))}
          <p className="hint">本次打开期间的记录</p>
        </div>
      </details>
      {run.issue ? (
        <p
          className={`notice${run.issue.kind === 'error' ? ' error' : ''}`}
          role={run.issue.kind === 'error' ? 'alert' : 'status'}
        >
          {run.issue.text}
        </p>
      ) : null}
      {run.endedAt === null &&
      ['waiting-model', 'waiting-next-model', 'receiving-reasoning', 'writing'].includes(run.phase) &&
      idle >= 12 ? (
        <p className="hint">暂未收到新内容。{idle >= 45 ? '可以继续等待，或停止生成。' : ''}</p>
      ) : null}
    </div>
  );
}
