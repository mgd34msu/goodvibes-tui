import { promises as fs, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.ts';
import { summarizeError } from '../utils/error-display.ts';

/**
 * JsonFileStore — generic JSON file persistence with atomic writes.
 *
 * Handles lazy loading, atomic writes via a temporary file, and ensures the
 * directory hierarchy exists. Errors are logged but not re-thrown so that the
 * caller can decide how to recover.
 */
export class JsonFileStore<T> {
  constructor(private readonly filePath: string) {}

  /** Load JSON data from disk, or return null if the file does not exist or is invalid. */
  async load(): Promise<T | null> {
    if (!existsSync(this.filePath)) {
      return null;
    }

    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.debug('JsonFileStore: failed to load, starting fresh', { file: this.filePath, error: summarizeError(err) });
      return null;
    }
  }

  /** Atomically persist data to disk. */
  async save(data: T): Promise<void> {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      const content = JSON.stringify(data, null, 2) + '\n';
      await fs.writeFile(tmpPath, content, 'utf-8');
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      logger.debug('JsonFileStore: save failed (non-fatal)', { file: this.filePath, error: summarizeError(err) });
    }
  }
}
