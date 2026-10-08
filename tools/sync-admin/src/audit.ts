import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeFileSync } from 'node:fs';
import { syncParentDirectory } from './durability.js';

export interface AuditEvent {
  action: string;
  status: number;
  durationMs: number;
  operationId?: string;
  /** One-way ticket correlation; never log the bearer confirmationId itself. */
  confirmationHash?: string;
  spaceHandle?: string;
  backupFile?: string;
  maxBytes?: number | null;
  startedAt?: string;
  expiresAt?: string;
}

/** 明确选字段；请求、凭证、URL 和运营资料均不进入审计日志。 */
export function appendAudit(path: string, event: AuditEvent): void {
  const descriptor = openSync(path, 'a+', 0o600);
  try {
    const size = fstatSync(descriptor).size;
    if (size > 0) {
      const last = new Uint8Array(1);
      if (readSync(descriptor, last, 0, 1, size - 1) !== 1 || last[0] !== 10) {
        throw new Error('审计文件末尾不完整；已保留原文，停止追加，请先备份并人工核对。');
      }
    }
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        time: new Date().toISOString(),
        action: event.action,
        status: event.status,
        durationMs: event.durationMs,
        ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
        ...(event.confirmationHash === undefined ? {} : { confirmationHash: event.confirmationHash }),
        ...(event.spaceHandle === undefined ? {} : { spaceHandle: event.spaceHandle }),
        ...(event.backupFile === undefined ? {} : { backupFile: event.backupFile }),
        ...(event.maxBytes === undefined ? {} : { maxBytes: event.maxBytes }),
        ...(event.startedAt === undefined ? {} : { startedAt: event.startedAt }),
        ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
      })}\n`,
      { encoding: 'utf8' },
    );
    fsyncSync(descriptor);
    // A failed directory barrier must not be bypassed by the next append.
    syncParentDirectory(path);
  } finally {
    closeSync(descriptor);
  }
}
