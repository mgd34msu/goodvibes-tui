import { readFileSync } from 'fs';
import { logger } from '../utils/logger.ts';

/**
 * A cache entry tracking file read history and content state.
 */
export interface CacheEntry {
  /** SHA-256 hash of the file content at last read/update. */
  contentHash: string;
  /** Stored content (only in with_content mode). */
  content?: string;
  lineCount: number;
  byteSize: number;
  firstReadAt: number;
  lastReadAt: number;
  readCount: number;
  /** Estimated LLM tokens: Math.ceil(byteSize / 4). */
  tokenEstimate: number;
  /** Cumulative tokens saved by cache hits. */
  tokensSaved: number;
  /** OCC version counter — increments on every external modification. */
  version: number;
}

export interface ConflictInfo {
  yourVersion: number;
  currentVersion: number;
  diffSinceRead?: string;
}

export type CacheStatus = 'miss' | 'unchanged' | 'modified';

interface LRUNode {
  filePath: string;
  entry: CacheEntry;
  /** Approximate memory footprint in bytes (content + overhead). */
  memBytes: number;
  /** Access time for LRU eviction. */
  accessAt: number;
}

/**
 * FileStateCache — File state tracking with Optimistic Concurrency Control.
 *
 * Tracks files that have been read by tools/agents, detects external modifications,
 * and provides conflict information for OCC workflows.
 */
export class FileStateCache {
  private readonly mode: 'hash_only' | 'with_content';
  private readonly maxMemoryBytes: number;
  private cache: Map<string, LRUNode> = new Map();
  private totalMemBytes = 0;
  private totalReads = 0;
  private cacheHits = 0;

  constructor(options?: { mode?: 'hash_only' | 'with_content'; maxMemoryMB?: number }) {
    this.mode = options?.mode ?? 'hash_only';
    this.maxMemoryBytes = (options?.maxMemoryMB ?? 200) * 1024 * 1024;
  }

  // ---------------------------------------------------------------------------
  // Core API
  // ---------------------------------------------------------------------------

  /**
   * Look up the current state of a file.
   *
   * - miss: file has never been cached
   * - unchanged: content hash matches what we last saw
   * - modified: content hash differs (external modification)
   *
   * In `with_content` mode, a unified diff is included when status is 'modified'.
   */
  lookup(filePath: string): { status: CacheStatus; entry?: CacheEntry; diff?: string } {
    this.totalReads++;
    const node = this.cache.get(filePath);
    if (!node) {
      return { status: 'miss' };
    }

    // Re-read file to detect external changes
    let currentContent: string;
    let currentHash: string;
    try {
      currentContent = readFileSync(filePath, 'utf-8');
      currentHash = this.hash(currentContent);
    } catch {
      // File no longer exists or unreadable
      return { status: 'miss' };
    }

    node.accessAt = Date.now();

    if (currentHash === node.entry.contentHash) {
      this.cacheHits++;
      node.entry.lastReadAt = Date.now();
      node.entry.readCount++;
      node.entry.tokensSaved += node.entry.tokenEstimate;
      return { status: 'unchanged', entry: { ...node.entry } };
    }

    // Modified externally — return modified status with optional diff
    let diff: string | undefined;
    if (this.mode === 'with_content' && node.entry.content !== undefined) {
      diff = unifiedDiff(node.entry.content, currentContent, filePath);
    }

    // Update version and hash to reflect the detected change
    node.entry.version++;
    node.entry.contentHash = currentHash;
    if (this.mode === 'with_content') {
      const oldMem = node.memBytes;
      node.entry.content = currentContent;
      node.memBytes = estimateMemBytes(filePath, currentContent);
      this.totalMemBytes += node.memBytes - oldMem;
    }
    node.entry.lastReadAt = Date.now();
    node.entry.readCount++;

    return { status: 'modified', entry: { ...node.entry }, diff };
  }

  /**
   * Record that a file was read or written by a tool/agent.
   * Creates or updates the cache entry.
   */
  update(
    filePath: string,
    content: string,
    metadata?: { tool?: string; agent?: string },
  ): void {
    const hash = this.hash(content);
    const lineCount = content.split('\n').length;
    const byteSize = Buffer.byteLength(content, 'utf-8');
    const tokenEstimate = Math.ceil(byteSize / 4);
    const now = Date.now();

    const existing = this.cache.get(filePath);
    if (existing) {
      const oldMem = existing.memBytes;
      existing.entry.contentHash = hash;
      existing.entry.lineCount = lineCount;
      existing.entry.byteSize = byteSize;
      existing.entry.tokenEstimate = tokenEstimate;
      existing.entry.lastReadAt = now;
      existing.entry.readCount++;
      existing.entry.version++;
      if (this.mode === 'with_content') {
        existing.entry.content = content;
      }
      existing.accessAt = now;
      existing.memBytes = estimateMemBytes(filePath, this.mode === 'with_content' ? content : '');
      this.totalMemBytes += existing.memBytes - oldMem;
    } else {
      const entry: CacheEntry = {
        contentHash: hash,
        lineCount,
        byteSize,
        firstReadAt: now,
        lastReadAt: now,
        readCount: 1,
        tokenEstimate,
        tokensSaved: 0,
        version: 1,
      };
      if (this.mode === 'with_content') {
        entry.content = content;
      }
      const memBytes = estimateMemBytes(filePath, this.mode === 'with_content' ? content : '');
      const node: LRUNode = { filePath, entry, memBytes, accessAt: now };
      this.cache.set(filePath, node);
      this.totalMemBytes += memBytes;
    }

    if (metadata?.tool) {
      logger.debug('FileStateCache: updated', { filePath, tool: metadata.tool, version: this.cache.get(filePath)?.entry.version });
    }

    this.evictIfNeeded();
  }

