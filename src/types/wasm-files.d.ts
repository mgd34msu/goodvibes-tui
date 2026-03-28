/**
 * Type declarations for WASM file imports using Bun's compile-time embedding.
 *
 * When importing `.wasm` files with `with { type: 'file' }`, Bun resolves them
 * to a `string` path — either the embedded path in compiled binaries or the
 * absolute filesystem path in dev mode. These declarations tell TypeScript the
 * module shape so `@ts-ignore` suppressions are not needed.
 */

declare module 'web-tree-sitter/web-tree-sitter.wasm' {
  const path: string;
  export default path;
}

declare module 'tree-sitter-typescript/tree-sitter-typescript.wasm' {
  const path: string;
  export default path;
}

declare module 'tree-sitter-typescript/tree-sitter-tsx.wasm' {
  const path: string;
  export default path;
}

declare module 'tree-sitter-javascript/tree-sitter-javascript.wasm' {
  const path: string;
  export default path;
}

declare module 'tree-sitter-python/tree-sitter-python.wasm' {
  const path: string;
  export default path;
}

declare module 'tree-sitter-json/tree-sitter-json.wasm' {
  const path: string;
  export default path;
}

declare module 'tree-sitter-css/tree-sitter-css.wasm' {
  const path: string;
  export default path;
}
