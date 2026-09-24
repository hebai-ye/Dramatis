import { useCallback, useSyncExternalStore } from 'react';

/**
 * 一轮生成的流式状态（顺序 59）。
 *
 * 为什么不放在 App 的 `useState` 里：每个 token 到达都 `setState` 一次，而 App 是整棵树的根——
 * 五个 hook 的返回对象又都是每次渲染新造的字面量，于是每个 token 都让左栏、世界树、
 * 角色栏、运行时面板和几百条消息全部重渲染一遍。长对话里这就是「越聊越卡」。
 *
 * 现在它是一个组件树之外的小 store：`runGeneration` 直接写它，**只有流式气泡订阅**
 * （`useSyncExternalStore`），每个 token 只 commit 那一个气泡。
 */
export type StreamPhase = 'idle' | 'planning' | 'writing';

/**
 * 两条互不干扰的流式通道。
 *
 * `main` 是主对话，`admin` 是副对话（世界管理员）。副对话的流式**以前也住在 App 里**
 * （`useAdminChat` 的 `streamText`），所以那条路同样每个 token 都重画整棵树——
 * 拆成两条通道之后，谁在流式就只重画谁的气泡：主对话几百条消息时开副对话起草素材，
 * 主对话一条也不会动。
 */
export type StreamScope = 'main' | 'admin';

export interface StreamState {
  /** 正在流出来的正文。 */
  text: string;
  /** 正在说话的角色名。 */
  speaker: string;
  /** 推理模型先流出来的那段盘算。 */
  reasoning: string;
  /**
   * 这一轮正在做什么：生成之前还有一次「谁开口」的便宜调用，推理模型会先流一段推理流，
   * 没有阶段名的话用户看到的是「气泡一直空着，过一会儿整段话砸下来」。
   */
  phase: StreamPhase;
}

const IDLE: StreamState = { text: '', speaker: '', reasoning: '', phase: 'idle' };

interface Channel {
  state: StreamState;
  listeners: Set<() => void>;
}

const CHANNELS: Record<StreamScope, Channel> = {
  main: { state: IDLE, listeners: new Set() },
  admin: { state: IDLE, listeners: new Set() },
};

export function getStreamState(scope: StreamScope = 'main'): StreamState {
  return CHANNELS[scope].state;
}

/** 改几个字段；一个字段都没变时不通知，订阅者也就不会白白重渲染。 */
export function setStreamState(scope: StreamScope, patch: Partial<StreamState>): void {
  const channel = CHANNELS[scope];
  const next: StreamState = { ...channel.state, ...patch };
  if (
    next.text === channel.state.text &&
    next.speaker === channel.state.speaker &&
    next.reasoning === channel.state.reasoning &&
    next.phase === channel.state.phase
  ) {
    return;
  }
  channel.state = next;
  for (const listener of channel.listeners) listener();
}

/** 一轮结束（或开始前）清空。 */
export function resetStreamState(scope: StreamScope = 'main'): void {
  setStreamState(scope, IDLE);
}

export function subscribeStream(scope: StreamScope, listener: () => void): () => void {
  const channel = CHANNELS[scope];
  channel.listeners.add(listener);
  return () => {
    channel.listeners.delete(listener);
  };
}

/**
 * 订阅整份流式状态。**只该在真正要画它的那个组件里用**——
 * 多一个订阅者就多一条每个 token 都要重画的路径。
 *
 * `subscribe` / `getSnapshot` 用 `useCallback` 盯住 `scope`：每次渲染新造闭包会让
 * React 每轮都退订再订阅一遍。
 */
export function useStreamState(scope: StreamScope = 'main'): StreamState {
  const subscribe = useCallback((listener: () => void) => subscribeStream(scope, listener), [scope]);
  const snapshot = useCallback(() => getStreamState(scope), [scope]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
