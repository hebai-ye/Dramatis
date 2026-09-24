/**
 * 这个工具用到的 Node 表面（自声明，不装 @types/node）。
 *
 * 理由与 `packages/core/src/types/node-sqlite.d.ts` 相同：这里只需要几个方法，
 * 为它引一整套 Node 类型会把「浏览器也能用的内核」和「只能在 Node 跑的服务」
 * 混在一起。声明在这里，`main.ts` 就能正常类型检查与被 tsc 编译。
 */

declare module 'node:http' {
  export interface IncomingMessage {
    method?: string | undefined;
    url?: string | undefined;
    headers: Record<string, string | string[] | undefined>;
    /** 请求来自哪个 socket（顺序 61 给 `POST /spaces` 限流按来源分桶用）。 */
    socket: { remoteAddress?: string | undefined };
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  }
  export interface Server {
    listen(port: number, host: string, callback: () => void): void;
    close(callback?: () => void): void;
    on(event: string, listener: (...args: never[]) => void): void;
  }
  export function createServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Server;
}

declare module 'node:https' {
  import type { IncomingMessage, ServerResponse } from 'node:http';
  export interface Server {
    listen(port: number, host: string, callback: () => void): void;
    close(callback?: () => void): void;
    on(event: string, listener: (...args: never[]) => void): void;
  }
  export function createServer(
    options: { cert: string; key: string },
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Server;
}

declare module 'node:fs' {
  export function mkdirSync(path: string, options: { recursive: true }): void;
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
}

declare module 'node:process' {
  interface NodeProcess {
    env: Record<string, string | undefined>;
    argv: string[];
    exit(code?: number): void;
    on(event: string, listener: (...args: never[]) => void): void;
    stdout: { write(text: string): void };
    stderr: { write(text: string): void };
  }
  const process: NodeProcess;
  export default process;
}

declare module 'node:sqlite' {
  export interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
