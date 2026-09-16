import type { CharacterInstance } from '../model/instance.js';
import type { Scene } from '../model/room.js';

/**
 * 场景切换的旁白（LAYOUT「输入区 · 场景」）。
 *
 * 切换场景产生一条**无气泡、无角色归属**的动作记录，形如
 * 「××× 与 ××× 进入了 ×××」。它记录的是「谁跟谁去了哪里」，
 * 而不是谁说的话——所以既不是任何角色的台词，也不该被当成旁白解释剧情。
 */
export interface SceneTransitionInput {
  next: Scene;
  /** 新场景里的成员，用于算出「谁跟谁」。 */
  members: readonly CharacterInstance[];
}

function describePlace(scene: Scene): string {
  const title = scene.title.trim();
  const location = scene.location.trim();
  if (title !== '' && location !== '' && title !== location) return `${title}（${location}）`;
  if (title !== '') return title;
  if (location !== '') return location;
  return '新的场景';
}

/** 「A」「A 与 B」「A、B 与 C」 */
export function joinNames(names: readonly string[]): string {
  const list = names.map((name) => name.trim()).filter((name) => name !== '');
  if (list.length === 0) return '';
  if (list.length === 1) return list[0] ?? '';
  return `${list.slice(0, -1).join('、')} 与 ${list.at(-1) ?? ''}`;
}

export function buildSceneTransitionNarration(input: SceneTransitionInput): string {
  const place = describePlace(input.next);
  const names = joinNames(input.members.map((member) => member.displayName));
  return names === '' ? `场景切换到 ${place}` : `${names} 进入了 ${place}`;
}

/**
 * 谁「跟着换了场」。
 *
 * 留在原场景的人也被算进来：这条旁白的用途是记录新的「谁跟谁在哪里」，
 * 而不是记录队伍增减。只有在新场景里一个人都没有时才退化成地点描述。
 */
export function selectSceneMembers(members: readonly CharacterInstance[], scene: Scene): CharacterInstance[] {
  const inCast = members.filter((member) => scene.cast.includes(member.id));
  return inCast.length > 0 ? inCast : [];
}
