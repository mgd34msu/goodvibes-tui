import type { Tool } from '../../types/tools.ts';
import { resolve } from 'node:path';
import type { ToolLLM } from '../../config/tool-llm.ts';
import { analyzeSchema } from './schema.ts';
import { appendSchemaFingerprint } from '../shared/schema-fingerprint.ts';
import type { AnalyzeInput } from './types.ts';
import { applyAnalyzeTokenBudget, summarizeAnalyzeResult } from './shared.ts';
import {
  runBundle,
  runCoverage,
  runDeadCode,
  runDependencies,
  runEnvAudit,
  runImpact,
  runPermissions,
  runPreview,
  runSecurity,
  runSurface,
  runTestFind,
} from './scan-modes.ts';
import {
  runBreaking,
  runDiff,
  runSemanticDiff,
  runUpgrade,
} from './git-modes.ts';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.ts';

export type { AnalyzeInput } from './types.ts';

export function createAnalyzeTool(
  toolLLM: Pick<ToolLLM, 'chat'>,
  featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null,
): Tool {
  return {
    definition: analyzeSchema,

    async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
      try {
        if (!args.mode || typeof args.mode !== 'string') {
          return { success: false, error: 'Missing required "mode" field' };
        }

        const input = args as unknown as AnalyzeInput;
        const outputFormat = input.output?.format ?? 'json';

        const projectRoot = input.projectRoot
          ? resolve(input.projectRoot)
          : process.cwd();

        let result: Record<string, unknown>;

        switch (input.mode) {
          case 'impact':
            result = await runImpact(input, projectRoot);
            break;
          case 'dependencies':
            result = await runDependencies(input, projectRoot);
            break;
          case 'dead_code':
            result = await runDeadCode(input, projectRoot);
            break;
          case 'security':
            result = await runSecurity(input, projectRoot);
            break;
          case 'coverage':
            result = await runCoverage(input, projectRoot);
            break;
          case 'bundle':
            result = await runBundle(input, projectRoot);
            break;
          case 'surface':
            result = await runSurface(input, projectRoot);
            break;
          case 'preview':
            result = await runPreview(input, projectRoot);
            break;
          case 'diff':
            result = await runDiff(input, projectRoot);
            break;
          case 'breaking':
            result = await runBreaking(input, projectRoot);
            break;
          case 'semantic_diff':
            result = await runSemanticDiff(input, projectRoot, toolLLM);
            break;
          case 'upgrade':
            result = await runUpgrade(input, projectRoot);
            break;
          case 'permissions':
            result = await runPermissions(input, projectRoot);
            break;
          case 'env_audit':
            result = await runEnvAudit(input, projectRoot);
            break;
          case 'test_find':
            result = await runTestFind(input, projectRoot);
            break;
          default: {
            const exhaustive: never = input.mode;
            return { success: false, error: `Unknown mode: ${exhaustive as string}` };
          }
        }

        const fingerprinted = appendSchemaFingerprint(result, 'analyze', input.mode, { featureFlags });
        const shaped = outputFormat === 'summary'
          ? summarizeAnalyzeResult(input.mode, fingerprinted)
          : fingerprinted;
        const indent = outputFormat === 'json' ? 2 : 0;
        const serialized = JSON.stringify(shaped, null, indent);
        return { success: true, output: applyAnalyzeTokenBudget(serialized, input.output?.max_tokens) };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
