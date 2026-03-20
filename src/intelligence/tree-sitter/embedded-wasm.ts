/**
 * Embedded WASM files for tree-sitter — compiled into the binary via Bun's
 * `with { type: 'file' }` import assertion. In `bun build --compile`, Bun
 * embeds the file and returns the embedded path at runtime. In dev mode
 * (`bun run`), it returns the absolute filesystem path. Both modes work
 * identically with `Language.load()` and `Parser.init()`.
 *
 * Only the grammar packages that are actually installed are included here.
 * The service handles missing languages gracefully (returns null).
 */

// @ts-ignore — Bun compile-time file embedding
import treeSitterWasm from 'web-tree-sitter/web-tree-sitter.wasm' with { type: 'file' };

// @ts-ignore
import typescriptWasm from 'tree-sitter-typescript/tree-sitter-typescript.wasm' with { type: 'file' };

// @ts-ignore
import tsxWasm from 'tree-sitter-typescript/tree-sitter-tsx.wasm' with { type: 'file' };

// @ts-ignore
import javascriptWasm from 'tree-sitter-javascript/tree-sitter-javascript.wasm' with { type: 'file' };

// @ts-ignore
import pythonWasm from 'tree-sitter-python/tree-sitter-python.wasm' with { type: 'file' };

// @ts-ignore
import jsonWasm from 'tree-sitter-json/tree-sitter-json.wasm' with { type: 'file' };

// @ts-ignore
import cssWasm from 'tree-sitter-css/tree-sitter-css.wasm' with { type: 'file' };

/**
 * The embedded path for the core web-tree-sitter WASM module.
 * Pass this to `Parser.init({ locateFile: () => TREE_SITTER_WASM })`.
 */
export const TREE_SITTER_WASM: string = treeSitterWasm as string;

/**
 * Map of language ID → embedded WASM path.
 * Only languages with installed grammar packages are present.
 * A missing key means the grammar is not available — the service returns null.
 */
export const GRAMMAR_WASM: Record<string, string> = {
  typescript: typescriptWasm as string,
  tsx: tsxWasm as string,
  javascript: javascriptWasm as string,
  python: pythonWasm as string,
  json: jsonWasm as string,
  css: cssWasm as string,
};
