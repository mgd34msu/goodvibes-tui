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
import { summarizeError } from '../../utils/error-display.ts';

export type { AnalyzeInput } from './types.ts';

export function createAnalyzeTool(
  toolLLM: Pick<ToolLLM, 'chat'>,
  featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null,
  projectRoot?: string,
): Tool {
  if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
    throw new Error('createAnalyzeTool requires projectRoot');
  }
  return {
    definition: analyzeSchema,

    async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
      try {
        if (!args.mode || typeof args.mode !== 'string') {
          return { success: false, error: 'Missing required "mode" field' };
        }

        const input = args as unknown as AnalyzeInput;
        const outputFormat = input.output?.format ?? 'json';

        const resolvedProjectRoot = resolve(
          typeof input.projectRoot === 'string' && input.projectRoot.trim().length > 0
            ? input.projectRoot
            : projectRoot,
        );

        let result: Record<string, unknown>;

        switch (input.mode) {
          case 'impact':
            result = await runImpact(input, resolvedProjectRoot);
            break;

          case 'dependencies':
            result = await runDependencies(input, resolvedProjectRoot);
            break;
          case 'dead_code':
            result = await runDeadCode(input, resolvedProjectRoot);
            break;
          case 'security':
            result = await runSecurity(input, resolvedProjectRoot);
            break;
          case 'coverage':
            result = await runCoverage(input, resolvedProjectRoot);
            break;
          case 'bundle':
            result = await runBundle(input, resolvedProjectRoot);
            break;
          case 'surface':
            result = await runSurface(input, resolvedProjectRoot);
            break;
          case 'preview':
            result = await runPreview(input, resolvedProjectRoot);
            break;
          case 'diff':
            result = await runDiff(input, resolvedProjectRoot);
            break;
          case 'breaking':
            result = await runBreaking(input, resolvedProjectRoot);
            break;
          case 'semantic_diff':
            result = await runSemanticDiff(input, resolvedProjectRoot, toolLLM);
            break;
          case 'upgrade':
            result = await runUpgrade(input, resolvedProjectRoot);
            break;
          case 'permissions':
            result = await runPermissions(input, resolvedProjectRoot);
            break;
          case 'env_audit':
            result = await runEnvAudit(input, resolvedProjectRoot);
            break;
          case 'test_find':
            result = await runTestFind(input, resolvedProjectRoot);
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
          error: summarizeError(err),
        };
      }
    },
  };
}
