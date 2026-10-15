import type { AdminToolExecution } from '../../../../packages/core/src/admin/turn';
import type { Card, WorldBook } from '../../../../packages/core/src/model/card';
import type { CharacterInstance } from '../../../../packages/core/src/model/instance';
import type { Message } from '../../../../packages/core/src/model/message';
import type { Persona } from '../../../../packages/core/src/model/persona';
import type { Room, Scene } from '../../../../packages/core/src/model/room';
import type { ChatMessage, ChatToolCall, ToolDefinition } from '../../../../packages/core/src/prompt/types';
import type { TokenUsage } from '../../../../packages/core/src/provider/openai-compatible';

export type Family = 'roleplay' | 'extraction' | 'affect' | 'admin';
export interface QualityExecutionProfile {
  profileId: 'deepseek-flash-low-output-1200-v1' | 'deepseek-flash-low-output-4096-v1';
  maxOutputTokens: 1200 | 4096;
  model: 'deepseek-flash';
  reasoningEffort: 'low';
}
export interface QualityExecutionOptions {
  executionProfile?: QualityExecutionProfile;
  /** Require proxy provenance for live pages, including legacy 1200 execution. */
  requireServerEvidence?: boolean;
}
export interface FixtureInput {
  card?: Card;
  cards?: readonly Card[];
  worldBooks?: readonly WorldBook[];
  personas?: readonly Persona[];
  instance?: CharacterInstance;
  cast?: readonly CharacterInstance[];
  room?: Room;
  scene?: Scene | null;
  history?: readonly Message[];
  messages?: readonly Message[];
  playerName?: string;
  playerInput?: string;
  userInput?: string;
}
export interface QualityFixture {
  caseId: string;
  family: Family;
  input?: FixtureInput;
  source?: string;
  commit?: string;
  fixtureHash?: string;
  requestHash?: string;
  request: { messages: ChatMessage[]; tools: readonly ToolDefinition[]; params?: Record<string, unknown> };
}
export interface WireMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  /** Transport only; scrubbed before storing any evidence. */
  reasoning_content?: string;
}
export interface WireRequest extends Record<string, unknown> {
  model: string;
  messages: WireMessage[];
  stream: boolean;
  tools?: ToolDefinition[];
  tool_choice?: string;
  max_tokens?: number;
  reasoning_effort?: string;
  stream_options?: { include_usage: boolean };
}
export interface RoundEvidence {
  round: number;
  text: string;
  toolCalls: ChatToolCall[];
  usage: TokenUsage | null;
  error: string | null;
  /** Selected execution parameters, independent of the frozen fixture requestHash. */
  executionProfile?: QualityExecutionProfile;
  /** Proxy-reported digest of its actual upstream JSON; never inferred from the client wire. */
  upstreamWireHash?: string;
  upstreamWireHashMeaning?: string;
  wire?: WireRequest;
  wireHash?: string;
  exportedWireHash?: string;
  wireRedacted?: boolean;
  wireHashMeaning?: string;
}
export interface QualityResult {
  caseId: string;
  fixtureHash?: string;
  requestHash?: string;
  text: string;
  toolCalls: ChatToolCall[];
  usage: { promptTokens: number; completionTokens: number } | null;
  rounds: RoundEvidence[];
  parse: unknown;
  error: string | null;
  admin?: { calls: number; executions: AdminToolExecution[] };
}
