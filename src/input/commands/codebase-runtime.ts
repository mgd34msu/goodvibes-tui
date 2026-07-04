// ---------------------------------------------------------------------------
// codebase-runtime.ts — /codebase
//
// Explicit-query + transparency surface over the repo source-tree code index
// (CodeIndexStore, @pellux/goodvibes-sdk/platform/state, landed on SDK main
// as wo802/W5.3 Stage A) via the TUI's own wiring in
// src/runtime/code-index-services.ts, threaded through
// CommandContext.session.codeIndexStore exactly like wrfcController/
// workstreamEngine already are (bootstrap-command-context.ts).
//
// Mirrors /recall's transparency idiom (recall-query.ts's handleRecallVector:
// status/rebuild) and /workstream's registerXRuntimeCommands function-export
// shape: build (schedules the index build — visible as a fleet 'code-index'
// node while it runs), status (counts, skips, degradation state, last
// build), search <query> (explicit retrieval, results labeled
// 'lexical'|'semantic' honestly — never implied as more precise than they
// are). This is Stage A only: no auto-injection into coding turns (Stage B,
// out of scope — see the wo802/W5.3 design doc).
// ---------------------------------------------------------------------------

import type { CodeIndexStats, CodeContextResult } from '@pellux/goodvibes-sdk/platform/state';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { isCodeIndexAutoStartEnabled, CODE_INDEX_MAX_FILES, CODE_INDEX_MAX_FILE_BYTES, CODE_INDEX_MAX_TOTAL_BYTES } from '../../runtime/code-index-services.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function renderCodeIndexStatus(stats: CodeIndexStats, configManager: Pick<ConfigManager, 'get'>): string {
  const lines: string[] = [];
  lines.push(`Code index — backend: ${stats.backend}, available: ${stats.available ? 'yes' : 'no'}`);
  lines.push(`  path: ${stats.path}`);
  lines.push(`  indexed: ${stats.indexedFiles} file(s), ${stats.indexedChunks} chunk(s), ${stats.dimensions} dims`);
  lines.push(`  embedding provider: ${stats.embeddingProviderLabel} (${stats.embeddingProviderId})`);
  lines.push(
    stats.semanticRetrievalAvailable
      ? '  search results labeled: semantic'
      : '  search results labeled: lexical (hashed fallback — low precision)',
  );
  const autoStart = isCodeIndexAutoStartEnabled(configManager);
  lines.push(
    `  auto-build on startup: ${autoStart ? 'on' : 'off'} (storage.codeIndexEnabled, default off — /config to change)`,
  );
  lines.push(
    `  bounds: max ${CODE_INDEX_MAX_FILES} files (maxFiles), ${formatBytes(CODE_INDEX_MAX_FILE_BYTES)} per file (maxFileBytes),`
    + ` ${formatBytes(CODE_INDEX_MAX_TOTAL_BYTES)} total per build (maxTotalBytes)`,
  );
  // Provider-space honesty (SDK finding): vectors embedded under a different
  // provider than the current default disable the vector search path until a
  // rebuild re-embeds — say so, in the store's own words.
  if (stats.embeddingProviderMismatch) {
    lines.push(`  provider mismatch: ${stats.embeddingProviderMismatch} (vector search disabled — lexical fallback only)`);
  }

  if (stats.building) {
    lines.push('  build: in progress');
  } else if (stats.lastBuild) {
    const b = stats.lastBuild;
    lines.push(
      `  last build: ${b.filesIndexed} indexed, ${b.filesUnchanged} unchanged, ${b.filesRemoved} removed,`
      + ` ${b.chunksIndexed} chunk(s) embedded (${b.chunksUnchanged} unchanged), ${b.durationMs}ms`,
    );
    const skip = b.skip;
    const skipParts: string[] = [];
    if (skip.tooLarge) skipParts.push(`${skip.tooLarge} too large`);
    if (skip.overFileCap) skipParts.push(`${skip.overFileCap} over file cap (maxFiles)`);
    if (skip.overTotalBytes) skipParts.push(`${skip.overTotalBytes} over total byte budget (maxTotalBytes)`);
    if (skip.binary) skipParts.push(`${skip.binary} binary`);
    if (skip.ignoredByGitignore) skipParts.push(`${skip.ignoredByGitignore} gitignored`);
    if (skip.readErrors) skipParts.push(`${skip.readErrors} read error(s)`);
    if (skip.chunkedByWindow) skipParts.push(`${skip.chunkedByWindow} windowed (no tree-sitter symbols)`);
    lines.push(skipParts.length > 0 ? `  skipped: ${skipParts.join(', ')}` : '  skipped: none');
  } else {
    lines.push('  last build: never — run /codebase build');
  }

  if (stats.error) lines.push(`  error: ${stats.error}`);

  const degradation = stats.semanticRetrievalAvailable ? null : describeDegradationFallback(stats);
  if (degradation) lines.push(`  ${degradation}`);

  return lines.join('\n');
}

