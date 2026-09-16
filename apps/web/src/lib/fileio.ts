import type { FileIO, OpenedFile, SavedFile } from '@dramatis/core';

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}

interface FileSystemWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemHandle {
  createWritable(): Promise<FileSystemWritable>;
}

type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemHandle>;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * 浏览器文件读写（ROADMAP P0-1、P2-4）。
 *
 * 优先用 File System Access API：Windows 上的 Chrome 与 Edge 支持，
 * 能让用户直接选目录。不支持时退回「下载 + 上传」，这条路径在安卓
 * 浏览器上是常态，所以必须同样好用。
 */
export function createBrowserFileIO(): FileIO {
  return {
    kind: 'browser',

    async save(name, data, options): Promise<SavedFile> {
      const mime = options?.mime ?? 'application/octet-stream';
      const picker = (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
      const extension = name.split('.').pop() ?? 'bin';

      if (typeof picker === 'function') {
        try {
          const handle = await picker({
            suggestedName: name,
            types: [{ description: 'Dramatis 数据文件', accept: { [mime]: [`.${extension}`] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(new Uint8Array(data));
          await writable.close();
          return { name, bytes: data.byteLength, saved: true };
        } catch (error) {
          if (isAbortError(error)) {
            return { name, bytes: data.byteLength, saved: false };
          }
          // 权限被拒等其它错误静默退回下载路径
        }
      }

      const blob = new Blob([new Uint8Array(data)], { type: mime });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      URL.revokeObjectURL(url);

      return { name, bytes: data.byteLength, saved: true };
    },

    async open(options): Promise<OpenedFile | null> {
      return new Promise<OpenedFile | null>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        if (options?.accept !== undefined) input.accept = options.accept;

        input.addEventListener('change', () => {
          const file = input.files?.[0];
          if (!file) {
            resolve(null);
            return;
          }
          void file.arrayBuffer().then((buffer) => {
            resolve({ name: file.name, data: new Uint8Array(buffer) });
          });
        });

        // 用户直接关掉选择框时 change 不会触发，靠 cancel 兜住
        input.addEventListener('cancel', () => resolve(null));
        input.click();
      });
    },
  };
}
