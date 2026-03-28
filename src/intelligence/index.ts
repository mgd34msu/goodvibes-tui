/**
 * CodeIntelligence public API.
 *
 * Import from here to get the facade, config utilities, and all types.
 */

// Facade
export { CodeIntelligence, pathToUri, uriToPath } from './facade.ts';

// Config
export {
  loadLanguageConfigs,
  getLanguageConfig,
  getDefaultConfigs,
} from './config.ts';
export type { LanguageConfig } from './config.ts';

// Tree-sitter
export { TreeSitterService } from './tree-sitter/service.ts';
export type { SymbolInfo, OutlineEntry } from './tree-sitter/queries.ts';
export { extractSymbols, extractOutline, findEnclosingScope } from './tree-sitter/queries.ts';
export { detectLanguage, getGrammarPackage, getSupportedLanguages } from './tree-sitter/languages.ts';

// Import graph
export { ImportGraph } from './import-graph.ts';
export type { DependentsMap, ImportsMap } from './import-graph.ts';

// LSP
export { LspService } from './lsp/service.ts';
export type { LspServerConfig } from './lsp/service.ts';
export type {
  Position,
  Range,
  Location,
  DocumentSymbol,
  Diagnostic,
  Hover,
} from './lsp/protocol.ts';
export { SymbolKind } from './lsp/protocol.ts';
