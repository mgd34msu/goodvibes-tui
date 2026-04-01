import { readFileSync, writeFileSync } from 'node:fs';
import { logger } from '../../utils/logger.ts';
import { recordChange } from '../../sessions/change-tracker.ts';
import { FileUndoManager } from '../../state/file-undo.ts';
import { extname, relative } from 'node:path';
import type { Tool, ToolDefinition } from '../../types/tools.ts';
import { FileStateCache, unifiedDiff } from '../../state/file-cache.ts';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import { editSchema } from './schema.ts';
import { autoHealer } from '../shared/auto-heal.ts';
import { isNotebookFile } from '../../utils/notebook.ts';
import * as astGrep from '@ast-grep/napi';
import { CodeIntelligence, ImportGraph } from '../../intelligence/index.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OccurrenceSpec = 'first' | 'last' | 'all' | number;

interface EditItem {
  path: string;
  find: string;
  find_base64?: string;
  replace: string;
  replace_base64?: string;
  id?: string;
  occurrence?: OccurrenceSpec;
  hints?: {
    near_line?: number;
    in_function?: string;
    in_class?: string;
    after?: string;
    before?: string;
  };
}

type ValidatorName = 'typecheck' | 'lint' | 'test' | 'build';

interface EditInput {
  edits?: EditItem[];
  notebook_operations?: NotebookOperationsInput;
  match?: {
    mode?: 'exact' | 'fuzzy' | 'regex' | 'ast' | 'ast_pattern';
    case_sensitive?: boolean;
    whitespace_sensitive?: boolean;
    multiline?: boolean;
  };
  transaction?: {
    mode?: 'atomic' | 'partial' | 'none';
  };
  output?: {
    format?: 'count_only' | 'minimal' | 'with_diff' | 'verbose';
    diff_context?: number;
  };
  dry_run?: boolean;
  validate?: {
    before?: ValidatorName[];
    after?: ValidatorName[];
  };
}

type EditResultStatus = 'applied' | 'not_found' | 'ambiguous' | 'conflict' | 'failed';

const DIFF_TRUNCATE_THRESHOLD = 5000;
const DIFF_PREVIEW_LENGTH = 500;

interface EditResult {
  id?: string;
  path: string;
  success: boolean;
  status?: EditResultStatus;
  occurrencesReplaced?: number;
  diff?: string;
  diff_truncated?: boolean;
  diff_preview?: string;
  error?: string;
  hint?: string;
  warning?: string;
}

// ---------------------------------------------------------------------------
// Notebook types
// ---------------------------------------------------------------------------

interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string | string[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
  id?: string;
}

interface JupyterNotebook {
  nbformat: number;
  nbformat_minor: number;
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
}

interface NotebookOperation {
  op: 'replace' | 'insert' | 'delete';
  cell?: number;
  cell_id?: string;
  after?: number;
  source?: string;
  cell_type?: 'code' | 'markdown' | 'raw';
  clear_outputs?: boolean;
}

interface NotebookOperationsInput {
  path: string;
  operations: NotebookOperation[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf-8');
}

/** Map validator name to shell command. */
const VALIDATOR_COMMANDS: Record<ValidatorName, string[]> = {
  typecheck: ['npx', 'tsc', '--noEmit'],
  lint: ['npx', 'eslint', '--no-error-on-unmatched-pattern'],
  test: ['bun', 'test'],
  build: ['bun', 'run', 'build'],
};

interface ValidatorResult {
  validator: ValidatorName;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a single validator via Bun.spawn. Times out after 30 seconds.
 */
async function runValidator(name: ValidatorName, cwd: string): Promise<ValidatorResult> {
  const cmd = VALIDATOR_COMMANDS[name];
  const TIMEOUT_MS = 30_000;

  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);

  const [exitCode, stdoutBuf, stderrBuf] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  clearTimeout(timeoutHandle);

  if (timedOut) {
    return {
      validator: name,
      passed: false,
      stdout: '',
      stderr: `Validator '${name}' timed out after ${TIMEOUT_MS}ms`,
      exitCode: -1,
    };
  }

  return {
    validator: name,
    passed: exitCode === 0,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    exitCode,
  };
}

/**
 * Run all validators in sequence. Returns first failure, or null if all pass.
 */
async function runValidators(
  validators: ValidatorName[],
  cwd: string,
): Promise<ValidatorResult | null> {
  for (const name of validators) {
    const result = await runValidator(name, cwd);
    if (!result.passed) return result;
  }
  return null;
}

/** Format a validator failure into a human-readable message. */
function formatValidatorFailure(result: ValidatorResult): string {
  const parts = [`Validator '${result.validator}' failed (exit ${result.exitCode}):`];
  if (result.stderr.trim()) parts.push(result.stderr.trim());
  if (result.stdout.trim()) parts.push(result.stdout.trim());
  return parts.join('\n');
}

/**
 * Normalize whitespace for fuzzy matching: collapse runs of whitespace
 * (spaces, tabs, newlines) into a single space, then trim.
 */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Line-based fuzzy match: slide a window of the same line count as `findStr`
 * through `content`, comparing lines with whitespace normalization.
 * Returns the best match position and similarity (0–1), or null if findStr has
 * no lines.
 *
 * Similarity = (number of lines that match after normalization) / totalFindLines.
 */
function findFuzzyLineMatch(
  content: string,
  findStr: string,
): { start: number; end: number; similarity: number; candidateLines: string[] } | null {
  const findLines = findStr.split('\n');
  // content.split('\n') handles CRLF — \r stays at line end but is normalized away by normalizeWhitespace
  const contentLines = content.split('\n');

  if (findLines.length === 0 || contentLines.length === 0) return null;

  // Skip fuzzy matching for very large files to avoid O(N*M) performance hit
  if (contentLines.length > MAX_FUZZY_FILE_LINES) return null;

  // Pre-compute cumulative byte offsets for each line in content
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of contentLines) {
    lineOffsets.push(offset);
    offset += line.length + 1; // +1 for '\n'
  }

  const normalizedFind = findLines.map(normalizeWhitespace);
  const normalizedContent = contentLines.map(normalizeWhitespace);
  const windowSize = findLines.length;

  let bestSimilarity = -1;
  let bestStart = 0;
  let bestEnd = 0;
  let bestCandidateLines: string[] = [];

  const limit = contentLines.length - windowSize + 1;
  for (let i = 0; i < limit; i++) {
    let matchingLines = 0;
    for (let j = 0; j < windowSize; j++) {
      if (normalizedContent[i + j] === normalizedFind[j]) {
        matchingLines++;
      }
    }
    const similarity = matchingLines / windowSize;
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestStart = lineOffsets[i];
      // End offset: start of line after the window, including the trailing newline
      const lastLineIdx = i + windowSize - 1;
      bestEnd =
        lastLineIdx + 1 < contentLines.length
          ? lineOffsets[lastLineIdx + 1] // includes the '\n' at end of last window line
          : content.length; // last line in file has no trailing newline
      bestCandidateLines = contentLines.slice(i, i + windowSize);
      if (similarity === 1.0) break; // perfect match — no need to check remaining windows
    }
  }

  if (bestSimilarity < 0) return null;

  return {
    start: bestStart,
    end: bestEnd,
    similarity: bestSimilarity,
    candidateLines: bestCandidateLines,
  };
}

