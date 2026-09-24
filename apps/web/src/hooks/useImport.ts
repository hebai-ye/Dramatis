import type { Persona } from '@dramatis/core';
import { importCardFromJson, importCardFromPng, parseWorldBook } from '@dramatis/core';
import { useCallback } from 'react';
import type { SessionApi } from '../lib/session';
import type { Notice } from './useNotices';

/** PNG 的魔数（顺序 66 从 App.tsx 搬出来，只给导入这条路用）。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function looksLikePng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/** 世界书与角色卡都是 JSON，用有没有 `entries` 来区分。 */
function looksLikeWorldBook(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'entries' in value;
}

export interface UseImportOptions {
  session: SessionApi;
  /** 导入后要开新世界线时用它当玩家身份。 */
  activePersona: Persona | null;
  setError: (message: string | null) => void;
  setWarnings: (next: Notice[]) => void;
  /** 手机上导完就把左抽屉收起来（抽屉正盖着刚开出来的那条线）。 */
  onImported: () => void;
}

/**
 * 导入素材（顺序 66 从 App.tsx 搬出来）。
 *
 * 一条路吃三种文件：PNG 角色卡（`chara` / `ccv3`）、JSON 角色卡（V1/V2/V3）、
 * JSON 世界书（`world_info`）。导入即入库；本机一张卡都没有时顺手开一条新世界线，
 * 省掉「导完还要再点一次新对话」那一步。
 */
export function useImport({ session, activePersona, setError, setWarnings, onImported }: UseImportOptions): {
  handleImport: (file: File) => Promise<void>;
} {
  const handleImport = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());

        if (!looksLikePng(bytes)) {
          const text = new TextDecoder('utf-8').decode(bytes);
          const parsed = JSON.parse(text) as unknown;

          if (looksLikeWorldBook(parsed)) {
            const { book, warnings: bookWarnings } = parseWorldBook(parsed, file.name.replace(/\.json$/i, ''));
            await session.saveWorldBook(book);
            setWarnings(bookWarnings);
            return;
          }
        }

        const result = looksLikePng(bytes)
          ? await importCardFromPng(bytes, file.name)
          : importCardFromJson(new TextDecoder('utf-8').decode(bytes), file.name);

        // 先入库，再决定要不要马上用
        await session.saveCard(result.card);
        setWarnings(result.warnings);

        // 一张卡都没有的时候，导入即开一条新世界线，省掉一步
        if (session.world === null) {
          await session.createWorld({ title: result.card.name, persona: activePersona, cards: [result.card] });
        }
        onImported();

        if (result.card.embeddedWorldBook !== null) {
          const { book } = parseWorldBook(result.card.embeddedWorldBook, `${result.card.name} 的内嵌世界书`);
          await session.saveWorldBook(book);
          await session.attachWorldBook(book);
        }
      } catch (importError) {
        setError(importError instanceof Error ? importError.message : String(importError));
      }
    },
    [activePersona, onImported, session, setError, setWarnings],
  );

  return { handleImport };
}
