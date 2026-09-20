import {
  buildConversationTranscript,
  buildWorldArchive,
  countArchive,
  importWorldArchive,
  parseWorldArchive,
  type RoomId,
  suggestTranscriptName,
} from '@dramatis/core';
import { useCallback, useMemo } from 'react';
import type { DramatisDb } from './db';
import { createBrowserFileIO } from './fileio';
import type { ConversationBundle } from './session';

/** 导出/导入的结果，交给界面如实显示。 */
export interface ArchiveOutcome {
  ok: boolean;
  message: string;
}

export interface ArchiveApi {
  /** 把这个世界导出成一个文件；用户取消保存时返回 null。 */
  exportWorld: (roomId: RoomId) => Promise<ArchiveOutcome | null>;
  /** 选一个封存文件导进来（永远是新建一个世界）；用户取消时返回 null。 */
  importArchive: () => Promise<ArchiveOutcome | null>;
  /**
   * 把一条对话导出成**可读的正文**（T12）。
   *
   * 归档之后这条线只剩「回顾」，而只能在应用里点着看的回顾很脆弱：
   * 用户要的是能带走的一份。传 null（对话不存在）时返回错误说明。
   */
  exportTranscript: (bundle: ConversationBundle | null, worldTitle: string) => Promise<ArchiveOutcome | null>;
}

/** 文件名里不能出现的字符换成短横线；顺便限个长度，免得标题很长时文件系统受不了。 */
function slug(text: string): string {
  const cleaned = text
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 40);
  return cleaned === '' ? 'world' : cleaned;
}

function stamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(at.getFullYear())}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 封存导出 / 导入（ROADMAP P2-4）。
 *
 * 它同时是云同步之前的过渡方案**和移动端的数据安全网**：手机浏览器随时可能
 * 把本地数据清掉，在那之前用户至少能把整条世界线存成一个文件带走。
 *
 * 走的路径与规格一致：优先用 File System Access（Windows 上的 Chrome/Edge 能直接选目录），
 * 不支持时退回「下载 + 上传」——安卓浏览器上后者是常态，所以两条路都得能用。
 */
export function useArchive(options: {
  db: DramatisDb | null;
  /** 导入完成后把新世界打开；导进来的世界不自动打开的话，用户会以为没成功。 */
  onImported: (roomId: RoomId) => Promise<void> | void;
}): ArchiveApi {
  const { db, onImported } = options;
  const fileIO = useMemo(() => createBrowserFileIO(), []);

  const exportWorld = useCallback(
    async (roomId: RoomId): Promise<ArchiveOutcome | null> => {
      if (!db) return { ok: false, message: '数据库还没准备好。' };

      const snapshot = await db.repository.loadRoom(roomId);
      if (!snapshot) return { ok: false, message: '找不到这个世界。' };

      const archive = buildWorldArchive({
        room: snapshot.room,
        conversations: snapshot.conversations,
        scenes: snapshot.scenes,
        instances: snapshot.instances,
        messages: snapshot.messages,
        memories: snapshot.memories,
        chapters: snapshot.chapters,
        cards: snapshot.cards,
        worldBooks: snapshot.worldBooks,
        persona: snapshot.personas.find((item) => item.id === snapshot.room.personaId) ?? null,
        usageRecords: await db.ledger.list({ roomId }),
      });
      const counts = countArchive(archive);
      const name = `dramatis-${slug(archive.title)}-${stamp(new Date())}.json`;
      const bytes = new TextEncoder().encode(JSON.stringify(archive, null, 2));

      const saved = await fileIO.save(name, bytes, { mime: 'application/json' });
      if (!saved.saved) return null;

      return {
        ok: true,
        message: `已导出「${archive.title}」：${name}（${describeBytes(saved.bytes)}）——${String(
          counts.conversations,
        )} 条对话、${String(counts.messages)} 条消息、${String(counts.memories)} 条记忆、${String(
          counts.cards,
        )} 张角色卡。`,
      };
    },
    [db, fileIO],
  );

  const exportTranscript = useCallback(
    async (bundle: ConversationBundle | null, worldTitle: string): Promise<ArchiveOutcome | null> => {
      if (bundle === null) return { ok: false, message: '找不到这条对话（也许它已经被删掉了）。' };

      const text = buildConversationTranscript({
        conversation: bundle.conversation,
        scenes: bundle.scenes,
        messages: bundle.messages,
        instances: bundle.instances,
        worldTitle,
        exportedAt: new Date().toISOString(),
      });
      const name = suggestTranscriptName(bundle.conversation, new Date());
      const bytes = new TextEncoder().encode(text);
      const saved = await fileIO.save(name, bytes, { mime: 'text/markdown' });
      if (!saved.saved) return null;

      return {
        ok: true,
        message: `已导出「${bundle.conversation.title}」的正文：${name}（${describeBytes(saved.bytes)}，${String(
          bundle.messages.length,
        )} 条消息）。`,
      };
    },
    [fileIO],
  );

  const importArchive = useCallback(async (): Promise<ArchiveOutcome | null> => {
    if (!db) return { ok: false, message: '数据库还没准备好。' };

    const opened = await fileIO.open({ accept: '.json,application/json' });
    if (opened === null) return null;

    const parsed = parseWorldArchive(new TextDecoder().decode(opened.data));
    if (!parsed.ok) return { ok: false, message: parsed.error };

    try {
      const report = await importWorldArchive(parsed.archive, db.repository, { ledger: db.ledger });
      await onImported(report.roomId);
      return {
        ok: true,
        message: `已导入「${report.title}」：${String(report.counts.conversations)} 条对话、${String(
          report.counts.messages,
        )} 条消息、${String(report.counts.memories)} 条记忆。导入的是新的一条世界线，原来的数据没有被改动。`,
      };
    } catch (error) {
      return {
        ok: false,
        message: `导入失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }, [db, fileIO, onImported]);

  return { exportWorld, importArchive, exportTranscript };
}
