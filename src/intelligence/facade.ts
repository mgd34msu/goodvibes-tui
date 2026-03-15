/**
 * CodeIntelligence — unified facade over tree-sitter and LSP services.
 *
 * Design principles:
 *   - Graceful degradation: never throw, always return safe defaults.
 *   - LSP is optional; falls back to tree-sitter where possible.
 *   - Tree-sitter is optional; falls back to empty arrays/null.
 *   - On initialization, language configs are read and registered with LspService
 *     so user/project overrides in .goodvibes/tui/languages/*.json take effect.
 */
import { resolve } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { loadLanguageConfigs } from './config.ts';
import { TreeSitterService } from './tree-sitter/service.ts';
/** Result of parsing a file with tree-sitter. */
export interface ParseResult { tree: any; language: any; lang: string; }
import type { Tree, Language } from 'web-tree-sitter';
import { LspService } from './lsp/service.ts';
import { detectLanguage } from './tree-sitter/languages.ts';
import { extractSymbols, extractOutline, findEnclosingScope } from './tree-sitter/queries.ts';
import { logger } from '../utils/logger.ts';
import type { SymbolInfo, OutlineEntry } from './tree-sitter/queries.ts';
import type { Location, DocumentSymbol, Diagnostic, Hover } from './lsp/protocol.ts';

// ---------------------------------------------------------------------------
// URI helpers
// ---------------------------------------------------------------------------

/**
 * Convert a filesystem path to a file:// URI.
 * Correctly handles paths with spaces and special characters.
 */
export function pathToUri(filePath: string): string {
  return pathToFileURL(resolve(filePath)).href;
}

/**
 * Convert a file:// URI back to a filesystem path.
 * Correctly handles percent-encoded URIs.
 */
export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}

// ---------------------------------------------------------------------------
// CodeIntelligence
// ---------------------------------------------------------------------------

/** Singleton instance. */
let _instance: CodeIntelligence | null = null;

export class CodeIntelligence {
  private treeSitter: TreeSitterService;
  private lsp: LspService;

  private constructor(treeSitter?: TreeSitterService, lsp?: LspService) {
    this.treeSitter = treeSitter ?? TreeSitterService.getInstance();
    this.lsp = lsp ?? LspService.getInstance();
  }

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  /** Get (or create) the singleton instance. */
  static getInstance(): CodeIntelligence {
    if (!_instance) {
      _instance = new CodeIntelligence();
    }
    return _instance;
  }

