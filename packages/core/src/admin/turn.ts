import type { ChatMessage, ChatToolCall } from '../prompt/types.js';
import { collectCompletionWithTools } from '../provider/collect.js';
import type { ModelParams, ModelProvider, TokenUsage } from '../provider/openai-compatible.js';
import { ADMIN_TOOLS, type AdminDraft, type AdminToolContext, parseAdminToolCall } from './tools.js';

/** 一次工具调用的执行记录，界面据此显示「管理员改了什么」。 */
export interface AdminToolExecution {
  callId: string;
  toolName: string;
  /** 回填给模型的文本结果，会进入下一轮的上下文。 */
  result: string;
  draft: AdminDraft | null;
  ok: boolean;
}

export type AdminTurnEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; execution: AdminToolExecution }
  | {
      type: 'done';
      text: string;
      executions: AdminToolExecution[];
      /**
       * 这一轮的用量合计。
       *
       * 管理员会为了回填工具结果跑好几轮调用（最多三轮），所以这里把每一轮的
       * 用量加起来——只记最后一轮会漏掉大头（T7 的账单口径）。
       * 服务商一次都没返回时是 null。
       */
      usage: TokenUsage | null;
      /** 实际发生了几次调用（工具回填会让它大于 1）。 */
      calls: number;
    };

export interface AdminTurnOptions {
  params?: ModelParams;
  signal?: AbortSignal;
  /** 最多允许几轮「调用工具 → 回填结果」，防止模型来回刷工具。 */
  maxRounds?: number;
  context?: AdminToolContext;
  /** 模型点名的工具由调用方真正执行（落库 / 应用场景设置），返回给模型的文本。 */
  execute: (draft: AdminDraft) => Promise<string>;
}

const DEFAULT_MAX_ROUNDS = 3;

/**
 * 跑一轮副对话（LAYOUT「副对话状态 / 需要真实调用工具」）。
 *
 * 与角色扮演回合的区别是这里是**真的**在调用工具：模型请求调用，我们把
 * 参数解析成草稿，交给调用方执行，再把执行结果作为 tool 消息回填，
 * 让模型接着说话。回填这一步不能省——否则模型不知道工具到底成没成，
 * 只会把同一份草稿反复起草一遍。
 */
export async function* runAdminTurn(
  provider: ModelProvider,
  messages: readonly ChatMessage[],
  options: AdminTurnOptions,
): AsyncIterable<AdminTurnEvent> {
  const maxRounds = Math.max(1, options.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const context = options.context ?? {};
  const conversation: ChatMessage[] = [...messages];
  const executions: AdminToolExecution[] = [];
  let fullText = '';
  // 分两栏累加而不是每轮覆盖：管理员一次回合可能跑三次调用（工具回填），
  // 只记最后一次会漏掉大头
  let promptTokens = 0;
  let completionTokens = 0;
  let sawUsage = false;
  let calls = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    const isLastRound = round === maxRounds - 1;
    const completion = await collectCompletionWithTools(
      provider,
      conversation,
      {
        ...options.params,
        tools: ADMIN_TOOLS,
        // 最后一轮不再允许调用工具：必须给用户一个交代，而不是继续起草
        toolChoice: isLastRound ? 'none' : 'auto',
      },
      options.signal,
    );
    const { text, toolCalls } = completion;
    calls += 1;
    if (completion.usage !== null) {
      sawUsage = true;
      promptTokens += completion.usage.promptTokens ?? 0;
      completionTokens += completion.usage.completionTokens ?? 0;
    }

    if (text !== '') {
      fullText += text;
      yield { type: 'text', text };
    }

    if (isLastRound || toolCalls.length === 0) break;

    conversation.push({ role: 'assistant', content: text, toolCalls });

    for (const call of toolCalls) {
      const execution = await runToolCall(call, context, options.execute);
      executions.push(execution);
      conversation.push({ role: 'tool', toolCallId: call.id, content: execution.result });
      yield { type: 'tool', execution };
    }
  }

  const usage: TokenUsage | null = sawUsage ? { promptTokens, completionTokens } : null;
  yield { type: 'done', text: fullText, executions, usage, calls };
}

async function runToolCall(
  call: ChatToolCall,
  context: AdminToolContext,
  execute: (draft: AdminDraft) => Promise<string>,
): Promise<AdminToolExecution> {
  const parsed = parseAdminToolCall(call, context);

  if (!parsed.ok) {
    return {
      callId: call.id,
      toolName: call.function.name,
      result: `调用失败：${parsed.error}`,
      draft: null,
      ok: false,
    };
  }

  try {
    const result = await execute(parsed.draft);
    return {
      callId: call.id,
      toolName: call.function.name,
      result,
      draft: parsed.draft,
      ok: true,
    };
  } catch (error) {
    return {
      callId: call.id,
      toolName: call.function.name,
      result: `执行失败：${error instanceof Error ? error.message : String(error)}`,
      draft: parsed.draft,
      ok: false,
    };
  }
}
