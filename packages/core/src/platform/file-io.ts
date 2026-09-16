/**
 * 文件读写（ROADMAP P0-1、P2-4）。
 *
 * Web 实现优先用 File System Access API，不支持的浏览器退回下载与上传；
 * 桌面壳将来换成原生文件系统。调用方只关心字节，不关心怎么落地。
 */
export interface SavedFile {
  name: string;
  bytes: number;
  /** 用户取消时为 false。 */
  saved: boolean;
}

export interface OpenedFile {
  name: string;
  data: Uint8Array;
}

export interface FileIO {
  readonly kind: string;
  save(name: string, data: Uint8Array, options?: { mime?: string }): Promise<SavedFile>;
  open(options?: { accept?: string }): Promise<OpenedFile | null>;
}
