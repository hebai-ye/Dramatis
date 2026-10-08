import { closeSync, fsyncSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

/** Flush SQLite VACUUM output explicitly; SQLite does not promise VACUUM INTO has done so. */
export function syncFile(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * POSIX: persist a newly created/renamed directory entry before authorizing a write.
 * Node on Windows cannot portably open+fsync directories. File fsync is still mandatory,
 * but namespace durability after physical power loss remains unverified on that platform.
 */
export function syncParentDirectory(path: string): 'synced' | 'unsupported' {
  if (process.platform === 'win32') return 'unsupported';
  const fd = openSync(dirname(path), 'r');
  try {
    fsyncSync(fd);
    return 'synced';
  } finally {
    closeSync(fd);
  }
}
