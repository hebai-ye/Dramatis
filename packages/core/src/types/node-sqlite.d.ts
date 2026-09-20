/**
 * `node:sqlite` 的最小类型声明（Node 22.5+ 自带这个模块）。
 *
 * 为什么不装 `@types/node`：`packages/core` 是给浏览器与 Node 共用的内核，
 * 一旦把 Node 的全局类型引进来，浏览器侧就分不清「这个 API 能不能用」了。
 * 这里只声明单测与部署脚本真正用到的那几个方法，够用且不污染全局。
 *
 * 生产侧（`tools/sync-server`）用的是同一个形状，见 `sync/sqlite.ts` 里的
 * `SqliteDatabase` 接口——那边不 import 这个模块，只要求「长得像」。
 */
declare module 'node:sqlite' {
  export interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
