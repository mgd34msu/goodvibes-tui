/**
 * Language detection and grammar package mapping for tree-sitter.
 */

// Extension → language ID map
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  rb: 'ruby',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  css: 'css',
  scss: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
};

// Language IDs that have special grammar package names
const LANG_TO_PACKAGE: Record<string, string> = {
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-typescript', // tsx grammar is in tree-sitter-typescript package
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  rust: 'tree-sitter-rust',
  go: 'tree-sitter-go',
  java: 'tree-sitter-java',
  c: 'tree-sitter-c',
  cpp: 'tree-sitter-cpp',
  ruby: 'tree-sitter-ruby',
  bash: 'tree-sitter-bash',
  json: 'tree-sitter-json',
  yaml: 'tree-sitter-yaml',
  toml: 'tree-sitter-toml',
  css: 'tree-sitter-css',
  html: 'tree-sitter-html',
  markdown: 'tree-sitter-markdown',
};

/**
 * Map a file extension (or full path) to a tree-sitter language ID.
 * Returns null if the language is not supported.
 */
export function detectLanguage(filePath: string): string | null {
  const parts = filePath.split('.');
  if (parts.length < 2) return null;
  const ext = parts[parts.length - 1].toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

/**
 * Map a language ID to the npm package name that provides its grammar.
 */
export function getGrammarPackage(langId: string): string {
  return LANG_TO_PACKAGE[langId] ?? `tree-sitter-${langId}`;
}

/**
 * Return all supported language IDs.
 */
export function getSupportedLanguages(): string[] {
  return Object.keys(LANG_TO_PACKAGE);
}
