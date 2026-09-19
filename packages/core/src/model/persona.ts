import { newId, nowIso } from './ids.js';

/**
 * 玩家身份（ROADMAP P0-3）。
 *
 * 一份 persona 描述「你在这个世界里是谁」，可以跨房间复用；
 * 房间通过 `personaId` 引用其中一份。
 */
export interface Persona {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  /** 软删除墓碑（P2-6）。 */
  deletedAt: string | null;
}

export function createPersona(input: { name: string; description?: string }): Persona {
  const now = nowIso();
  return {
    id: newId(),
    name: input.name.trim() === '' ? '玩家' : input.name.trim(),
    description: input.description ?? '',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}
