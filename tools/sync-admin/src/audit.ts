import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';

export interface AuditEvent {
  action: string;
  status: number;
  durationMs: number;
  operationId?: string;
  spaceHandle?: string;
  backupFile?: string;
  maxBytes?: number | null;
}

/** 明确选字段；请求、凭证、URL 和运营资料均不进入审计日志。 */
export function appendAudit(path: string, event: AuditEvent): void {
  const descriptor = openSync(path, 'a', 0o600);
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        time: new Date().toISOString(),
        action: event.action,
        status: event.status,
        durationMs: event.durationMs,
        ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
        ...(event.spaceHandle === undefined ? {} : { spaceHandle: event.spaceHandle }),
        ...(event.backupFile === undefined ? {} : { backupFile: event.backupFile }),
        ...(event.maxBytes === undefined ? {} : { maxBytes: event.maxBytes }),
      })}\n`,
      { encoding: 'utf8' },
    );
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
