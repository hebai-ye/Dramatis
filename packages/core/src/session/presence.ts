import type { InstanceId } from '../model/ids.js';
import { nowIso } from '../model/ids.js';
import type { CharacterInstance, Presence } from '../model/instance.js';
import type { Scene } from '../model/room.js';

/**
 * 把角色的存在状态对齐到场景名单（T10）。
 *
 * 问题的来源：`presence` 是世界级的（「他在这个世界的哪里」），名单是场景级的
 * （「他此刻在这场戏里」）。两者脱节时会出现「右边栏说在场、标题栏名单里却没有他」
 * 这种自相矛盾的界面；五十回合长跑里还真的发生过——秦娘明明说要留下看店，
 * 换场却把她一起带走了，之后她就站在货栈门口发言。
 *
 * 定下来的规则很简单：**名单是权威，presence 跟着名单走。**
 *
 * - 在名单里：`offscreen` → `onstage`（进名单就是上台）；`muted` 保持沉默；
 *   `absent` 保持离场（用户明确说过他退出这条世界线，不该被名单复活）
 * - 不在名单里：`onstage` / `muted` → `offscreen`（人不在场上，但时间仍在流逝）
 *
 * 返回变化过的实例，没变化的不返回——调用方据此决定写库多少条。
 */
export function syncPresenceForScene(
  instances: readonly CharacterInstance[],
  scene: Scene,
  at: string = nowIso(),
): CharacterInstance[] {
  const inCast = new Set<InstanceId>(scene.cast);
  const changed: CharacterInstance[] = [];

  for (const instance of instances) {
    const next = nextPresence(instance.presence, inCast.has(instance.id));
    if (next === instance.presence) continue;
    changed.push({ ...instance, presence: next, updatedAt: at });
  }

  return changed;
}

function nextPresence(presence: Presence, cast: boolean): Presence {
  if (cast) {
    if (presence === 'offscreen') return 'onstage';
    return presence;
  }

  if (presence === 'onstage' || presence === 'muted') return 'offscreen';
  return presence;
}

/** 换场时的默认同行名单：此刻在场上的人。 */
export function defaultTravelCast(scene: Scene | null, instances: readonly CharacterInstance[]): InstanceId[] {
  const candidateIds = scene?.cast ?? instances.map((instance) => instance.id);
  return candidateIds.filter((id) => {
    const instance = instances.find((item) => item.id === id);
    if (!instance) return false;
    return instance.presence === 'onstage' || instance.presence === 'muted';
  });
}
