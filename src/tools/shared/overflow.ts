import { mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../utils/logger.ts';
import { getToolResultMaxChars } from '../../providers/model-limits.ts';

// ─── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_CHARS = 50_000; // fallback only — runtime uses getToolResultMaxChars()
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const OVERFLOW_DIR = '.goodvibes/.overflow';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OverflowResult {
  content: string;
  overflowRef?: string;
}

export interface OverflowOptions {
  maxChars?: number;
  label?: string;
}

export interface OverflowFileInfo {
  filename: string;
  path: string;
  sizeBytes: number;
  createdAt: number;
}

// ─── OverflowHandler ────────────────────────────────────────────────────────

/**
 * Handles large tool output by writing overflow content to disk and returning
 * a truncated version with a reference URI.
 *
 * Files are written to `.goodvibes/.overflow/{timestamp}-{label}.txt`
 * relative to the current working directory.
 *
 * Never throws — on write failure, returns truncated content without ref.
 */
export class OverflowHandler {
  private readonly overflowDir: string;

  constructor(baseDir?: string) {
    this.overflowDir = join(baseDir ?? process.cwd(), OVERFLOW_DIR);
  }

  /**
   * Sanitize a label to be safe for use in a filename.
   * Lowercase, alphanumeric + hyphens only, max 40 chars.
   */
  private sanitizeLabel(label: string): string {
    return label
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
  }

  /**
   * Ensure the overflow directory exists.
   * Returns true on success, false if creation failed.
   */
  private ensureDir(): boolean {
    try {
      mkdirSync(this.overflowDir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Handle potentially large content.
   *
   * If content.length <= maxChars, return unchanged.
   * If content exceeds maxChars:
   *   - Write full content to `.goodvibes/.overflow/{timestamp}-{label}.txt`
   *   - Return truncated content + overflow reference notice
   *   - Return overflowRef pointing to the file path
   */
  handle(content: string, options?: OverflowOptions): OverflowResult {
    const maxChars = options?.maxChars ?? getToolResultMaxChars();

    if (content.length <= maxChars) {
      return { content };
    }

    const rawLabel = options?.label ?? 'output';
    const label = this.sanitizeLabel(rawLabel);
    const filename = `${Date.now()}-${label}.txt`;
    const filePath = join(this.overflowDir, filename);
    const relPath = `${OVERFLOW_DIR}/${filename}`;

    try {
      if (!this.ensureDir()) {
        throw new Error('Failed to create overflow directory');
      }
      writeFileSync(filePath, content, 'utf-8');
    } catch (err) {
      // Never throw — return truncated content without ref
      logger.info(`[overflow] Failed to write overflow file: ${err instanceof Error ? err.message : String(err)}`);
      return {
        content: content.slice(0, maxChars) + `\n[... truncated at ${maxChars} chars]`,
      };
    }

    return {
      content: content.slice(0, maxChars) + `\n[... truncated. Full output: ${relPath}]`,
      overflowRef: relPath,
    };
  }

  /**
   * Remove overflow files older than maxAge ms.
   * Default: 1 hour.
   */
  cleanup(maxAge?: number): void {
    const maxAgeMs = maxAge ?? DEFAULT_MAX_AGE_MS;
    const now = Date.now();

    let files: string[];
    try {
      files = readdirSync(this.overflowDir);
    } catch {
      // Directory doesn't exist yet — nothing to clean
      return;
    }

    for (const file of files) {
      const filePath = join(this.overflowDir, file);
      try {
        const stat = statSync(filePath);
        const age = now - stat.mtimeMs;
        if (age > maxAgeMs) {
          unlinkSync(filePath);
        }
      } catch {
        // Skip files that can't be stat'd or deleted
      }
    }
  }

  /**
   * List current overflow files.
   */
  list(): OverflowFileInfo[] {
    let files: string[];
    try {
      files = readdirSync(this.overflowDir);
    } catch {
      return [];
    }

    const result: OverflowFileInfo[] = [];
    for (const file of files) {
      const filePath = join(this.overflowDir, file);
      try {
        const stat = statSync(filePath);
        result.push({
          filename: file,
          path: filePath,
          sizeBytes: stat.size,
          createdAt: stat.mtimeMs,
        });
      } catch {
        // Skip files that can't be stat'd
      }
    }

    return result;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

/** Module-level singleton. Uses process.cwd() as the base directory. */
export const overflowHandler = new OverflowHandler();
