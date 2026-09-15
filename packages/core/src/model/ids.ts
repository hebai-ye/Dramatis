/**
 * 带品牌（brand）的 ID 类型。
 *
 * 设计文档 §2.1 要求角色卡与角色实例严格分离，两者都是字符串 ID。
 * 用品牌类型可以让编译器替我们拦住「把 CardId 当 InstanceId 用」这类错误。
 */
declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type CardId = Brand<string, 'CardId'>;
export type InstanceId = Brand<string, 'InstanceId'>;
export type RoomId = Brand<string, 'RoomId'>;
export type SceneId = Brand<string, 'SceneId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type EventId = Brand<string, 'EventId'>;
export type WorldBookId = Brand<string, 'WorldBookId'>;

/** 关系边的目标：另一名角色，或玩家本人。 */
export const PLAYER = 'player' as const;
export type RelationshipTarget = InstanceId | typeof PLAYER;

export const cardId = (value: string): CardId => value as CardId;
export const instanceId = (value: string): InstanceId => value as InstanceId;
export const roomId = (value: string): RoomId => value as RoomId;
export const sceneId = (value: string): SceneId => value as SceneId;
export const messageId = (value: string): MessageId => value as MessageId;
export const eventId = (value: string): EventId => value as EventId;
export const worldBookId = (value: string): WorldBookId => value as WorldBookId;

/** 生成新的实体 ID。浏览器与 Node 20+ 均提供 `crypto.randomUUID`。 */
export function newId(): string {
  return crypto.randomUUID();
}

/** 当前时间的 ISO 字符串，集中一处便于将来统一时钟源。 */
export function nowIso(): string {
  return new Date().toISOString();
}