  /**
   * Create an isolated instance for testing.
   * Bypasses the singleton so tests don't share state.
   */
  static createForTesting(
    treeSitter: TreeSitterService,
    lsp: LspService,
  ): CodeIntelligence {
    return new CodeIntelligence(treeSitter, lsp);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize all services. Call once at startup.
   * Loads language configs and registers LSP server commands with LspService
   * so that user/project overrides in .goodvibes/tui/languages/ are respected.
   */
  async initialize(): Promise<void> {
    // Wire language configs into LspService (resolves config/facade disconnection).
    // Only register languages that have an LSP command defined — don't overwrite
    // configs that were already registered via registerServer().
    try {
      const configs = loadLanguageConfigs();
      for (const [langId, cfg] of configs) {
        if (cfg.lsp) {
          this.lsp.registerServer(langId, {
            command: cfg.lsp.command,
            args: cfg.lsp.args,
            initializationOptions: cfg.lsp.initializationOptions,
          });
        }
      }
    } catch (err) {
      logger.debug('CodeIntelligence: failed to load language configs', { error: String(err) });
    }

    // Initialize tree-sitter WASM loader.
    try {
      await this.treeSitter.initialize();
    } catch (err) {
      logger.debug('CodeIntelligence: TreeSitterService init error', { error: String(err) });
    }
    // LspService has no async init; LSP servers are started on demand.
  }

  /** Shutdown all services and clear the singleton. */
  async dispose(): Promise<void> {
    try { await this.lsp.shutdown(); } catch (err) { logger.debug('LSP shutdown error', { error: String(err) }); }
    try { this.treeSitter.dispose(); } catch (err) { logger.debug('TreeSitter dispose error', { error: String(err) }); }
    if (_instance === this) {
      _instance = null;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Parse a file and load its tree-sitter language in one step.
   * Returns null if the language is unknown or grammar unavailable.
   */
  private async _parseFile(
    filePath: string,
    content: string,
  ): Promise<ParseResult | null> {
    const lang = detectLanguage(filePath);
    if (!lang) return null;
    const tree = await this.treeSitter.parse(filePath, content, lang);
    if (!tree) return null;
    const language = await this.treeSitter.loadLanguage(lang);
    if (!language) return null;
    return { tree, language, lang };
  }

  // -------------------------------------------------------------------------
  // Tree-sitter operations
  // -------------------------------------------------------------------------

  /** Detect the language of a file by its extension. */
  detectLanguage(filePath: string): string | null {
    return detectLanguage(filePath);
  }

  /** Check if a tree-sitter grammar is loaded for a file's language. */
  hasTreeSitter(filePath: string): boolean {
    const lang = detectLanguage(filePath);
    if (!lang) return false;
    return this.treeSitter.loadedLanguages.includes(lang);
  }

  /**
   * Parse a file and extract symbols.
   * Returns empty array if no grammar is loaded for the language.
   */
  async getSymbols(filePath: string, content: string): Promise<SymbolInfo[]> {
    try {
      const parsed = await this._parseFile(filePath, content);
      if (!parsed) return [];
      return extractSymbols(parsed.tree, parsed.language, parsed.lang);
    } catch (err) {
      logger.debug('CodeIntelligence.getSymbols error', { filePath, error: String(err) });
      return [];
    }
  }

  /**
   * Parse a file and extract an outline (signatures only).
   * Returns empty array if no grammar is loaded for the language.
   */
  async getOutline(filePath: string, content: string): Promise<OutlineEntry[]> {
    try {
      const parsed = await this._parseFile(filePath, content);
      if (!parsed) return [];
      return extractOutline(parsed.tree, parsed.language, parsed.lang);
    } catch (err) {
      logger.debug('CodeIntelligence.getOutline error', { filePath, error: String(err) });
      return [];
    }
  }

  /**
   * Find the scope (function/class) enclosing a line.
   * Returns null if unavailable.
   */
  async getEnclosingScope(
    filePath: string,
    content: string,
    line: number,
  ): Promise<{ kind: string; name: string; startLine: number; endLine: number } | null> {
    try {
      const parsed = await this._parseFile(filePath, content);
      if (!parsed) return null;
      return findEnclosingScope(parsed.tree, parsed.language, parsed.lang, line);
    } catch (err) {
      logger.debug('CodeIntelligence.getEnclosingScope error', { filePath, error: String(err) });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // LSP operations
  // -------------------------------------------------------------------------

  /** Check if an LSP server is available for a file's language. */
  async hasLsp(filePath: string): Promise<boolean> {
    const lang = detectLanguage(filePath);
    if (!lang) return false;
    try {
      return await this.lsp.isAvailable(lang);
    } catch {
      return false;
    }
  }

  /**
   * Get definition location.
   * Returns null if LSP not available for the file's language.
   */
  async getDefinition(
    filePath: string,
    line: number,
    column: number,
  ): Promise<Location | null> {
    const lang = detectLanguage(filePath);
    if (!lang) return null;
    try {
      const client = await this.lsp.getClient(lang);
      if (!client) return null;
      const uri = pathToUri(filePath);
      const result = await client.request<Location | Location[] | null>('textDocument/definition', {
        textDocument: { uri },
        position: { line, character: column },
      });
      if (!result) return null;
      if (Array.isArray(result)) return result[0] ?? null;
      return result;
    } catch (err) {
      logger.debug('CodeIntelligence.getDefinition error', { filePath, error: String(err) });
      return null;
    }
  }

  /**
   * Get all references to a symbol.
   * Returns empty array if LSP not available.
   */
  async getReferences(
    filePath: string,
    line: number,
    column: number,
  ): Promise<Location[]> {
    const lang = detectLanguage(filePath);
    if (!lang) return [];
    try {
      const client = await this.lsp.getClient(lang);
      if (!client) return [];
      const uri = pathToUri(filePath);
      const result = await client.request<Location[]>('textDocument/references', {
        textDocument: { uri },
        position: { line, character: column },
        context: { includeDeclaration: true },
      });
      return result ?? [];
    } catch (err) {
      logger.debug('CodeIntelligence.getReferences error', { filePath, error: String(err) });
      return [];
    }
  }

  /**
   * Get document symbols.
   * Tries LSP first; falls back to tree-sitter if LSP is unavailable.
   */
  async getDocumentSymbols(
    filePath: string,
    content: string,
  ): Promise<DocumentSymbol[] | SymbolInfo[]> {
    const lang = detectLanguage(filePath);
    // Try LSP first
    if (lang) {
      try {
        const client = await this.lsp.getClient(lang);
        if (client) {
          const uri = pathToUri(filePath);
          const lspSymbols = await client.request<DocumentSymbol[]>(
            'textDocument/documentSymbol',
            { textDocument: { uri } },
          );
          if (lspSymbols && lspSymbols.length > 0) return lspSymbols;
        }
      } catch (err) {
        logger.debug('CodeIntelligence.getDocumentSymbols LSP error', { filePath, error: String(err) });
      }
    }
    // Fall back to tree-sitter
    return this.getSymbols(filePath, content);
  }

  /**
   * Get hover information.
   * Returns null if LSP not available.
   */
  async getHover(
    filePath: string,
    line: number,
    column: number,
  ): Promise<Hover | null> {
    const lang = detectLanguage(filePath);
    if (!lang) return null;
    try {
      const client = await this.lsp.getClient(lang);
      if (!client) return null;
      const uri = pathToUri(filePath);
      return await client.request<Hover | null>('textDocument/hover', {
        textDocument: { uri },
        position: { line, character: column },
      }) ?? null;
    } catch (err) {
      logger.debug('CodeIntelligence.getHover error', { filePath, error: String(err) });
      return null;
    }
  }

  /**
   * Get diagnostics for a file.
   * Returns empty array if LSP not available.
   * Note: LSP pushes diagnostics via textDocument/publishDiagnostics notifications;
   * this method is a best-effort pull (not all servers support textDocument/diagnostic).
   */
  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    const lang = detectLanguage(filePath);
    if (!lang) return [];
    try {
      const client = await this.lsp.getClient(lang);
      if (!client) return [];
      const uri = pathToUri(filePath);
      const result = await client.request<{ items: Diagnostic[] } | null>(
        'textDocument/diagnostic',
        { textDocument: { uri } },
      );
      return result?.items ?? [];
    } catch (err) {
      logger.debug('CodeIntelligence.getDiagnostics error', { filePath, error: String(err) });
      return [];
    }
  }
}
