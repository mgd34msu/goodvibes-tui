import { join, relative } from 'node:path';
import { statSync, lstatSync } from 'node:fs';
import type { FilesQuery, OutputOptions } from './shared.ts';
import { buildGitignoreMatcher, collectGlobFiles, makeCountResult, makeFilesResult, matchesGlob, validateSearchPath } from './shared.ts';
import { summarizeError } from '../../utils/error-display.ts';

export async function executeFilesQuery(
  query: FilesQuery,
  output: OutputOptions,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const validatedPath = validateSearchPath(query.path, projectRoot);
  if (typeof validatedPath === 'object') return validatedPath;
  const basePath = validatedPath;
  const patterns = query.patterns ?? ['**/*'];
  const excludePatterns = query.exclude ?? [];
  const compiledExcludes = excludePatterns.map((p) => new Bun.Glob(p));
  const maxResults = output.max_results ?? 100;
  const includeHidden = query.include_hidden ?? false;
  const followSymlinks = query.follow_symlinks ?? false;
  const respectGitignore = query.respect_gitignore !== false;

  const modifiedAfterMs = query.modified_after ? new Date(query.modified_after).getTime() : undefined;
  if (modifiedAfterMs !== undefined && Number.isNaN(modifiedAfterMs)) {
    return { error: `Invalid modified_after date: ${query.modified_after}` };
  }
  const modifiedBeforeMs = query.modified_before ? new Date(query.modified_before).getTime() : undefined;
  if (modifiedBeforeMs !== undefined && Number.isNaN(modifiedBeforeMs)) {
    return { error: `Invalid modified_before date: ${query.modified_before}` };
  }

  const gitignoreMatcher = respectGitignore
    ? buildGitignoreMatcher(join(projectRoot, '.gitignore'))
    : null;

  let hasContentRegex: RegExp | undefined;
  if (query.has_content) {
    try {
      hasContentRegex = new RegExp(query.has_content);
    } catch (e) {
      return { error: `Invalid has_content regex: ${summarizeError(e)}` };
    }
  }

  const SCAN_CEILING = 50_000;
  const scannedFiles = await collectGlobFiles(basePath, patterns, includeHidden, followSymlinks);
  const matchedFiles = new Set<string>();
  for (const file of scannedFiles) {
    if (matchedFiles.size >= SCAN_CEILING) break;
    const rel = relative(basePath, file);
    if (gitignoreMatcher && gitignoreMatcher(rel)) continue;
    const excluded = compiledExcludes.some((excl) => matchesGlob(excl, file, basePath));
    if (excluded) continue;
    matchedFiles.add(file);
  }

  const needStats =
    query.min_size !== undefined ||
    query.max_size !== undefined ||
    query.is_empty !== undefined ||
    modifiedAfterMs !== undefined ||
    modifiedBeforeMs !== undefined ||
    query.sort_by === 'size' ||
    query.sort_by === 'modified' ||
    output.format === 'with_stats' ||
    output.format === 'with_preview';

  interface FileEntry {
    path: string;
    size?: number;
    mtimeMs?: number;
  }

  let entries: FileEntry[] = Array.from(matchedFiles).map((p) => ({ path: p }));

  if (needStats) {
    const withStats: FileEntry[] = [];
    for (const entry of entries) {
      try {
        const s = followSymlinks ? statSync(entry.path) : lstatSync(entry.path);
        entry.size = s.size;
        entry.mtimeMs = s.mtimeMs;
      } catch {
        // ignore stat errors
      }

      if (query.min_size !== undefined && (entry.size ?? 0) < query.min_size) continue;
      if (query.max_size !== undefined && (entry.size ?? 0) > query.max_size) continue;
      if (query.is_empty === true && (entry.size ?? 0) !== 0) continue;
      if (query.is_empty === false && (entry.size ?? 0) === 0) continue;
      if (modifiedAfterMs !== undefined && (entry.mtimeMs ?? 0) < modifiedAfterMs) continue;
      if (modifiedBeforeMs !== undefined && (entry.mtimeMs ?? 0) >= modifiedBeforeMs) continue;

      withStats.push(entry);
    }
    entries = withStats;
  }

  entries = entries.slice(0, maxResults);

  if (hasContentRegex) {
    const filtered: FileEntry[] = [];
    for (const entry of entries) {
      try {
        const text = await Bun.file(entry.path).text();
        if (hasContentRegex.test(text)) filtered.push(entry);
      } catch {
        // unreadable file
      }
    }
    entries = filtered;
  }

  const sortBy = query.sort_by ?? 'name';
  const sortOrder = query.sort_order ?? 'asc';
  const dir = sortOrder === 'desc' ? -1 : 1;

  entries.sort((a, b) => {
    if (sortBy === 'size') return ((a.size ?? 0) - (b.size ?? 0)) * dir;
    if (sortBy === 'modified') return ((a.mtimeMs ?? 0) - (b.mtimeMs ?? 0)) * dir;
    return a.path.localeCompare(b.path) * dir;
  });

  const format = output.format ?? 'files_only';
  if (format === 'count_only') {
    return makeCountResult(entries.length);
  }
  if (format === 'with_stats') {
    const result = entries.map((e) => ({
      file: e.path,
      size: e.size,
      modified: e.mtimeMs !== undefined ? new Date(e.mtimeMs).toISOString() : undefined,
    }));
    return { files: result, count: result.length };
  }
  if (format === 'with_preview') {
    const previewLines = output.preview_lines ?? 3;
    const result: Array<{ file: string; preview: string[] }> = [];
    for (const entry of entries) {
      let preview: string[] = [];
      try {
        const text = await Bun.file(entry.path).text();
        preview = text.split('\n').slice(0, previewLines);
      } catch {
        // unreadable
      }
      result.push({ file: entry.path, preview });
    }
    return { files: result, count: result.length };
  }

  return makeFilesResult(entries.map((e) => e.path), entries.length);
}
