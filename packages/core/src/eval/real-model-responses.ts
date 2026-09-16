/**
 * 真实模型的回答记录（ROADMAP P1-10 的人工验证部分）。
 *
 * 这里存的是**原样粘贴**的模型输出，用来做两件事：
 * 1. 让「模型的输出能不能被解析」变成可重跑的断言，而不是一次性的目测
 * 2. 给提示词的每次改动留一份对照——改了提示词就重跑一次，贴回新的输出
 *
 * 空字符串表示这一项还没验证，对应的断言会自动跳过。
 */
export interface RealModelResponses {
  /** ① 主对话：角色扮演回合的完整回答。 */
  roleplay: string;
  /** ② 记忆抽取的完整回答（应当只有一个 JSON 对象）。 */
  extraction: string;
  /** ③ 情绪与关系推演的完整回答。 */
  affect: string;
  /** ④ 副对话：模型请求调用的工具与它的参数。 */
  toolCall: { name: string; arguments: string } | null;
}

export const REAL_MODEL_RESPONSES: RealModelResponses = {
  roleplay: '',
  extraction: '',
  affect: '',
  toolCall: null,
};
