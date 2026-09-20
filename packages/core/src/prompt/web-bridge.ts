import type { ChatMessage } from './types.js';

/**
 * 网页版桥接（没有 API Key 时的第一条路）。
 *
 * 第一次打开这个应用的人手里多半没有 API Key：他要先注册、充值、建 Key，才能
 * 让角色开口说第一句话。这道门槛挡住的正是「先看看这东西好不好玩」这件事。
 * 所以没配 Key 的时候，应用不再只报一句「还没有填 API Key」，而是把**它本来就要
 * 发出去的那段提示词**原样交给你：你贴进 DeepSeek 的网页版，再把回复粘回来。
 *
 * 这条路不新造提示词——`renderPromptForWeb` 的格式与 eval 里那份「取样器」
 * （`pnpm --filter @dramatis/core test prompt-samples`）**逐字一致**：P1-10 的真模型
 * 验证就是用这个格式贴进网页版跑的。同一种贴法，验证过的行为与用户看到的一致。
 */

/** 网页版桥接指向哪儿。只放地址，不放任何私有信息。 */
export const WEB_BRIDGE_TARGET = {
  name: 'DeepSeek 网页版',
  url: 'https://chat.deepseek.com/',
  hint: '登录后把提示词整段贴进输入框，回车。',
} as const;

/**
 * 把装配好的消息渲染成一段可以整段复制的文本。
 *
 * 用 `--- role: x ---` 分隔而不是丢掉角色信息：网页版只有一个输入框，
 * 但把「这是系统指令、这是玩家刚说的话」写在文本里，模型的遵守程度明显更好——
 * 这正是 P1-10 第一轮验证过的那种贴法。
 */
export function renderPromptForWeb(messages: readonly ChatMessage[]): string {
  return messages.map((message) => `--- role: ${message.role} ---\n${message.content}`).join('\n\n');
}

/**
 * 清洗粘回来的回复。
 *
 * 只做两件**无损**的事：去掉首尾空白、把整段包住的代码围栏脱掉（网页版偶尔会把
 * 回复放进 ``` 里）。其余一个字都不动——**模型写的就是角色说的话**，
 * 在这里「顺手修一下格式」等于篡改台词；真正需要清理的转写标记由
 * `createCharacterMessage` 的 `sanitizeCharacterContent` 统一处理。
 */
export function cleanPastedReply(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

/** 这一轮该不该走网页版桥接：没有可用的 Key 就是。 */
export function needsWebBridge(apiKey: string | null | undefined): boolean {
  return (apiKey ?? '').trim() === '';
}
