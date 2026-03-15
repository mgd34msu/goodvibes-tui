import { readFileSync, writeFileSync } from 'node:fs';
import type { Tool, ToolDefinition } from '../../types/tools.ts';
import { FileStateCache, unifiedDiff } from '../../state/file-cache.ts';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import { editSchema } from './schema.ts';

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
  };
}

interface EditInput {
  edits: EditItem[];
  match?: {
    mode?: 'exact' | 'fuzzy' | 'regex';
    case_sensitive?: boolean;
    whitespace_sensitive?: boolean;
  };
  transaction?: {
    mode?: 'atomic' | 'partial' | 'none';
  };
  output?: {
    format?: 'count_only' | 'minimal' | 'with_diff' | 'verbose';
  };
  dry_run?: boolean;
}

interface EditResult {
  id?: string;
  path: string;
  success: boolean;
  occurrencesReplaced?: number;
  diff?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf-8');
}

/**
 * Normalize whitespace for fuzzy matching: collapse runs of whitespace
 * (spaces, tabs, newlines) into a single space, then trim.
 */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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
): { start: number; end: number }[] {
  const positions: { start: number; end: number }[] = [];

  if (mode === 'regex') {
    const flags = caseSensitive ? 'g' : 'gi';
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
): { start: number; end: number }[] {
  if (!hints) return positions;

  let filtered = positions;

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

  return filtered;
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
): { selected: { start: number; end: number }[] } | { error: string } {
  if (positions.length === 0) {
    return { error: 'Find string not found in file' };
  }

  if (occurrence === undefined) {
    // Default: must be exactly one occurrence
    if (positions.length > 1) {
      return {
        error: `Ambiguous match: find string appears ${positions.length} times. Specify occurrence: 'first', 'last', 'all', or a number.`,
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
      const flags = caseSensitive ? '' : 'i';
      const re = new RegExp(find, flags);
      const m = re.exec(content.slice(start, end));
      if (m) {
        replacement = replace.replace(/\$(\d+)/g, (_full, digit) => {
          return m[parseInt(digit)] ?? '';
        });
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
function computeSingleEdit(
  fileContent: string,
  item: EditItem,
  mode: 'exact' | 'fuzzy' | 'regex',
  caseSensitive: boolean,
  whitespaceSensitive: boolean = true,
): { newContent: string; occurrencesReplaced: number } | { error: string } {
  const findStr = item.find_base64 ? decodeBase64(item.find_base64) : item.find;
  const replaceStr = item.replace_base64 ? decodeBase64(item.replace_base64) : item.replace;

  // Find all positions (regex mode may throw on invalid patterns)
  let positions: { start: number; end: number }[];
  try {
    positions = findAllPositions(fileContent, findStr, mode, caseSensitive, whitespaceSensitive);
  } catch (err) {
    return { error: `Invalid find pattern: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Apply hints
  if (item.hints) {
    positions = applyHints(fileContent, positions, item.hints, item.hints.near_line);
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

  return { newContent, occurrencesReplaced: selResult.selected.length };
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
        lines.push(`  OK${id}: ${r.path} (${r.occurrencesReplaced} replacement(s))`);
      } else {
        const id = r.id ? ` [${r.id}]` : '';
        lines.push(`  FAIL${id}: ${r.path} — ${r.error}`);
      }
    }
    return lines.join('\n');
  }

  // with_diff or verbose
  for (const r of results) {
    const id = r.id ? ` [${r.id}]` : '';
    if (r.success) {
      lines.push(`\n--- ${r.path}${id} (${r.occurrencesReplaced} replacement(s))${dryTag} ---`);
      if (r.diff) {
        lines.push(r.diff);
      }
    } else {
      lines.push(`\n--- ${r.path}${id} FAILED ---`);
      lines.push(`  Error: ${r.error}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export function createEditTool(fileCache: FileStateCache): Tool {
  const definition: ToolDefinition = {
    name: 'edit',
    description:
      'Edit files by finding and replacing text. Supports exact, fuzzy, and regex matching. ' +
      'Handles multiple edits in one call with atomic or partial transaction semantics. ' +
      'Detects OCC conflicts when files have been modified externally.',
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
      if (!Array.isArray(input.edits) || input.edits.length === 0) {
        return { success: false, error: 'edits must be a non-empty array' };
      }
    } catch (err) {
      return { success: false, error: `Invalid input: ${err instanceof Error ? err.message : String(err)}` };
    }

    const matchMode = input.match?.mode ?? 'exact';
    const caseSensitive = input.match?.case_sensitive ?? true;
    const whitespaceSensitive = input.match?.whitespace_sensitive ?? true;
    const transactionMode = input.transaction?.mode ?? 'atomic';
    const outputFormat = input.output?.format ?? 'minimal';
    const dryRun = input.dry_run ?? false;

    // Resolve all paths upfront
    const resolvedPaths: Map<string, string> = new Map();
    for (const item of input.edits) {
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
    const uniquePaths = new Set(input.edits.map((e) => resolvedPaths.get(e.path) ?? e.path));
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

    for (const item of input.edits) {
      const resolvedPath = resolvedPaths.get(item.path);

      if (!resolvedPath) {
        // Path resolution failed
        results.push({
          id: item.id,
          path: item.path,
          success: false,
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
        results.push({
          id: item.id,
          path: item.path,
          success: false,
          error: fileReadErrors.get(resolvedPath)!,
        });
        if (transactionMode === 'atomic') {
          atomicFailed = true;
          atomicFailError = fileReadErrors.get(resolvedPath)!;
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
          error: `No content available for '${resolvedPath}'`,
        });
        if (transactionMode === 'atomic') {
          atomicFailed = true;
          atomicFailError = `No content available for '${resolvedPath}'`;
          break;
        }
        continue;
      }

      const editResult = computeSingleEdit(currentContent, item, matchMode, caseSensitive, whitespaceSensitive);

      if ('error' in editResult) {
        results.push({
          id: item.id,
          path: item.path,
          success: false,
          error: editResult.error,
        });
        if (transactionMode === 'atomic') {
          atomicFailed = true;
          atomicFailError = editResult.error;
          break;
        }
        continue;
      }

      // Success — update working copy
      const oldContent = currentContent;
      workingContents.set(resolvedPath, editResult.newContent);

      let diff: string | undefined;
      if (outputFormat === 'with_diff' || outputFormat === 'verbose' || dryRun) {
        diff = unifiedDiff(oldContent, editResult.newContent, resolvedPath);
      }

      results.push({
        id: item.id,
        path: item.path,
        success: true,
        occurrencesReplaced: editResult.occurrencesReplaced,
        diff,
      });
    }

    // Atomic rollback: if any edit failed, report all as failed
    if (transactionMode === 'atomic' && atomicFailed) {
      // Replace all pending success results with rollback notices
      const atomicResults: EditResult[] = input.edits.map((item, idx) => {
        const r = results[idx];
        if (r && !r.success) return r;
        return {
          id: item.id,
          path: item.path,
          success: false,
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
    if (!dryRun) {
      const writtenPaths = new Set<string>();

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
    const output = formatOutput(results, outputFormat, dryRun);

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
