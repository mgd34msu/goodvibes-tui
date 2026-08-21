import type { CommandRegistry } from '../command-registry.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

interface ParsedSearchArgs {
  readonly query: string;
  readonly limit?: number;
}

function parseSearchArgs(args: string[]): ParsedSearchArgs {
  const words: string[] = [];
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if ((token === '--limit' || token === '-n') && i + 1 < args.length) {
      const parsed = Number.parseInt(args[++i]!, 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
    } else {
      words.push(token);
    }
  }
  return { query: words.join(' ').trim(), ...(limit !== undefined ? { limit } : {}) };
}

/**
 * registerWebSearchRuntimeCommands - `/search <query> [--limit <n>]`.
 *
 * Calls webSearchService.search() directly (skipping the agent-tool wrapper's
 * JSON-stringify contract, same shape as /schedule's ctx.ops.automationManager
 * pattern: read the service off the context, guard on undefined, print) and
 * renders ranked results + the instant answer into the transcript with
 * source labels. webSearchService is already constructed in services.ts and
 * already agent-reachable; this is a second, direct-command consumer of the
 * same instance (ctx.platform.webSearchService).
 */
export function registerWebSearchRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'search',
    description: 'Web search, ranked results with source labels (searching THIS transcript? use /find)',
    usage: '<query> [--limit <n>]',
    argsHint: '<query> [--limit <n>]',
    async handler(args, ctx) {
      const service = ctx.platform.webSearchService;
      if (!service) {
        ctx.print('Web search is not available in this session.');
        return;
      }

      const { query, limit } = parseSearchArgs(args);
      if (!query) {
        ctx.print('Usage: /search <query> [--limit <n>]');
        return;
      }

      try {
        const response = await service.search({
          query,
          ...(limit !== undefined ? { maxResults: limit } : {}),
        });

        const lines: string[] = [`Search: "${response.query}"  (source: ${response.providerLabel})`];

        const instantAnswer = response.instantAnswer;
        if (instantAnswer) {
          const heading = instantAnswer.heading ?? instantAnswer.source ?? 'Instant answer';
          const body = instantAnswer.answer ?? instantAnswer.abstract;
          if (body) {
            lines.push('', `${heading}: ${body}`);
            if (instantAnswer.url) lines.push(`  ${instantAnswer.url}`);
          }
        }

        if (response.results.length === 0) {
          lines.push('', 'No results found.');
        } else {
          lines.push('');
          for (const result of response.results) {
            const title = result.title ?? result.displayUrl ?? result.url;
            lines.push(`${result.rank}. ${title}`);
            if (result.snippet) lines.push(`   ${result.snippet}`);
            lines.push(`   ${result.url}`);
          }
        }

        ctx.print(lines.join('\n'));
      } catch (error) {
        // Honest degradation: read the thrown error / the service's own status
        // surface rather than inventing an env-var name. WebSearchService.search()
        // throws (not a {success:false} result field) when no provider is
        // registered or the provider itself fails.
        let detail = summarizeError(error);
        try {
          const status = await service.getStatus();
          if (!status.enabled) detail = `${detail} (${status.note})`;
        } catch {
          // getStatus() itself failing is not worth compounding into the error message.
        }
        ctx.print(`Search failed: ${detail}`);
      }
    },
  });
}
