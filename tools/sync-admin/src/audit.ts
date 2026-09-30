import { appendFileSync } from 'node:fs';

export interface AuditEvent {
  action: string;
  status: number;
  durationMs: number;
}

/** 明确选字段；请求、凭证、URL 和运营资料均不进入审计日志。 */
export function appendAudit(path: string, event: AuditEvent): void {
  appendFileSync(
    path,
    `${JSON.stringify({
      time: new Date().toISOString(),
      action: event.action,
      status: event.status,
      durationMs: event.durationMs,
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}
