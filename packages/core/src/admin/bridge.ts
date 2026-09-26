import type { ChatMessage, ChatToolCall, ToolDefinition } from '../prompt/types.js';
import { type AdminPromptInput, buildAdminMessages } from './prompt.js';
import { ADMIN_TOOLS } from './tools.js';

/**
 * 世界管理员的网页版桥接（没有 API Key 时的副对话）。
 *
 * 主对话的桥接很直白：模型说的那段话，用户贴回来就是了。管理员不行——它**要调用工具**，
 * 而网页版没有工具接口（没有 `tool_calls`）。所以这里的办法是：**让网页版用文本写工具调用**，
 * 我们按同一套校验逻辑解析出来。
 *
 * 三条设计约束：
 *
 * 1. **校验只有一份**：解析出来的东西包成 `ChatToolCall` 之后，仍然走 `parseAdminToolCall`
 *    ——参数缺失、cardId 不存在这些判断与 API 那条路逐字相同，不另写一套。
 * 2. **一次贴回**：API 那条路会「调用 → 回填 → 再说话」跑最多三轮，网页版让用户贴三次
 *    是不能接受的。所以要求它**一次把该做的都写成多个 JSON 块**，最后再给一段自然语言。
 * 3. **错了也不丢**：认不出的块单独报给用户看（`invalid`），不静默吞掉——
 *    用户至少知道「它想干点什么，但格式没写对」。
 */

/** 一次桥接回合解析出来的东西。 */
export interface AdminBridgeOutput {
  /** 认出来、并已包装成工具调用的块（顺序与出现顺序一致）。 */
  calls: ChatToolCall[];
  /** 认不出来的代码块原文（给用户看，不静默丢）。 */
  invalid: string[];
  /** 去掉 JSON 块之后剩下的自然语言。 */
  answer: string;
}

interface SchemaLike {
  type?: unknown;
  enum?: unknown;
  description?: unknown;
  properties?: unknown;
  items?: unknown;
  required?: unknown;
}

function describeFields(schema: SchemaLike, indent: string): string[] {
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null) return [];

  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(properties as Record<string, SchemaLike>).flatMap(([name, field]) => {
    const type = typeof field.type === 'string' ? field.type : 'any';
    const options = Array.isArray(field.enum) ? `（取 ${field.enum.map(String).join(' / ')}）` : '';
    const note = typeof field.description === 'string' ? `：${field.description}` : '';
    const line = `${indent}- ${name}${required.has(name) ? '（必填）' : ''}${type === 'any' ? '' : ` <${type}>`}${options}${note}`;

    /*
     * 嵌套对象/数组要展开一层：世界书的 entries 是「整本替换」的，
     * 不把条目里有哪些字段写清楚，模型就会漏掉 content 或 keys。
     */
    const nested = type === 'array' ? (field.items as SchemaLike | undefined) : type === 'object' ? field : undefined;
    const nestedLines = nested === undefined ? [] : describeFields(nested, `${indent}    · `.replace('    ', '  '));
    return [line, ...nestedLines];
  });
}

function describeParameters(tool: ToolDefinition): string {
  const lines = describeFields(tool.function.parameters as SchemaLike, '  ');
  return lines.length === 0 ? '（无参数）' : lines.join('\n');
}

/** 把工具表渲染成人话（网页版没有工具接口，只能靠这段文字告诉它有哪些事可做）。 */
export function describeAdminTools(tools: readonly ToolDefinition[] = ADMIN_TOOLS): string {
  return tools
    .map((tool) => [`### ${tool.function.name}`, tool.function.description, describeParameters(tool)].join('\n'))
    .join('\n\n');
}

/**
 * 给网页版的补充指令。
 *
 * 它必须**推翻**原提示词里那句「直接调用工具，不要在正文里贴 JSON」——所以这段话放在
 * 最后（离用户那句话最近），并且把这件事说成「这次没有工具接口，换一种写法」。
 */
export function buildAdminBridgeInstructions(tools: readonly ToolDefinition[] = ADMIN_TOOLS): string {
  return [
    '【本次的特殊说明】这次你没有工具接口可以用（对面是网页版），所以要把「调用工具」改写成文本：',
    '',
    '1. 要做下面这几件事时，**每件事单独输出一个 ```json 代码块**，块里只有一行 JSON：',
    '   {"tool":"工具名","arguments":{...}}',
    '2. 一次可以做多件事——那就输出多个代码块，先后顺序按你希望的执行顺序。',
    '3. 代码块之外，用自然语言说清：你打算做什么、做了什么、要用户确认什么。',
    '4. 不要输出别的代码块，不要在 JSON 里写注释，不要写多余的解释。',
    '',
    '可用的事（就是原来的五个工具）：',
    '',
    describeAdminTools(tools),
  ].join('\n');
}

