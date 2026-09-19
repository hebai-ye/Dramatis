export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** 模型请求调用某个工具（OpenAI 兼容协议里的 tool_call）。 */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** 未解析的 JSON 字符串，由执行方负责校验。 */
    arguments: string;
  };
}

/** 可用工具的声明，直接对应接口的 `tools` 字段。 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant 消息里请求调用的工具。 */
  toolCalls?: ChatToolCall[];
  /** role 为 tool 时的对应请求 id。 */
  toolCallId?: string;
}

export type PromptBlockKind =
  | 'system'
  | 'worldbook'
  | 'persona'
  | 'relationship'
  | 'memory'
  /** 分层摘要滚出来的前情（P1-5）：自成一节，不与召回记忆合并。 */
  | 'chapter'
  | 'scene'
  | 'history'
  | 'instruction'
  /** 动作写法的现场示范。可选：预算紧张时最先被丢。 */
  | 'format'
  | 'player';

/** 历史消息块还原成对话消息所需的角色信息。 */
export interface HistoryMessageRef {
  role: 'user' | 'assistant';
  speakerName: string;
}

/**
 * Prompt 的装配单元（设计文档 §6）。
 *
 * 每个块自带优先级与降级信息，预算守卫只依据这些字段工作，
 * 不需要了解具体是哪一层记忆。
 */
export interface PromptBlock {
  id: string;
  kind: PromptBlockKind;
  /** 渲染成 `### label` 的小节标题。 */
  label: string;
  content: string;
  /** 越大越不可丢弃。 */
  priority: number;
  /** 能否被整体丢弃。 */
  droppable: boolean;
  /** 降级时替换用的压缩版本。 */
  compressed?: string;
  /** 同类块内的新旧顺序，越小越旧、越先丢弃。 */
  sequence?: number;
  /** 召回分数 0~1，越低越先丢弃。 */
  score?: number;
  /** 仅历史消息块携带。 */
  message?: HistoryMessageRef;
}

/** 预算降级的阶段，按设计文档 §4.6 的顺序执行。 */
export type BudgetStage =
  | 'drop-history'
  | 'drop-memory'
  | 'compress-relationship'
  | 'compress-persona'
  | 'drop-lowest-priority';

export interface DroppedBlock {
  id: string;
  label: string;
  kind: PromptBlockKind;
  tokens: number;
  stage: BudgetStage;
}

export interface BudgetReport {
  maxTokens: number;
  usedTokens: number;
  /** 实际触发过的降级阶段。为空表示预算充裕。 */
  stages: BudgetStage[];
  dropped: DroppedBlock[];
  compressed: string[];
  /** 走完所有阶段后是否仍在预算内。 */
  fits: boolean;
}
