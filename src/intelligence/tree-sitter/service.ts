/**
 * TreeSitterService — Grammar loading, parsing, and tree caching.
 *
 * Grammar WASM files are embedded in the compiled binary via Bun's
 * `with { type: 'file' }` import assertion (see embedded-wasm.ts).
 * Missing grammars are handled gracefully (returns null, logs warning).
 * Never throws — callers receive null on failure.
 */
import { Parser, Language, Query, Tree } from 'web-tree-sitter';
import type { QueryMatch } from 'web-tree-sitter';
import { logger } from '../../utils/logger.ts';
import { detectLanguage } from './languages.ts';
import { TREE_SITTER_WASM, GRAMMAR_WASM } from './embedded-wasm.ts';

const MAX_CACHE_SIZE = 100;

interface CacheEntry {
  tree: Tree;
  version: number;
}

export class TreeSitterService {
  private parser: Parser | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private languages: Map<string, Language> = new Map();
  private treeCache: Map<string, CacheEntry> = new Map();
  private static instance: TreeSitterService | null = null;

  /** Get or create the singleton instance. */
  static getInstance(): TreeSitterService {
    if (!TreeSitterService.instance) {
      TreeSitterService.instance = new TreeSitterService();
    }
    return TreeSitterService.instance;
  }

  /**
   * Initialize the WASM module. Safe to call multiple times — only runs once.
   * Must be called before parse() will work.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // TREE_SITTER_WASM is the embedded WASM path from embedded-wasm.ts.
        // In compiled binaries it resolves to the embedded file; in dev mode
        // it resolves to the absolute filesystem path. Both work.
        await Parser.init({
          locateFile: (_path: string) => TREE_SITTER_WASM,
        });
        this.parser = new Parser();
        this.initialized = true;
        logger.info('TreeSitterService: WASM initialized');
      } catch (err) {
        logger.error('TreeSitterService: WASM init failed', { error: String(err) });
        this.initPromise = null; // allow retry on next call
      }
    })();

    return this.initPromise;
  }

  /**
   * Load a language grammar by ID. Grammars are loaded lazily and cached.
   * Returns null if the grammar WASM file is not available.
   */
  async loadLanguage(langId: string): Promise<Language | null> {
    const cached = this.languages.get(langId);
    if (cached) return cached;

    // Look up the embedded WASM path. If not present, the grammar package is
    // not installed — return null rather than throwing.
    const wasmPath = GRAMMAR_WASM[langId];
    if (!wasmPath) {
      logger.debug('TreeSitterService: grammar WASM not embedded', { langId });
      return null;
    }

    try {
      const language = await Language.load(wasmPath);
      this.languages.set(langId, language);
      logger.info('TreeSitterService: loaded grammar', { langId });
      return language;
    } catch (err) {
      logger.error('TreeSitterService: failed to load grammar', { langId, error: String(err) });
      return null;
    }
  }

  /**
   * Parse a file and cache the result.
   * Returns null if WASM is not initialized or grammar is unavailable.
   */
  async parse(
    filePath: string,
    content: string,
    langId?: string,
  ): Promise<Tree | null> {
    if (!this.initialized || !this.parser) {
      logger.debug('TreeSitterService: not initialized, skipping parse', { filePath });
      return null;
    }

    const resolvedLangId = langId ?? detectLanguage(filePath);
    if (!resolvedLangId) {
      logger.debug('TreeSitterService: unknown language for file', { filePath });
      return null;
    }

    const language = await this.loadLanguage(resolvedLangId);
    if (!language) return null;

    try {
      this.parser.setLanguage(language);
      const tree = this.parser.parse(content);
      if (!tree) return null;

      const existing = this.treeCache.get(filePath);
      const nextVersion = existing ? existing.version + 1 : 1;

      // FIFO eviction when at capacity (sufficient since parse() re-inserts on update)
      if (!existing && this.treeCache.size >= MAX_CACHE_SIZE) {
        const firstKey = this.treeCache.keys().next().value;
        if (firstKey !== undefined) {
          const evicted = this.treeCache.get(firstKey);
          if (evicted) evicted.tree.delete();
          this.treeCache.delete(firstKey);
        }
      }

      if (existing) existing.tree.delete();

      this.treeCache.set(filePath, { tree, version: nextVersion });
      return tree;
    } catch (err) {
      logger.error('TreeSitterService: parse failed', {
        filePath,
        langId: resolvedLangId,
        error: String(err),
      });
      return null;
    }
  }

  /** Invalidate the cached tree for a file (call after edits). */
  invalidate(filePath: string): void {
    const entry = this.treeCache.get(filePath);
    if (entry) {
      entry.tree.delete();
      this.treeCache.delete(filePath);
    }
  }

  /**
   * Run a tree-sitter Query on a parsed tree.
   * Returns an empty array if the query fails.
   */
  query(
    tree: Tree,
    language: Language,
    queryString: string,
  ): QueryMatch[] {
    try {
      const q = new Query(language, queryString);
      const matches = q.matches(tree.rootNode);
      q.delete();
      return matches;
    } catch (err) {
      logger.error('TreeSitterService: query failed', { error: String(err) });
      return [];
    }
  }

  /** Current number of cached trees. */
  get cacheSize(): number {
    return this.treeCache.size;
  }

  /** Loaded language IDs. */
  get loadedLanguages(): string[] {
    return Array.from(this.languages.keys());
  }

  /**
   * Free all resources. Resets the singleton so it can be re-initialized.
   */
  dispose(): void {
    for (const entry of this.treeCache.values()) {
      entry.tree.delete();
    }
    this.treeCache.clear();
    this.languages.clear();
    if (this.parser) {
      this.parser.delete();
      this.parser = null;
    }
    this.initialized = false;
    this.initPromise = null;
    TreeSitterService.instance = null;
  }
}
