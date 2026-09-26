import { describe, expect, it } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { PLAYER, roomId } from '../model/ids.js';
import { INITIAL_PLAYER_AFFINITY } from '../model/instance.js';
import { createPersona } from '../model/persona.js';
import { createInstanceFor, createWorldFromCard } from './setup.js';

/**
 * 顺序 89（用户 2026-09-26 裁定）：角色对玩家的初始好感是 40%。
 *
 * 这条断言的意义是「别再掉回 0」：用户的原话是「角色的攻击性与警惕性太强」，
 * 而 0 好感在提示词里就是「陌生人，警惕」。所以每个新实例、每条新世界
 * 都必须从这个起点出发——`INITIAL_PLAYER_AFFINITY` 与这套断言一起看。
 */
describe('顺序 89：新实例的初始好感', () => {
  it('每个新实例对玩家都是 0.4，其它维度仍是 0，且没有伪造历史', () => {
    const card = createBlankCard({ name: '林晚' });
    const instance = createInstanceFor(card, roomId('room-1'));

    expect(instance.relationships).toHaveLength(1);
    const edge = instance.relationships[0];
    expect(edge?.target).toBe(PLAYER);
    expect(edge?.affinity).toBe(INITIAL_PLAYER_AFFINITY);
    expect(edge?.trust).toBe(0);
    expect(edge?.fear).toBe(0);
    expect(edge?.respect).toBe(0);
    expect(edge?.tension).toBe(0);
    // 「从没被谁改过」是迁移判定老数据的依据，新实例必须保持空
    expect(edge?.history).toEqual([]);
  });

  it('开新世界也走同一条口径', () => {
    const card = createBlankCard({ name: '林晚' });
    const persona = createPersona({ name: '玩家' });

    const world = createWorldFromCard(card, persona);

    expect(world.instance.relationships[0]?.affinity).toBe(INITIAL_PLAYER_AFFINITY);
  });
});
