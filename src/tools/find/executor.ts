import type { Tool } from '../../types/tools.ts';
import { appendSchemaFingerprint } from '../shared/schema-fingerprint.ts';
import { findSchema } from './schema.ts';
import type { FindInput, FindQuery, OutputOptions } from './shared.ts';
import { executeFilesQuery } from './files.ts';
import { executeContentQuery } from './content.ts';
import { executeReferencesQuery } from './references.ts';
import { executeStructuralQuery } from './structural.ts';
import { executeSymbolsQuery } from './symbols.ts';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.ts';
import { FindRuntimeService } from './shared.ts';

export function createFindTool(
  featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null,
  runtime = new FindRuntimeService(),
): Tool {
  return {
    definition: findSchema,

    async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
      try {
        if (!Array.isArray(args.queries) || (args.queries as unknown[]).length === 0) {
          return { success: false, error: 'Missing or empty "queries" array' };
        }

        const input = args as unknown as FindInput;
        const output: OutputOptions = input.output ?? {};
        const parallel = input.parallel !== false;

        const runQuery = async (query: FindQuery): Promise<[string, Record<string, unknown>]> => {
          let result: Record<string, unknown>;
          switch (query.mode) {
            case 'files':
              result = await executeFilesQuery(query, output);
              break;
            case 'content':
              result = await executeContentQuery(query, output, runtime);
              break;
            case 'symbols':
              result = await executeSymbolsQuery(query, output);
              break;
            case 'references':
              result = await executeReferencesQuery(query, output);
              break;
            case 'structural':
              result = await executeStructuralQuery(query, output);
              break;
            default: {
              const exhaustive: never = query;
              result = { error: `Unknown mode: ${(exhaustive as FindQuery).mode}` };
            }
          }
          return [query.id, appendSchemaFingerprint(result, 'find', query.mode, { featureFlags })];
        };

        let pairs: Array<[string, Record<string, unknown>]>;
        if (parallel) {
          pairs = await Promise.all(input.queries.map(runQuery));
        } else {
          pairs = [];
          for (const query of input.queries) {
            pairs.push(await runQuery(query));
          }
        }

        const results: Record<string, unknown> = {};
        for (const [id, result] of pairs) {
          results[id] = result;
        }

        const finalResults = input.queries.length > 1
          ? appendSchemaFingerprint(results, 'find', 'multi', { featureFlags })
          : results;

        return { success: true, output: JSON.stringify(finalResults) };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
