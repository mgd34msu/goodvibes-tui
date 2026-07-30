/**
 * The two onnxruntime-web assets the wake engine needs on disk.
 *
 * Both are imported with `with { type: 'file' }`, which resolves to a PATH
 * string rather than module contents — a real filesystem path when the shell
 * runs from source, and a `/$bunfs/root/...` path inside a compiled binary,
 * where the bytes are embedded. Declared here because these are asset
 * specifiers, not typed modules: onnxruntime-web publishes them for exactly
 * this purpose (its `exports` map lists both by name) but ships no types for
 * them, and without the `file` attribute the `.mjs` would be pulled in as
 * untyped JavaScript.
 *
 * They are extracted and pointed at by wake-inference.ts, which is the only
 * importer.
 */
declare module 'onnxruntime-web/ort-wasm-simd-threaded.mjs' {
  const assetPath: string;
  export default assetPath;
}

declare module 'onnxruntime-web/ort-wasm-simd-threaded.wasm' {
  const assetPath: string;
  export default assetPath;
}
