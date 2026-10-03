import type { Card, Persona } from '@dramatis/core';
import { importCardFromJson, importCardFromPng, parseWorldBook } from '@dramatis/core';
import { useCallback } from 'react';
import type { LibraryItemKind } from '../lib/library-transfer';
import type { SessionApi } from '../lib/session';
import type { Notice } from './useNotices';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export function looksLikePng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}
function looksLikeWorldBook(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'entries' in value;
}

export type LibraryImportResult = { ok: true; kind: LibraryItemKind; id: string } | { ok: false; error: string };
export interface UseImportOptions {
  session: SessionApi;
  activePersona: Persona | null;
  setError: (message: string | null) => void;
  setWarnings: (next: Notice[]) => void;
  onImported: () => void;
}

/** Conversation mode keeps the established immediate-use flow; library mode only saves materials. */
export function useImport({ session, activePersona, setError, setWarnings, onImported }: UseImportOptions): {
  handleImport: (file: File, mode?: 'conversation' | 'library') => Promise<LibraryImportResult>;
} {
  const handleImport = useCallback(
    async (file: File, mode: 'conversation' | 'library' = 'conversation'): Promise<LibraryImportResult> => {
      setError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let cardResult: { card: Card; warnings: Notice[] };
        if (looksLikePng(bytes)) {
          cardResult = await importCardFromPng(bytes, file.name);
        } else {
          const text = new TextDecoder('utf-8').decode(bytes);
          const parsed = JSON.parse(text) as unknown;
          const { parseNativeLibraryFile } = await import('../lib/library-transfer');
          const native = parseNativeLibraryFile(parsed);
          if (native?.kind === 'personas') {
            await session.savePersona(native.item);
            setWarnings([]);
            return { ok: true, kind: native.kind, id: native.item.id };
          }
          if (native?.kind === 'worldbooks' || (native === null && looksLikeWorldBook(parsed))) {
            const result =
              native?.kind === 'worldbooks'
                ? { book: native.item, warnings: [] }
                : parseWorldBook(parsed, file.name.replace(/\.json$/i, ''));
            await session.saveWorldBook(result.book);
            setWarnings(result.warnings);
            return { ok: true, kind: 'worldbooks', id: result.book.id };
          }
          cardResult =
            native?.kind === 'cards' ? { card: native.item, warnings: [] } : importCardFromJson(text, file.name);
        }
        await session.saveCard(cardResult.card);
        setWarnings(cardResult.warnings);
        if (mode === 'conversation') {
          if (session.world === null)
            await session.createWorld({
              title: cardResult.card.name,
              persona: activePersona,
              cards: [cardResult.card],
            });
          onImported();
        }
        if (cardResult.card.embeddedWorldBook !== null) {
          const { book } = parseWorldBook(cardResult.card.embeddedWorldBook, `${cardResult.card.name} 的内嵌世界书`);
          await session.saveWorldBook(book);
          if (mode === 'conversation') await session.attachWorldBook(book);
        }
        return { ok: true, kind: 'cards', id: cardResult.card.id };
      } catch (importError) {
        const error = importError instanceof Error ? importError.message : String(importError);
        setError(error);
        return { ok: false, error };
      }
    },
    [activePersona, onImported, session, setError, setWarnings],
  );
  return { handleImport };
}
