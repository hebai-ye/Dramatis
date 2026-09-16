/**
 * 世界的构造。
 *
 * 这些构造器原本住在 Web 端，现在移进了内核——它们只依赖内核模型，
 * 而且「新对话怎么派生实例」这条规则既影响存储又影响 prompt，
 * 放在两端各写一遍迟早会分叉（比如两边对「同一个角色会不会被派生两份」
 * 给出不同答案）。这里只做转出，方便组件继续从同一个地方引用。
 */
export {
  createInstanceFor,
  createSceneFor,
  createWorldFromCard,
  type NewConversationPlan,
  planNewConversation,
  type World,
} from '@dramatis/core';