/**
 * Get line number (1-based) of a character offset within content.
 */
function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

/**
 * Find all match positions (start indices) of `pattern` in `content`.
 * Respects match mode and case sensitivity.
 */
function findAllPositions(
  content: string,
  find: string,
  mode: 'exact' | 'fuzzy' | 'regex',
  caseSensitive: boolean,
  whitespaceSensitive: boolean = true,
  multiline: boolean = false,
): { start: number; end: number }[] {
  const positions: { start: number; end: number }[] = [];

  if (mode === 'regex') {
    let flags = caseSensitive ? 'g' : 'gi';
    if (multiline) {
      if (!flags.includes('s')) flags += 's'; // dotAll: . matches newlines
      if (!flags.includes('m')) flags += 'm'; // multiline: ^/$ per line
    }
    const re = new RegExp(find, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      positions.push({ start: m.index, end: m.index + m[0].length });
      // Avoid infinite loop on zero-length matches
      if (m[0].length === 0) re.lastIndex++;
    }
    return positions;
  }

  if (mode === 'fuzzy') {
    // Normalize the find string, then search the normalized content
    // keeping track of original offsets by scanning the original text
    const normalizedFind = normalizeWhitespace(caseSensitive ? find : find.toLowerCase());
    if (!normalizedFind) return [];

    // Build a mapping from normalized position to original position
    // by tokenizing the original on whitespace boundaries
    const tokens: { norm: string; origStart: number; origEnd: number }[] = [];
    const tokenRe = /\S+/g;
    let tm: RegExpExecArray | null;
    const compareContent = caseSensitive ? content : content.toLowerCase();
    while ((tm = tokenRe.exec(content)) !== null) {
      tokens.push({
        norm: compareContent.slice(tm.index, tm.index + tm[0].length),
        origStart: tm.index,
        origEnd: tm.index + tm[0].length,
      });
    }

    // The normalized find string as tokens
    const findTokens = normalizedFind.split(' ').filter(Boolean);
    if (findTokens.length === 0) return [];

    for (let i = 0; i <= tokens.length - findTokens.length; i++) {
      let match = true;
      for (let j = 0; j < findTokens.length; j++) {
        if (tokens[i + j].norm !== findTokens[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        positions.push({
          start: tokens[i].origStart,
          end: tokens[i + findTokens.length - 1].origEnd,
        });
      }
    }
    return positions;
  }

  // exact mode
  if (!whitespaceSensitive) {
    // Normalize whitespace in both find and content, then match token-by-token
    // (reuse the fuzzy token-matching algorithm)
    return findAllPositions(content, find, 'fuzzy', caseSensitive, true);
  }
  const needle = caseSensitive ? find : find.toLowerCase();
  const haystack = caseSensitive ? content : content.toLowerCase();
  let idx = 0;
  while (true) {
    const pos = haystack.indexOf(needle, idx);
    if (pos === -1) break;
    positions.push({ start: pos, end: pos + find.length });
    idx = pos + 1;
  }
  return positions;
}

/**
 * Apply scope hints to filter positions.
 * in_function and in_class use simple heuristic: scan for
 * `function name` / `class name` before the match position,
 * then confirm the match is within a plausible brace scope.
 */
function applyHints(
  content: string,
  positions: { start: number; end: number }[],
  hints: EditItem['hints'],
  nearLine?: number,
): { positions: { start: number; end: number }[]; warning?: string } {
  if (!hints) return { positions };

  let filtered = positions;
  let warning: string | undefined;

  // after: only keep positions that appear after this anchor text in the file
  if (hints.after) {
    const anchorIdx = content.indexOf(hints.after);
    if (anchorIdx === -1) {
      return { positions: [], warning: `after anchor "${hints.after}" not found in file` };
    }
    const afterOffset = anchorIdx + hints.after.length;
    filtered = filtered.filter((pos) => pos.start >= afterOffset);
  }

  // before: only keep positions that appear before this anchor text in the file
  if (hints.before) {
    const anchorIdx = content.indexOf(hints.before);
    if (anchorIdx === -1) {
      return { positions: [], warning: `before anchor "${hints.before}" not found in file` };
    }
    filtered = filtered.filter((pos) => pos.end <= anchorIdx);
  }

  if (hints.in_function) {
    const name = hints.in_function;
    // Match function declarations: function name, const name = (async)? (...) =>, name(...) {
    const scopeRe = new RegExp(
      `(?:function\\s+${escapeRegex(name)}\\s*\\(|(?:const|let|var)\\s+${escapeRegex(name)}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|\\w+)\\s*=>|${escapeRegex(name)}\\s*\\()`,
      'g',
    );
    filtered = filterByScope(content, filtered, scopeRe);
  }

  if (hints.in_class) {
    const name = hints.in_class;
    const scopeRe = new RegExp(`class\\s+${escapeRegex(name)}\\s*(?:extends[^{]+)?\\{`, 'g');
    filtered = filterByScope(content, filtered, scopeRe);
  }

  if (nearLine !== undefined && filtered.length > 1) {
    // Pick the occurrence closest to the given line number
    let best = filtered[0];
    let bestDist = Math.abs(lineNumberAt(content, best.start) - nearLine);
    for (const pos of filtered.slice(1)) {
      const dist = Math.abs(lineNumberAt(content, pos.start) - nearLine);
      if (dist < bestDist) {
        bestDist = dist;
        best = pos;
      }
    }
    filtered = [best];
  }

  return { positions: filtered, warning };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Filter positions to only those that fall within a scope found by scopeRe.
 * Uses a simple brace-counting heuristic.
 */
function filterByScope(
  content: string,
  positions: { start: number; end: number }[],
  scopeRe: RegExp,
): { start: number; end: number }[] {
  const scopes: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = scopeRe.exec(content)) !== null) {
    const scopeStart = m.index;
    // Find the opening brace
    let braceStart = content.indexOf('{', m.index + m[0].length - 1);
    if (braceStart === -1) continue;
    // Count braces to find matching close
    let depth = 0;
    let i = braceStart;
    for (; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    scopes.push({ start: scopeStart, end: i });
  }

  if (scopes.length === 0) return [];

  return positions.filter((pos) =>
    scopes.some((scope) => pos.start >= scope.start && pos.end <= scope.end),
  );
}

/**
 * Select which occurrence(s) to replace based on the occurrence spec.
 * Returns the filtered/selected positions, or an error string.
 */
function selectOccurrences(
  positions: { start: number; end: number }[],
  occurrence: OccurrenceSpec | undefined,
): { selected: { start: number; end: number }[] } | { error: string; hint?: string } {
  if (positions.length === 0) {
    return { error: 'Find string not found in file', hint: 'Check that the find string matches the file content exactly, including whitespace and line endings.' };
  }

  if (occurrence === undefined) {
    // Default: must be exactly one occurrence
    if (positions.length > 1) {
      return {
        error: `Ambiguous match: find string appears ${positions.length} times. Specify occurrence: 'first', 'last', 'all', or a number.`,
        hint: `Pattern matched ${positions.length} times — use occurrence: 'first', 'last', 'all', or a number (1-${positions.length}) to disambiguate.`,
      };
    }
    return { selected: positions };
  }

  if (occurrence === 'first') {
    return { selected: [positions[0]] };
  }
  if (occurrence === 'last') {
    return { selected: [positions[positions.length - 1]] };
  }
  if (occurrence === 'all') {
    return { selected: positions };
  }
  // Numeric (1-based)
  const n = occurrence as number;
  if (n < 1 || n > positions.length) {
    return {
      error: `Occurrence ${n} out of range: file has ${positions.length} match(es)`,
    };
  }
  return { selected: [positions[n - 1]] };
}

/**
 * Apply replacements to content, working right-to-left to preserve offsets.
 * For regex mode, supports capture group back-references ($1, $2, ...).
 */
function applyReplacements(
  content: string,
  selections: { start: number; end: number }[],
  find: string,
  replace: string,
  mode: 'exact' | 'fuzzy' | 'regex',
  caseSensitive: boolean,
): string {
  // Sort right-to-left so earlier offsets aren't invalidated
  const sorted = [...selections].sort((a, b) => b.start - a.start);
  let result = content;
  for (const { start, end } of sorted) {
    let replacement = replace;
    if (mode === 'regex') {
      // Re-run the regex on just this match to get capture groups
      try {
        const flags = caseSensitive ? '' : 'i';
        const re = new RegExp(find, flags);
        const m = re.exec(content.slice(start, end));
        if (m) {
          replacement = replace.replace(/\$(\d+)/g, (_full, digit) => {
            return m[parseInt(digit)] ?? '';
          });
        }
      } catch {
        // Invalid regex for capture group substitution — use literal replacement
      }
    }
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}

/**
 * Compute the edit for a single EditItem against file content.
 * Returns the new content and metadata, or an error.
 */
// ---------------------------------------------------------------------------
// AST-grep language resolver (mirrors find tool)
// ---------------------------------------------------------------------------

type AstGrepNode = {
  text(): string;
  range(): { start: { line: number; column: number; index: number }; end: { line: number; column: number; index: number } };
  getMatch(name: string): AstGrepNode | null;
  getMultipleMatches(name: string): AstGrepNode[];
};
type AstGrepParser = { parse: (src: string) => { root(): { findAll(pat: string): AstGrepNode[] } } };

function getAstGrepLang(filePath: string): AstGrepParser | null {
  const lang = extname(filePath).slice(1).toLowerCase();
  switch (lang) {
    case 'ts': return astGrep.ts as unknown as AstGrepParser;
    case 'tsx': return astGrep.tsx as unknown as AstGrepParser;
    case 'js': case 'mjs': case 'cjs': return astGrep.js as unknown as AstGrepParser;
    case 'jsx': return astGrep.jsx as unknown as AstGrepParser;
    case 'css': return astGrep.css as unknown as AstGrepParser;
    case 'html': return astGrep.html as unknown as AstGrepParser;
    default: return null;
  }
}

/**
 * ast_pattern mode: use @ast-grep/napi to find all pattern matches and replace them.
 * Supports metavariables like $VAR, $$$ARGS.
 * The file path is used to determine the language parser.
 * Falls back to exact matching if the parser is unavailable or an error occurs.
 */
function computeAstPatternEdit(
  fileContent: string,
  item: EditItem,
  filePath: string,
): { newContent: string; occurrencesReplaced: number } | { error: string } {
  const findStr = item.find_base64 ? decodeBase64(item.find_base64) : item.find;
  const replaceStr = item.replace_base64 ? decodeBase64(item.replace_base64) : item.replace;

  const parser = getAstGrepLang(filePath);
  if (!parser) {
    // Fall back to exact matching for unknown file types
    return computeExactEdit(fileContent, item);
  }

  let root: ReturnType<AstGrepParser['parse']>;
  try {
    root = parser.parse(fileContent);
  } catch (e) {
    logger.debug('AST pattern parse failed', { error: String(e) });
    return computeExactEdit(fileContent, item);
  }

  let matches: AstGrepNode[];
  try {
    matches = root.root().findAll(findStr);
  } catch (err) {
    return { error: `ast_pattern: invalid pattern '${findStr}': ${err instanceof Error ? err.message : String(err)}` };
  }

  if (matches.length === 0) {
    return { error: `ast_pattern: no matches found for pattern '${findStr}'` };
  }

  // Select occurrences
  const positions = matches.map((m) => ({
    start: m.range().start.index,
    end: m.range().end.index,
    text: m.text(),
    node: m,
  }));

  const occSpec = item.occurrence;
  let selected: typeof positions;
  if (occSpec === undefined) {
    if (positions.length > 1) {
      return { error: `ast_pattern: ${positions.length} matches found — set occurrence to 'first', 'last', 'all', or N to disambiguate` };
    }
    selected = positions;
  } else if (occSpec === 'all') {
    selected = positions;
  } else if (occSpec === 'first') {
    selected = positions.slice(0, 1);
  } else if (occSpec === 'last') {
    selected = positions.slice(-1);
  } else if (typeof occSpec === 'number') {
    if (occSpec < 1 || occSpec > positions.length) {
      return { error: `ast_pattern: occurrence ${occSpec} out of range (found ${positions.length} matches)` };
    }
    selected = [positions[occSpec - 1]];
  } else {
    selected = positions;
  }

  // Apply replacements in reverse order to preserve offsets.
  // Substitute metavariables in the replace string for each match:
  // $$$VAR -> joined text of getMultipleMatches('VAR'), $VAR -> getMatch('VAR').text()
  const sorted = [...selected].sort((a, b) => b.start - a.start);
  let newContent = fileContent;
  for (const pos of sorted) {
    let replacement = replaceStr;
    // Substitute $$$ (multi-match) first to avoid partial replacement by $ substitution
    replacement = replacement.replace(/\$\$\$([A-Z_][A-Z0-9_]*)/g, (_, varName: string) => {
      const nodes = pos.node.getMultipleMatches(varName);
      return nodes.map((n) => n.text()).join(', ');
    });
    // Substitute single $ metavariables
    replacement = replacement.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, varName: string) => {
      const node = pos.node.getMatch(varName);
      return node ? node.text() : _;
    });
    newContent = newContent.slice(0, pos.start) + replacement + newContent.slice(pos.end);
  }

  return { newContent, occurrencesReplaced: selected.length };
}

/**
 * ast mode: use tree-sitter via CodeIntelligence to find structural matches.
 * The find string is interpreted as a code snippet and matched as a substring
 * of the parsed AST node text (structural equivalence via text normalization).
 * Falls back to exact matching if tree-sitter is unavailable.
 */
async function computeAstEdit(
  fileContent: string,
  item: EditItem,
  filePath: string,
): Promise<{ newContent: string; occurrencesReplaced: number } | { error: string }> {
  const findStr = item.find_base64 ? decodeBase64(item.find_base64) : item.find;
  const replaceStr = item.replace_base64 ? decodeBase64(item.replace_base64) : item.replace;

  let intel: CodeIntelligence;
  try {
    intel = CodeIntelligence.getInstance();
  } catch (e) {
    logger.debug('CodeIntelligence instance not available', { error: String(e) });
    return computeExactEdit(fileContent, item);
  }

  if (!intel.hasTreeSitter(filePath)) {
    return computeExactEdit(fileContent, item);
  }

  // Use tree-sitter to get the parse tree, then find nodes whose text
  // matches the normalized find string (whitespace-insensitive structural match)
  let symbols: Awaited<ReturnType<typeof intel.getSymbols>>;
  try {
    symbols = await intel.getSymbols(filePath, fileContent);
  } catch {
    return computeExactEdit(fileContent, item);
  }

  // Build positions from lines where symbol text matches the find string
  // (normalizing whitespace for structural equivalence)
  const normalizedFind = findStr.replace(/\s+/g, ' ').trim();

  const positions: { start: number; end: number }[] = [];
  const lines = fileContent.split('\n');

  for (const symbol of symbols) {
    // Check if the symbol's name or signature includes the normalized find
    const sig = (symbol.signature ?? symbol.name ?? '').replace(/\s+/g, ' ').trim();
    if (sig.includes(normalizedFind) || normalizedFind.includes(sig)) {
      // Find the line offset in the file
      let lineOffset = 0;
      for (let i = 0; i < symbol.line - 1 && i < lines.length; i++) {
        lineOffset += lines[i].length + 1; // +1 for '\n'
      }
      const lineText = lines[symbol.line - 1] ?? '';
      const col = lineText.indexOf(findStr);
      if (col >= 0) {
        positions.push({ start: lineOffset + col, end: lineOffset + col + findStr.length });
      }
    }
  }

  // If no structural match found, fall back to finding the text literally in the file
  if (positions.length === 0) {
    // Try a broader match: find the find string as a substring in the file
    // (normalized-whitespace aware)
    return computeExactEdit(fileContent, item);
  }

  // Select occurrences
  const selResult = selectOccurrences(positions, item.occurrence);
  if ('error' in selResult) return selResult;

  const newContent = applyReplacements(
    fileContent,
    selResult.selected,
    findStr,
    replaceStr,
    'exact',
    true,
  );

  return { newContent, occurrencesReplaced: selResult.selected.length };
}

/**
 * Pure exact-match edit (no AST). Used as the fallback from ast/ast_pattern modes.
 */
function computeExactEdit(
  fileContent: string,
  item: EditItem,
): { newContent: string; occurrencesReplaced: number } | { error: string } {
  const findStr = item.find_base64 ? decodeBase64(item.find_base64) : item.find;
  const replaceStr = item.replace_base64 ? decodeBase64(item.replace_base64) : item.replace;

  const positions = findAllPositions(fileContent, findStr, 'exact', true, true);
  if (positions.length === 0) {
    return { error: `No match found for '${findStr}'` };
  }

  const selResult = selectOccurrences(positions, item.occurrence);
  if ('error' in selResult) return selResult;

  const newContent = applyReplacements(fileContent, selResult.selected, findStr, replaceStr, 'exact', true);
  return { newContent, occurrencesReplaced: selResult.selected.length };
}

const FUZZY_MATCH_THRESHOLD = 0.7;
const MAX_FUZZY_FILE_LINES = 5000;

function computeSingleEdit(
  fileContent: string,
  item: EditItem,
  mode: 'exact' | 'fuzzy' | 'regex',
  caseSensitive: boolean,
  whitespaceSensitive: boolean = true,
  multiline: boolean = false,
): { newContent: string; occurrencesReplaced: number; warning?: string } | { error: string; hint?: string } {
  const findStr = item.find_base64 ? decodeBase64(item.find_base64) : item.find;
  const replaceStr = item.replace_base64 ? decodeBase64(item.replace_base64) : item.replace;

  // Find all positions (regex mode may throw on invalid patterns)
  let positions: { start: number; end: number }[];
  try {
    positions = findAllPositions(fileContent, findStr, mode, caseSensitive, whitespaceSensitive, multiline);
  } catch (err) {
    return { error: `Invalid find pattern: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Apply hints
  let hintsWarning: string | undefined;
  if (item.hints) {
    const hintsResult = applyHints(fileContent, positions, item.hints, item.hints.near_line);
    positions = hintsResult.positions;
    hintsWarning = hintsResult.warning;
  }

  // When exact match produces no positions, try progressive fallbacks
  let usedFallback: 'whitespace' | 'fuzzy-lines' | null = null;
  if (positions.length === 0 && mode === 'exact') {
    // Fallback 1: whitespace-normalized match
    const wsPositions = findAllPositions(fileContent, findStr, 'fuzzy', caseSensitive, true);
    if (wsPositions.length > 0) {
      positions = wsPositions;
      usedFallback = 'whitespace';
    } else {
      // Fallback 2: line-based fuzzy match
      const fuzzyMatch = findFuzzyLineMatch(fileContent, findStr);
      if (fuzzyMatch !== null && fuzzyMatch.similarity >= FUZZY_MATCH_THRESHOLD) {
        positions = [{ start: fuzzyMatch.start, end: fuzzyMatch.end }];
        usedFallback = 'fuzzy-lines';
        logger.warn('[edit] Fuzzy line match used', {
          similarity: fuzzyMatch.similarity,
          file: item.path,
          findPreview: findStr.split('\n').slice(0, 2).join('\n'),
        });
      } else if (fuzzyMatch !== null) {
        // Below threshold — return a helpful error showing the closest candidate
        const candidatePreview = fuzzyMatch.candidateLines.slice(0, 3).join('\n');
        const pct = Math.round(fuzzyMatch.similarity * 100);
        return {
          error:
            `Find string not found in file (best match was ${pct}% similar, below the ${Math.round(FUZZY_MATCH_THRESHOLD * 100)}% threshold).\n` +
            `Closest candidate (first 3 lines):\n${candidatePreview}\n` +
            `Tip: correct the find string to match the file content exactly.`,
          hint: `Did you mean this? (${pct}% match):\n${candidatePreview}`,
        };
      } else {
        return { error: 'Find string not found in file', hint: 'The find string was not found. Check spelling, whitespace, and that the file has been read recently.' };
      }
    }
  }

  // Select occurrences
  const selResult = selectOccurrences(positions, item.occurrence);
  if ('error' in selResult) return selResult;

  const newContent = applyReplacements(
    fileContent,
    selResult.selected,
    findStr,
    replaceStr,
    mode,
    caseSensitive,
  );

  let warning: string | undefined = hintsWarning;
  if (usedFallback === 'whitespace') {
    warning = 'Exact match failed; used whitespace-normalized match instead.';
  } else if (usedFallback === 'fuzzy-lines') {
    warning = 'Exact match failed; used fuzzy line match (content may differ slightly — verify the edit).';
  }

  return { newContent, occurrencesReplaced: selResult.selected.length, warning };
}

// ---------------------------------------------------------------------------
// Notebook helpers
// ---------------------------------------------------------------------------

/** Split a source string into a notebook source array (line array with preserved newlines). */
function normalizeSource(source: string | string[]): string[] {
  if (Array.isArray(source)) return source;
  const lines = source.split('\n');
  return lines.map((line, i) => (i < lines.length - 1 ? line + '\n' : line));
}

/** Validate that a parsed value is a JupyterNotebook. */
function validateNotebook(parsed: unknown): parsed is JupyterNotebook {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const nb = parsed as Record<string, unknown>;
  if (typeof nb['nbformat'] !== 'number') return false;
  if (!Array.isArray(nb['cells'])) return false;
  // Validate cell structure
  for (const cell of nb['cells'] as unknown[]) {
    if (!cell || typeof cell !== 'object') return false;
    const c = cell as Record<string, unknown>;
    if (!c['cell_type'] || typeof c['cell_type'] !== 'string') return false;
    if (c['source'] === undefined) return false;
  }
  return true;
}

/** Find a cell by id field or metadata.id. Returns -1 if not found. */
function resolveCellId(cells: NotebookCell[], cellId: string): number {
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.id === cellId) return i;
    if (cell.metadata && (cell.metadata as Record<string, unknown>)['id'] === cellId) return i;
  }
  return -1;
}

/** Generate a random 8-character alphanumeric cell ID, collision-safe. */
function generateCellId(existingCells?: NotebookCell[]): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const existingIds = new Set(existingCells?.map((c) => c.id).filter(Boolean) ?? []);
  let id: string;
  do {
    id = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (existingIds.has(id));
  return id;
}

/** Apply notebook operations to a JupyterNotebook. Returns summary info. */
function applyNotebookOperations(
  notebook: JupyterNotebook,
  operations: NotebookOperation[],
): { success: boolean; applied: number; summary: string; error?: string } {
  const needsCellIds = notebook.nbformat > 4 ||
    (notebook.nbformat === 4 && (notebook.nbformat_minor ?? 0) >= 5);

  let indexOffset = 0;
  let applied = 0;
  const summaryLines: string[] = [];

  for (const op of operations) {
    if (op.op === 'replace') {
      // Resolve target cell
      let idx: number;
      if (op.cell_id !== undefined) {
        idx = resolveCellId(notebook.cells, op.cell_id);
        if (idx === -1) {
          return { success: false, applied, summary: summaryLines.join('\n'), error: `replace: cell_id '${op.cell_id}' not found` };
        }
      } else if (op.cell !== undefined) {
        idx = op.cell + indexOffset;
        if (idx < 0 || idx >= notebook.cells.length) {
          return { success: false, applied, summary: summaryLines.join('\n'), error: `replace: cell index ${op.cell} out of range (notebook has ${notebook.cells.length} cells)` };
        }
      } else {
        return { success: false, applied, summary: summaryLines.join('\n'), error: 'replace: requires cell or cell_id' };
      }

      if (op.source === undefined) {
        return { success: false, applied, summary: summaryLines.join('\n'), error: 'replace: source is required' };
      }

      const cell = notebook.cells[idx];
      cell.source = normalizeSource(op.source);

      // Optionally change cell_type
      if (op.cell_type !== undefined && op.cell_type !== cell.cell_type) {
        cell.cell_type = op.cell_type;
        if (op.cell_type === 'code') {
          if (cell.execution_count === undefined) cell.execution_count = null;
          if (cell.outputs === undefined) cell.outputs = [];
        } else {
          delete cell.execution_count;
          delete cell.outputs;
        }
      }

      if (op.clear_outputs && cell.cell_type === 'code') {
        cell.outputs = [];
        cell.execution_count = null;
      }

      summaryLines.push(`  OK: replace cell[${idx}]`);
      applied++;

    } else if (op.op === 'insert') {
      if (op.source === undefined) {
        return { success: false, applied, summary: summaryLines.join('\n'), error: 'insert: source is required' };
      }
      if (op.cell_type === undefined) {
        return { success: false, applied, summary: summaryLines.join('\n'), error: 'insert: cell_type is required' };
      }

      const newCell: NotebookCell = {
        cell_type: op.cell_type,
        source: normalizeSource(op.source),
        metadata: {},
      };
      if (op.cell_type === 'code') {
        newCell.execution_count = null;
        newCell.outputs = [];
      }
      if (needsCellIds) {
        newCell.id = generateCellId(notebook.cells);
      }

      // Determine insert position
      let insertAt: number;
      if (op.cell_id !== undefined) {
        // Insert after the cell with this ID
        const refIdx = resolveCellId(notebook.cells, op.cell_id);
        if (refIdx === -1) {
          return { success: false, applied, summary: summaryLines.join('\n'), error: `insert: cell_id '${op.cell_id}' not found` };
        }
        insertAt = refIdx + 1;
      } else if (op.after !== undefined) {
        if (op.after === -1) {
          insertAt = 0;
        } else {
          const adjustedAfter = op.after + indexOffset;
          if (adjustedAfter < -1 || adjustedAfter >= notebook.cells.length) {
            return { success: false, applied, summary: summaryLines.join('\n'), error: `insert: after index ${op.after} out of bounds (-1 to ${notebook.cells.length - 1})` };
          }
          insertAt = adjustedAfter + 1;
        }
      } else {
        // Append at end
        insertAt = notebook.cells.length;
      }

      notebook.cells.splice(insertAt, 0, newCell);
      indexOffset++;
      summaryLines.push(`  OK: insert cell at[${insertAt}]`);
      applied++;

    } else if (op.op === 'delete') {
      let idx: number;
      if (op.cell_id !== undefined) {
        idx = resolveCellId(notebook.cells, op.cell_id);
        if (idx === -1) {
          return { success: false, applied, summary: summaryLines.join('\n'), error: `delete: cell_id '${op.cell_id}' not found` };
        }
      } else if (op.cell !== undefined) {
        idx = op.cell + indexOffset;
        if (idx < 0 || idx >= notebook.cells.length) {
          return { success: false, applied, summary: summaryLines.join('\n'), error: `delete: cell index ${op.cell} out of range (notebook has ${notebook.cells.length} cells)` };
        }
      } else {
        return { success: false, applied, summary: summaryLines.join('\n'), error: 'delete: requires cell or cell_id' };
      }

      notebook.cells.splice(idx, 1);
      indexOffset--;
      summaryLines.push(`  OK: delete cell[${idx}]`);
      applied++;
    }
  }

  return { success: true, applied, summary: summaryLines.join('\n') };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatOutput(
  results: EditResult[],
  format: 'count_only' | 'minimal' | 'with_diff' | 'verbose',
  dryRun: boolean,
): string {
  const totalApplied = results.filter((r) => r.success).length;
  const totalFailed = results.filter((r) => !r.success).length;
  const dryTag = dryRun ? ' (dry run)' : '';

  if (format === 'count_only') {
    return JSON.stringify({ applied: totalApplied, failed: totalFailed, dry_run: dryRun });
  }

  const lines: string[] = [];
  lines.push(`Edits applied: ${totalApplied}, failed: ${totalFailed}${dryTag}`);

  if (format === 'minimal') {
    for (const r of results) {
      if (r.success) {
        const id = r.id ? ` [${r.id}]` : '';
        const statusTag = r.status ? ` [${r.status}]` : '';
        lines.push(`  OK${statusTag}${id}: ${r.path} (${r.occurrencesReplaced} replacement(s))`);
        if (r.warning) {
          lines.push(`    WARN: ${r.warning}`);
        }
      } else {
        const id = r.id ? ` [${r.id}]` : '';
        const statusTag = r.status ? ` [${r.status}]` : '';
        lines.push(`  FAIL${statusTag}${id}: ${r.path} — ${r.error}`);
        if (r.hint) {
          lines.push(`    HINT: ${r.hint}`);
        }
      }
    }
    return lines.join('\n');
  }

  // with_diff or verbose
  for (const r of results) {
    const id = r.id ? ` [${r.id}]` : '';
    if (r.success) {
      const statusTag = r.status ? ` [${r.status}]` : '';
      lines.push(`\n--- ${r.path}${id}${statusTag} (${r.occurrencesReplaced} replacement(s))${dryTag} ---`);
      if (r.diff) {
        if (r.diff_truncated) {
          lines.push(`[diff truncated — showing first ${DIFF_PREVIEW_LENGTH} chars]`);
          lines.push(r.diff_preview ?? r.diff.slice(0, DIFF_PREVIEW_LENGTH));
        } else {
          lines.push(r.diff);
        }
      }
      if (r.warning) {
        lines.push(`  WARN: ${r.warning}`);
      }
    } else {
      const statusTag = r.status ? ` [${r.status}]` : '';
      lines.push(`\n--- ${r.path}${id}${statusTag} FAILED ---`);
      lines.push(`  Error: ${r.error}`);
      if (r.hint) {
        lines.push(`  Hint: ${r.hint}`);
      }
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export interface EditToolOptions {
  /** Working directory for validator commands. Defaults to process.cwd(). */
  cwd?: string;
  /** Optional FileUndoManager for /undo file support. */
  fileUndoManager?: FileUndoManager;
}

export function createEditTool(fileCache: FileStateCache, options?: EditToolOptions): Tool {
  const definition: ToolDefinition = {
    name: 'edit',
    description:
      'Edit files by finding and replacing text. Supports exact, fuzzy, and regex matching. ' +
      'Handles multiple edits in one call with atomic or partial transaction semantics. ' +
      'Detects OCC conflicts when files have been modified externally. ' +
      'Also supports Jupyter notebook (.ipynb) cell operations via notebook_operations field.',
    parameters: editSchema as unknown as Record<string, unknown>,
  };

  async function execute(
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
    // Parse and validate input
    let input: EditInput;
    try {
      input = args as unknown as EditInput;
      if (!input.edits && !input.notebook_operations) {
        return { success: false, error: 'Either edits or notebook_operations must be provided' };
      }
      if (input.edits && input.notebook_operations) {
        return { success: false, error: 'Provide either edits or notebook_operations, not both' };
      }
    } catch (err) {
      return { success: false, error: `Invalid input: ${err instanceof Error ? err.message : String(err)}` };
    }

    // --- Notebook operations branch ---
    if (input.notebook_operations) {
      const nbOps = input.notebook_operations;
      const outputFormat = input.output?.format ?? 'minimal';
      const diffContext = input.output?.diff_context ?? 3;
      const dryRun = input.dry_run ?? false;
      const cwd = options?.cwd ?? process.cwd();

      // Runtime input validation
      if (!nbOps.path || typeof nbOps.path !== 'string') {
        return { success: false, error: 'notebook_operations.path is required and must be a string' };
      }
      if (!Array.isArray(nbOps.operations)) {
        return { success: false, error: 'notebook_operations.operations must be an array' };
      }

      let resolvedPath: string;
      try {
        resolvedPath = resolveAndValidatePath(nbOps.path);
      } catch (err) {
        return { success: false, error: `Path error: ${err instanceof Error ? err.message : String(err)}` };
      }

      if (!isNotebookFile(resolvedPath)) {
        return { success: false, error: `notebook_operations requires a .ipynb file, got: ${nbOps.path}` };
      }

      // Check OCC conflict
      const cacheResult = fileCache.lookup(resolvedPath);
      if (cacheResult.status === 'modified') {
        return { success: false, error: `OCC conflict: '${resolvedPath}' was modified externally since last read` };
      }

      // Read and parse notebook
      let rawContent: string;
      try {
        rawContent = readFileSync(resolvedPath, 'utf-8');
      } catch {
        return { success: false, error: `File not found or unreadable: '${resolvedPath}'` };
      }

      let notebook: JupyterNotebook;
      try {
        const parsed: unknown = JSON.parse(rawContent);
        if (!validateNotebook(parsed)) {
          return { success: false, error: `Not a valid Jupyter notebook: missing nbformat or cells array` };
        }
        notebook = parsed;
      } catch (err) {
        return { success: false, error: `Failed to parse notebook JSON: ${err instanceof Error ? err.message : String(err)}` };
      }

      // Run validate.before
      if (!dryRun && (input.validate?.before ?? []).length > 0) {
        const failure = await runValidators(input.validate!.before!, cwd);
        if (failure) {
          return {
            success: false,
            error: `Pre-edit validation failed. ${formatValidatorFailure(failure)}`,
          };
        }
      }

      // Apply notebook operations
      const opsResult = applyNotebookOperations(notebook, nbOps.operations);
      if (!opsResult.success) {
        return { success: false, error: opsResult.error };
      }

      // Serialize notebook
      const newContent = JSON.stringify(notebook, null, 1) + '\n';

      if (dryRun) {
        // Dry run: return summary of what would have been applied without writing
        let output: string;
        if (outputFormat === 'count_only') {
          output = JSON.stringify({ applied: opsResult.applied, failed: 0, dry_run: true });
        } else if (outputFormat === 'minimal') {
          output = `Notebook operations applied: ${opsResult.applied}, failed: 0 (dry run)\n${opsResult.summary}`;
        } else {
          const diff = unifiedDiff(rawContent, newContent, resolvedPath, diffContext);
          output = `Notebook operations applied: ${opsResult.applied}, failed: 0 (dry run)\n${opsResult.summary}\n${diff}`;
        }
        return { success: true, output };
      }

      // Write to disk
      try {
        writeFileSync(resolvedPath, newContent, 'utf-8');
      } catch (err) {
        return { success: false, error: `Write failed for '${resolvedPath}': ${err instanceof Error ? err.message : String(err)}` };
      }

      // Run validate.after
      if ((input.validate?.after ?? []).length > 0) {
        const failure = await runValidators(input.validate!.after!, cwd);
        if (failure) {
          // Restore original content
          try {
            writeFileSync(resolvedPath, rawContent, 'utf-8');
            fileCache.update(resolvedPath, rawContent);
          } catch {
            // Best-effort rollback
          }
          return {
            success: false,
            error: `Post-edit validation failed (notebook restored). ${formatValidatorFailure(failure)}`,
          };
        }
      }

      // Update cache
      fileCache.update(resolvedPath, newContent);

      // Snapshot for /undo support
      if (options?.fileUndoManager) {
        try {
          options.fileUndoManager.snapshot({
            path: resolvedPath,
            beforeContent: rawContent,
            afterContent: newContent,
            tool: 'edit',
          });
        } catch {
          // Non-fatal
        }
      }

      // Track for /diff session change view
      recordChange(resolvedPath);

      logger.debug('[edit] notebook operations applied', { path: resolvedPath, applied: opsResult.applied });

      // Format output
      let output: string;
      if (outputFormat === 'count_only') {
        output = JSON.stringify({ applied: opsResult.applied, failed: 0, dry_run: false });
      } else if (outputFormat === 'minimal') {
        output = `Notebook operations applied: ${opsResult.applied}, failed: 0\n${opsResult.summary}`;
      } else {
        // with_diff / verbose: include a diff
        const diff = unifiedDiff(rawContent, newContent, resolvedPath, diffContext);
        output = `Notebook operations applied: ${opsResult.applied}, failed: 0\n${opsResult.summary}\n${diff}`;
      }

      return { success: true, output };
    }

    // --- Text edits branch ---
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      return { success: false, error: 'edits must be a non-empty array' };
    }

    const matchMode = input.match?.mode ?? 'exact';
    const caseSensitive = input.match?.case_sensitive ?? true;
    const whitespaceSensitive = input.match?.whitespace_sensitive ?? true;
    const multiline = input.match?.multiline ?? false;
    const transactionMode = input.transaction?.mode ?? 'atomic';
    const outputFormat = input.output?.format ?? 'minimal';
    const diffContext = input.output?.diff_context ?? 3;
    const dryRun = input.dry_run ?? false;
    const validateBefore = input.validate?.before ?? [];
    const validateAfter = input.validate?.after ?? [];
    const cwd = options?.cwd ?? process.cwd();

    // Run validate.before
    if (!dryRun && validateBefore.length > 0) {
      const failure = await runValidators(validateBefore, cwd);
      if (failure) {
        return {
          success: false,
          error: `Pre-edit validation failed. ${formatValidatorFailure(failure)}`,
        };
      }
    }

    // Resolve all paths upfront
    const resolvedPaths: Map<string, string> = new Map();
    for (const item of input.edits!) {
      if (resolvedPaths.has(item.path)) continue;
      try {
        resolvedPaths.set(item.path, resolveAndValidatePath(item.path));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // In atomic mode, a single path error fails the whole batch
        if (transactionMode === 'atomic') {
          return { success: false, error: `Path error for '${item.path}': ${msg}` };
        }
      }
    }

    // Gather unique file paths and read content
    const uniquePaths = new Set(input.edits!.map((e) => resolvedPaths.get(e.path) ?? e.path));
    const fileContents: Map<string, string> = new Map();
    const fileReadErrors: Map<string, string> = new Map();

    for (const resolvedPath of uniquePaths) {
      // Check OCC conflict first
      const cacheResult = fileCache.lookup(resolvedPath);
      if (cacheResult.status === 'modified') {
        const msg = `OCC conflict: '${resolvedPath}' was modified externally since last read`;
        if (transactionMode === 'atomic') {
          return { success: false, error: msg };
        }
        fileReadErrors.set(resolvedPath, msg);
        continue;
      }

      try {
        const content = readFileSync(resolvedPath, 'utf-8');
        fileContents.set(resolvedPath, content);
      } catch (err) {
        const msg = `File not found or unreadable: '${resolvedPath}'`;
        if (transactionMode === 'atomic') {
          return { success: false, error: msg };
        }
        fileReadErrors.set(resolvedPath, msg);
      }
    }

    // Compute all edits
    // For atomic: track working copies per file; rollback all on any failure
    // For partial/none: apply edits that succeed, skip failures
    const workingContents: Map<string, string> = new Map(fileContents);
    const results: EditResult[] = [];
    let atomicFailed = false;
    let atomicFailError = '';

    for (const item of input.edits!) {
      const resolvedPath = resolvedPaths.get(item.path);

      if (!resolvedPath) {
        // Path resolution failed
        results.push({
          id: item.id,
          path: item.path,
          success: false,
          status: 'failed',
          error: `Path resolution failed for '${item.path}'`,
        });
        if (transactionMode === 'atomic') {
          atomicFailed = true;
          atomicFailError = `Path resolution failed for '${item.path}'`;
          break;
        }
        continue;
      }

      if (fileReadErrors.has(resolvedPath)) {
        const readErrMsg = fileReadErrors.get(resolvedPath)!;
        const readErrStatus: EditResultStatus = readErrMsg.includes('OCC conflict') || readErrMsg.includes('modified externally') ? 'conflict' : 'failed';
        results.push({
          id: item.id,
          path: item.path,
          success: false,
          status: readErrStatus,
          error: readErrMsg,
        });
        if (transactionMode === 'atomic') {
          atomicFailed = true;
          atomicFailError = readErrMsg;
          break;
        }
        continue;
      }

      const currentContent = workingContents.get(resolvedPath);
      if (currentContent === undefined) {
        results.push({
          id: item.id,
          path: item.path,
          success: false,
          status: 'failed',
          error: `No content available for '${resolvedPath}'`,
        });
        if (transactionMode === 'atomic') {
          atomicFailed = true;
          atomicFailError = `No content available for '${resolvedPath}'`;
          break;
        }
        continue;
      }

      let editResult: { newContent: string; occurrencesReplaced: number; warning?: string } | { error: string; hint?: string };
      if (matchMode === 'ast_pattern') {
        editResult = computeAstPatternEdit(currentContent, item, resolvedPath);
      } else if (matchMode === 'ast') {
        editResult = await computeAstEdit(currentContent, item, resolvedPath);
      } else {
        editResult = computeSingleEdit(currentContent, item, matchMode, caseSensitive, whitespaceSensitive, multiline);
      }

      if ('error' in editResult) {
        // Determine structured status for the error
        const errMsg = editResult.error;
        let errorStatus: EditResultStatus = 'failed';
        if (errMsg.includes('not found') || errMsg.includes('No match')) errorStatus = 'not_found';
        else if (errMsg.includes('Ambiguous') || errMsg.includes('ambiguous')) errorStatus = 'ambiguous';
        else if (errMsg.includes('OCC conflict') || errMsg.includes('modified externally')) errorStatus = 'conflict';
        results.push({
          id: item.id,
          path: item.path,
          success: false,
          status: errorStatus,
          error: errMsg,
          hint: 'hint' in editResult ? editResult.hint : undefined,
        });
        if (transactionMode === 'atomic') {
          atomicFailed = true;
          atomicFailError = errMsg;
          break;
        }
        continue;
      }

      // Success — update working copy
      const oldContent = currentContent;
      workingContents.set(resolvedPath, editResult.newContent);

      let diff: string | undefined;
      let diffTruncated: boolean | undefined;
      let diffPreview: string | undefined;
      if (outputFormat === 'with_diff' || outputFormat === 'verbose' || dryRun) {
        const rawDiff = unifiedDiff(oldContent, editResult.newContent, resolvedPath, diffContext);
        if (rawDiff.length > DIFF_TRUNCATE_THRESHOLD) {
          diffTruncated = true;
          diffPreview = rawDiff.slice(0, DIFF_PREVIEW_LENGTH);
          diff = diffPreview; // store truncated version; full diff available in verbose format only
        } else {
          diff = rawDiff;
        }
      }
      results.push({
        id: item.id,
        path: item.path,
        success: true,
        status: 'applied',
        occurrencesReplaced: editResult.occurrencesReplaced,
        diff,
        diff_truncated: diffTruncated,
        diff_preview: diffPreview,
        warning: editResult.warning,
      });
    }

    // Atomic rollback: if any edit failed, report all as failed
    if (transactionMode === 'atomic' && atomicFailed) {
      // Replace all pending success results with rollback notices
      const atomicResults: EditResult[] = input.edits!.map((item, idx) => {
        const r = results[idx];
        if (r && !r.success) return r;
        return {
          id: item.id,
          path: item.path,
          success: false,
          status: 'failed',
          error: r?.success ? 'Rolled back due to atomic transaction failure' : (r?.error ?? atomicFailError),
        };
      });
      return {
        success: false,
        error: `Atomic transaction failed: ${atomicFailError}`,
        output: formatOutput(atomicResults, outputFormat, dryRun),
      };
    }

    // Write successful edits to disk (unless dry run)
    const writtenPaths = new Set<string>();
    if (!dryRun) {

      for (const r of results) {
        if (!r.success) continue;
        const resolvedPath = resolvedPaths.get(r.path);
        if (!resolvedPath || writtenPaths.has(resolvedPath)) continue;

        // Check if the working content differs from original (may be multiple edits on same file)
        const newContent = workingContents.get(resolvedPath);
        if (newContent === undefined) continue;

        try {
          writeFileSync(resolvedPath, newContent, 'utf-8');
          fileCache.update(resolvedPath, newContent);
          writtenPaths.add(resolvedPath);
          // Snapshot for /undo file support
          if (options?.fileUndoManager) {
            try {
              const originalContent = fileContents.get(resolvedPath) ?? null;
              options.fileUndoManager.snapshot({
                path: resolvedPath,
                beforeContent: originalContent,
                afterContent: newContent,
                tool: 'edit',
              });
            } catch {
              // Non-fatal
            }
          }
          // Track for /diff session change view
          recordChange(resolvedPath);
        } catch (err) {
          const msg = `Write failed for '${resolvedPath}': ${err instanceof Error ? err.message : String(err)}`;
          // Mark all results for this path as failed
          for (const res of results) {
            if (res.path === r.path) {
              res.success = false;
              res.error = msg;
            }
          }
        }
      }
    }

    const anySuccess = results.some((r) => r.success);

    // Dependency-aware import graph tracing: after writing files, find affected
    // dependents and surface broken imports immediately via typecheck.
    let importGraphWarning: string | undefined;
    if (!dryRun && anySuccess) {
      try {
        const graph = ImportGraph.getInstance();
        graph.markDirty();
        await graph.build(cwd);

        // Collect all paths that were written
        const editedAbsPaths = [...writtenPaths];

        // Find dependents across all edited files (union, deduped)
        const affectedSet = new Set<string>();
        for (const edited of editedAbsPaths) {
          for (const dep of graph.findTransitiveDependents(edited)) {
            affectedSet.add(dep);
          }
        }
        // Remove files that were just edited (they're already validated)
        for (const edited of editedAbsPaths) {
          affectedSet.delete(edited);
        }

        if (affectedSet.size > 0) {
          // Run tsc targeting only the affected files to detect broken imports
          const affectedList = Array.from(affectedSet);
          const proc = Bun.spawn(
            ['/bin/sh', '-c', `npx tsc --noEmit ${affectedList.join(' ')}`],
            { cwd, stdout: 'pipe', stderr: 'pipe' },
          );
          const [exitCode, stdoutText, stderrText] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          if (exitCode !== 0) {
            const relAffected = affectedList.map((f) => relative(cwd, f));
            const outputLines = (stderrText + '\n' + stdoutText)
              .split('\n')
              .filter((line) => relAffected.some((rel) => line.includes(rel)));
            if (outputLines.length > 0) {
              importGraphWarning =
                `\n⚠ Import graph: ${affectedSet.size} transitive dependent(s) affected by this edit — type errors detected in downstream files:\n` +
                outputLines.join('\n');
            } else {
              importGraphWarning =
                `\n⚠ Import graph: ${affectedSet.size} transitive dependent(s) affected. tsc reported errors outside the affected set — check unrelated files.`;
            }
          }
          // else: affected dependents type-check clean — no warning needed
        }
      } catch (err) {
        logger.warn('[import-graph] Import graph tracing failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Run validate.after (only if edits were actually written to disk)
    if (!dryRun && anySuccess && validateAfter.length > 0) {
      const failure = await runValidators(validateAfter, cwd);
      if (failure) {
        // Try auto-heal on each written file before reporting failure
        let healed = false;
        const failureMessages = [formatValidatorFailure(failure)];
        for (const [resolvedPath, originalContent] of fileContents) {
          const newContent = workingContents.get(resolvedPath);
          if (newContent === undefined || newContent === originalContent) continue;
          const healResult = await autoHealer.heal(resolvedPath, newContent, failureMessages);
          if (healResult.healed) {
            try {
              writeFileSync(resolvedPath, healResult.content, 'utf-8');
              fileCache.update(resolvedPath, healResult.content);
              healed = true;
            } catch {
              // Best-effort heal write
            }
          }
        }
        if (healed) {
          // Re-run validators after heal
          const healFailure = await runValidators(validateAfter, cwd);
          if (!healFailure) {
            // Healed successfully — report as success
            return { success: true, output: formatOutput(results, outputFormat, dryRun) };
          }
        }
        // Rollback in atomic mode: restore original file contents
        if (transactionMode === 'atomic') {
          for (const [resolvedPath, originalContent] of fileContents) {
            try {
              writeFileSync(resolvedPath, originalContent, 'utf-8');
              fileCache.update(resolvedPath, originalContent);
            } catch {
              // Best-effort rollback
            }
          }
        }
        return {
          success: false,
          error: `Post-edit validation failed${transactionMode === 'atomic' ? ' — edits rolled back' : ''}. ${formatValidatorFailure(failure)}`,
        };
      }
    }

    const output = formatOutput(results, outputFormat, dryRun) + (importGraphWarning ?? '');

    return {
      success: anySuccess,
      output,
    };
    } catch (err) {
      return { success: false, error: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { definition, execute };
}