/** 管理员的网页版提示词 = 原来的提示词 + 上面那段特殊说明。 */
export function buildAdminBridgeMessages(
  input: AdminPromptInput,
  tools: readonly ToolDefinition[] = ADMIN_TOOLS,
): ChatMessage[] {
  return [...buildAdminMessages(input), { role: 'system', content: buildAdminBridgeInstructions(tools) }];
}

/** 从一段文本里挑出所有「像 JSON 对象」的片段（大括号配对，容忍前后有散文）。 */
function jsonCandidates(text: string): { raw: string; start: number; end: number }[] {
  const found: { raw: string; start: number; end: number }[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          found.push({ raw: text.slice(index, cursor + 1), start: index, end: cursor + 1 });
          index = cursor;
          break;
        }
      }
    }
  }
  return found;
}

/** 所有 json 代码围栏（```json … ``` 或不写语言的 ``` … ```）覆盖的区间。 */
function fencedRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;
  for (let match = fence.exec(text); match !== null; match = fence.exec(text)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

/**
 * 一块 JSON 想表达什么：`{"tool":"名字","arguments":{…}}`，也容忍几种常见变体。
 *
 * 审计 C15：变体（`name` / `tool_name` / `function.name`）**只在 json 代码围栏里**才认。
 * 以前正文里任何带 `name` 字段的 JSON（比如管理员随口举例 `{"name":"秦娘"}`）
 * 都会被当成一次工具调用、被挖出正文、还被报成「认不出的工具」。
 * 带 `tool` 字段的照旧在哪儿都认——那是提示词里约定的写法，正文里不会碰巧出现。
 */
function toolCallOf(candidate: unknown, index: number, fenced: boolean): ChatToolCall | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  if (typeof record.tool !== 'string' && !fenced) return null;

  const name =
    typeof record.tool === 'string'
      ? record.tool
      : typeof record.name === 'string'
        ? record.name
        : typeof record.tool_name === 'string'
          ? record.tool_name
          : typeof record.function === 'object' && record.function !== null
            ? (record.function as { name?: unknown }).name
            : null;
  if (typeof name !== 'string' || name.trim() === '') return null;

  const argsSource =
    record.arguments ?? record.parameters ?? (record.function as { arguments?: unknown } | undefined)?.arguments ?? {};
  const args = typeof argsSource === 'string' ? argsSource : JSON.stringify(argsSource ?? {});

  return {
    id: `bridge-${String(index)}`,
    type: 'function',
    function: { name: name.trim(), arguments: args },
  };
}

/**
 * 解析网页版贴回来的东西。
 *
 * 顺序：先摘出所有「像 JSON 对象」的片段，能构成工具调用的收进 `calls`，其余保持不动
 * （它们可能只是正文里的一小段 JSON，不该被当成工具）。最后把收走的那几段从正文里挖掉，
 * 剩下的就是管理员要对用户说的话。
 */
export function parseAdminBridgeOutput(text: string): AdminBridgeOutput {
  const candidates = jsonCandidates(text);
  const fences = fencedRanges(text);
  const calls: ChatToolCall[] = [];
  const invalid: string[] = [];
  const consumed: { start: number; end: number }[] = [];

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.raw);
    } catch {
      continue; // 不是合法 JSON：当正文处理，别惊动用户
    }

    const fenced = fences.some((range) => candidate.start >= range.start && candidate.end <= range.end);
    const call = toolCallOf(parsed, calls.length, fenced);
    if (call === null) continue;

    calls.push(call);
    consumed.push({ start: candidate.start, end: candidate.end });
  }

  // 认得出「这是一次工具调用」但名字不在表里的，单独拎出来告诉用户
  for (const call of calls) {
    if (!ADMIN_TOOLS.some((tool) => tool.function.name === call.function.name)) {
      invalid.push(call.function.name);
    }
  }

  let answer = '';
  let cursor = 0;
  for (const range of consumed.sort((left, right) => left.start - right.start)) {
    answer += text.slice(cursor, range.start);
    cursor = range.end;
  }
  answer += text.slice(cursor);

  return {
    calls,
    invalid,
    // 去掉围栏残留（```json / ```）与多余空行，正文读起来才顺
    answer: answer
      .replace(/```[a-zA-Z]*\s*```/g, '')
      .split('\n')
      .filter((line, index, lines) => line.trim() !== '' || (index > 0 && lines[index - 1]?.trim() !== ''))
      .join('\n')
      .trim(),
  };
}
