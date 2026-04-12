import type { Tool, ToolDefinition } from '../../types/tools.ts';
import { resolve } from 'node:path';
import { INSPECT_TOOL_SCHEMA } from './schema.ts';
import { appendSchemaFingerprint } from '../shared/schema-fingerprint.ts';
import type { InspectInput } from './schema.ts';
import { VALID_MODES, JSON_OUTPUT_INDENT, type InspectToolResult } from './shared.ts';
import { executeInspectMode } from './executor.ts';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.ts';

export class InspectTool implements Tool {
  public constructor(
    private readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null,
  ) {}

  readonly definition: ToolDefinition = {
    name: 'inspect',
    description:
      'Inspect and analyze a project or file. Modes: project (structure), api (routes),'
      + ' api_spec (generate OpenAPI 3.0 spec), api_validate (compare spec to code),'
      + ' api_sync (detect frontend/backend drift),'
      + ' database (schema), components (React), layout (CSS/Tailwind),'
      + ' accessibility (a11y issues), scaffold (module skeleton generator).',
    parameters: INSPECT_TOOL_SCHEMA,
    sideEffects: ['read_fs'],
    concurrency: 'parallel',
    supportsProgress: true,
  };

  private _withFingerprint(output: string, mode: string, indent: number): string {
    try {
      const parsed = JSON.parse(output) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const fingerprinted = appendSchemaFingerprint(parsed as Record<string, unknown>, 'inspect', mode, {
          featureFlags: this.featureFlags,
        });
        return JSON.stringify(fingerprinted, null, indent || 0);
      }
    } catch {
      // ignore non-JSON output
    }
    return output;
  }

  async execute(args: Record<string, unknown>): Promise<InspectToolResult> {
    if (!args.mode || typeof args.mode !== 'string') {
      return { success: false, error: 'mode is required' };
    }

    const input = args as unknown as InspectInput;
    if (!VALID_MODES.includes(input.mode)) {
      return { success: false, error: `Invalid mode: ${input.mode}. Valid modes: ${VALID_MODES.join(', ')}` };
    }

    const projectRoot = resolve(input.projectRoot ?? process.cwd());
    const format = input.output?.format ?? 'detailed';
    const rawResult = await executeInspectMode(input, projectRoot, format);
    return this._fingerprintResult(rawResult, input.mode, format);
  }

  private _fingerprintResult(
    result: InspectToolResult,
    mode: string,
    format: string,
  ): InspectToolResult {
    if (result.success && result.output !== undefined) {
      return { ...result, output: this._withFingerprint(result.output, mode, format === 'json' ? JSON_OUTPUT_INDENT : 0) };
    }
    return result;
  }
}