  /**
   * Check for an OCC conflict: has the file been modified since `expectedVersion`?
   * Returns null if no conflict, or ConflictInfo if the version has advanced.
   */
  checkConflict(filePath: string, expectedVersion: number): ConflictInfo | null {
    const node = this.cache.get(filePath);
    if (!node) return null;
    if (node.entry.version === expectedVersion) return null;
    return {
      yourVersion: expectedVersion,
      currentVersion: node.entry.version,
      diffSinceRead: undefined, // diff on demand only
    };
  }

  /**
   * Remove a file from the cache.
   */
  invalidate(filePath: string): void {
    const node = this.cache.get(filePath);
    if (node) {
      this.totalMemBytes -= node.memBytes;
      this.cache.delete(filePath);
    }
  }

  /**
   * Return cache statistics.
   */
  getStats(): {
    uniqueFiles: number;
    totalReads: number;
    hitRate: number;
    tokensSaved: number;
    memoryMB: number;
  } {
    let tokensSaved = 0;
    for (const node of this.cache.values()) {
      tokensSaved += node.entry.tokensSaved;
    }
    return {
      uniqueFiles: this.cache.size,
      totalReads: this.totalReads,
      hitRate: this.totalReads > 0 ? this.cacheHits / this.totalReads : 0,
      tokensSaved,
      memoryMB: this.totalMemBytes / (1024 * 1024),
    };
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
    this.totalMemBytes = 0;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private hash(content: string): string {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(content);
    return hasher.digest('hex');
  }

  private evictIfNeeded(): void {
    if (this.totalMemBytes <= this.maxMemoryBytes) return;

    // Sort by oldest access time, evict until under budget
    const nodes = Array.from(this.cache.values()).sort((a, b) => a.accessAt - b.accessAt);
    for (const node of nodes) {
      if (this.totalMemBytes <= this.maxMemoryBytes) break;
      this.totalMemBytes -= node.memBytes;
      this.cache.delete(node.filePath);
      logger.debug('FileStateCache: LRU evict', { filePath: node.filePath });
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Estimate in-memory footprint for a cache node.
 */
function estimateMemBytes(filePath: string, content: string): number {
  return filePath.length * 2 + content.length * 2 + 256; // 256 bytes overhead for entry fields
}

/**
 * Generate a simple unified diff between two strings.
 * Uses line-by-line LCS diff, not the Myers algorithm.
 */
export function unifiedDiff(oldContent: string, newContent: string, label: string, contextLines = 3): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const hunks = computeHunks(oldLines, newLines, contextLines);
  if (hunks.length === 0) return '';

  const header = `--- ${label}\n+++ ${label}\n`;
  return header + hunks.join('');
}

interface HunkLine {
  type: 'context' | 'removed' | 'added';
  text: string;
}

function computeHunks(oldLines: string[], newLines: string[], CONTEXT = 3): string[] {
  // Simple O(n*m) LCS-based diff — practical for reasonable file sizes
  const edits = computeEdits(oldLines, newLines);
  if (edits.length === 0) return [];

  // Group edits into hunks with context
  const result: string[] = [];
  let i = 0;
  while (i < edits.length) {
    // Find next non-context edit
    while (i < edits.length && edits[i].type === 'context') i++;
    if (i >= edits.length) break;

    // Collect hunk starting CONTEXT lines before
    const hunkStart = Math.max(0, i - CONTEXT);
    let hunkEnd = i;
    // Extend to next gap
    while (hunkEnd < edits.length) {
      if (edits[hunkEnd].type !== 'context') {
        hunkEnd++;
      } else {
        // Check if there's another non-context within CONTEXT distance
        let next = hunkEnd + 1;
        while (next < edits.length && edits[next].type === 'context') next++;
        if (next < edits.length && next - hunkEnd <= CONTEXT * 2) {
          hunkEnd = next;
        } else {
          break;
        }
      }
    }
    const hunkRealEnd = Math.min(edits.length, hunkEnd + CONTEXT);

    const hunkLines = edits.slice(hunkStart, hunkRealEnd);
    let oldStart = 1, oldCount = 0, newStart = 1, newCount = 0;
    // Compute line numbers
    let oldLine = 1;
    let newLine = 1;
    for (let j = 0; j < hunkStart; j++) {
      if (edits[j].type !== 'added') oldLine++;
      if (edits[j].type !== 'removed') newLine++;
    }
    oldStart = oldLine;
    newStart = newLine;
    for (const hl of hunkLines) {
      if (hl.type !== 'added') oldCount++;
      if (hl.type !== 'removed') newCount++;
    }

    let hunk = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;
    for (const hl of hunkLines) {
      const prefix = hl.type === 'context' ? ' ' : hl.type === 'removed' ? '-' : '+';
      hunk += prefix + hl.text + '\n';
    }
    result.push(hunk);
    i = hunkRealEnd;
  }
  return result;
}

function computeEdits(oldLines: string[], newLines: string[]): HunkLine[] {
  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  // For large files, fall back to simple append diff to avoid O(mn) memory
  if (m * n > 1_000_000) {
    const edits: HunkLine[] = [];
    for (const l of oldLines) edits.push({ type: 'removed', text: l });
    for (const l of newLines) edits.push({ type: 'added', text: l });
    return edits;
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Reconstruct diff
  const edits: HunkLine[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      edits.push({ type: 'context', text: oldLines[i] });
      i++; j++;
    } else if (j < n && (i >= m || (dp[i + 1]?.[j] ?? 0) <= (dp[i]?.[j + 1] ?? 0))) {
      edits.push({ type: 'added', text: newLines[j] });
      j++;
    } else {
      edits.push({ type: 'removed', text: oldLines[i] });
      i++;
    }
  }
  return edits;
}
