/**
 * Tree-sitter intelligence module.
 *
 * Provides grammar loading, parsing, tree caching, and symbol/outline extraction.
 */
export { TreeSitterService } from './service.ts';
export type { SymbolInfo, OutlineEntry } from './queries.ts';
export { extractSymbols, extractOutline, findEnclosingScope } from './queries.ts';
export { detectLanguage, getGrammarPackage, getSupportedLanguages } from './languages.ts';