/** Reuses the exact wording CodeIndexStore.describeDegradation() would return for a hashed-only provider, without requiring a live call the status renderer doesn't otherwise need. */
function describeDegradationFallback(stats: CodeIndexStats): string | null {
  if (stats.semanticRetrievalAvailable) return null;
  return 'code auto-retrieval disabled: no semantic embedding provider configured';
}

function renderSearchResults(results: readonly CodeContextResult[]): string {
  return results
    .map((result) => {
      const c = result.chunk;
      const pct = Math.round(result.similarity * 100);
      const symbol = c.symbol ? ` ${c.symbol}` : '';
      return `  ${c.path}:${c.startLine}-${c.endLine}  [${result.label}]  sim ${pct}%  ${c.kind}${symbol}`;
    })
    .join('\n');
}

function parseLimitArg(args: readonly string[]): { readonly limit: number | undefined; readonly queryTokens: string[] } {
  const limitIdx = args.indexOf('--limit');
  let limit: number | undefined;
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    const parsed = parseInt(args[limitIdx + 1]!, 10);
    if (!Number.isNaN(parsed)) limit = parsed;
  }
  const queryTokens = args.filter((token, index) => {
    if (token === '--limit') return false;
    if (limitIdx !== -1 && index === limitIdx + 1) return false;
    return true;
  });
  return { limit, queryTokens };
}

const USAGE = 'Usage:\n'
  + '  /codebase build\n'
  + '  /codebase status\n'
  + '  /codebase search <query...> [--limit n]';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function registerCodebaseRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'codebase',
    description: 'Repo source-tree code index — build, inspect, and search',
    usage: 'build | status | search <query...> [--limit n]',
    argsHint: 'build | status | search <query>',
    handler(args: string[], ctx: CommandContext) {
      const store = ctx.session.codeIndexStore;
      if (!store) {
        ctx.print('The code index is not available in this session.');
        return;
      }

      const sub = args[0];

      if (!sub || sub === 'status') {
        ctx.print(renderCodeIndexStatus(store.stats(), ctx.platform.configManager));
        return;
      }

      if (sub === 'build' || sub === 'reindex') {
        if (store.isBuilding()) {
          const progress = store.buildProgress();
          ctx.print(
            progress
              ? `A build is already in progress (${progress.scanned}/${progress.total} files scanned).`
              : 'A build is already in progress.',
          );
          return;
        }
        store.scheduleBuild();
        ctx.print('Build scheduled — track progress with /codebase status or the fleet panel (code-index node).');
        return;
      }

      if (sub === 'search') {
        const { limit, queryTokens } = parseLimitArg(args.slice(1));
        const query = queryTokens.join(' ').trim();
        if (!query) {
          ctx.print('Usage: /codebase search <query...> [--limit n]');
          return;
        }
        const results = store.search(query, limit !== undefined ? { limit } : undefined);
        if (results.length === 0) {
          const stats = store.stats();
          ctx.print(
            stats.indexedChunks === 0
              ? 'No results — the code index is empty. Run /codebase build first.'
              : 'No matching chunks found.',
          );
          return;
        }
        ctx.print(`${results.length} result(s):\n${renderSearchResults(results)}`);
        return;
      }

      ctx.print(USAGE);
    },
  });
}
