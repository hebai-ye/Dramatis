declare module 'virtual:validation-baseline-admin' {
  export const runAdminTurn: typeof import('../../../../packages/core/src/admin/turn').runAdminTurn;
  export const parseAdminToolCall: typeof import('../../../../packages/core/src/admin/tools').parseAdminToolCall;
  export const BASELINE_COMMIT: string;
}
