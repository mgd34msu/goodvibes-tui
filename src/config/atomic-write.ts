import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export interface AtomicWriteOptions {
  /**
   * File permission mode for the written file. Defaults to 0o600 (owner read/write only).
   */
  readonly mode?: number;
  /**
   * When true, creates parent directories if they do not exist. Defaults to false.
   */
  readonly mkdirp?: boolean;
}

/**
 * Writes `data` to `path` atomically: writes to a sibling temp file, fsyncs
 * it, then renames it into place. On POSIX, rename(2) is atomic so readers
 * always see either the old file or the new file — never a partial write.
 *
 * If the write or fsync fails, the temp file is cleaned up before rethrowing.
 *
 * @param path   Destination file path.
 * @param data   UTF-8 string content to write.
 * @param opts   Optional mode and mkdirp flags.
 */
export function atomicWriteFileSync(
  path: string,
  data: string,
  opts: AtomicWriteOptions = {},
): void {
  const mode = opts.mode ?? 0o600;

  if (opts.mkdirp) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;

  try {
    writeFileSync(tmp, data, { mode });

    // fsync the temp file to flush OS write buffers before rename.
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(tmp, path);

    // fsync the parent directory to ensure the renamed directory entry is
    // flushed. Without this, a hard crash immediately after rename could lose
    // the entry on some filesystems (ext3/ext4 with data=ordered, etc.).
    const dirFd = openSync(dirname(path), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup — original error takes priority.
    }
    throw err;
  }
}
