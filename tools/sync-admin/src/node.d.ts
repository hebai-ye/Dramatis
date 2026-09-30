declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  }
}
declare module 'node:crypto' {
  export function randomUUID(): string;
  export function randomBytes(size: number): { toString(encoding: 'base64url'): string };
  export function pbkdf2Sync(
    secret: string,
    salt: string,
    iterations: number,
    length: number,
    digest: string,
  ): { toString(encoding: 'base64url'): string };
  export function createHash(name: string): { update(text: string): { digest(encoding: 'hex'): string } };
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function mkdirSync(path: string, options: { recursive: true }): void;
  export function appendFileSync(path: string, text: string, options: { encoding: 'utf8'; mode: number }): void;
  export function openSync(path: string, flags: string, mode?: number): number;
  export function writeFileSync(fd: number, data: string, options: { encoding: 'utf8' }): void;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
  export function renameSync(from: string, to: string): void;
  export function readdirSync(path: string): string[];
  export function lstatSync(path: string): {
    size: number;
    mtime: Date;
    ino: number;
    dev: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  };
}
declare module 'node:path' {
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
  export function basename(path: string): string;
}
declare module 'node:url' {
  export function fileURLToPath(url: URL): string;
}
declare module 'node:process' {
  const process: {
    env: Record<string, string | undefined>;
    exit(code: number): never;
    on(event: string, handler: () => void): void;
    stdout: { write(text: string): void };
    stderr: { write(text: string): void };
  };
  export default process;
}
declare module 'node:http' {
  interface IncomingMessage extends AsyncIterable<Uint8Array> {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    socket: { remoteAddress?: string };
  }
  interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body: string): void;
  }
  export function createServer(handler: (request: IncomingMessage, response: ServerResponse) => void): {
    listen(port: number, host: string, callback: () => void): void;
    close(callback: () => void): void;
    on(event: string, callback: () => void): void;
  };
}
