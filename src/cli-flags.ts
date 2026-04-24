// Compatibility wrapper for older imports. New CLI code lives in src/cli.
export type { GoodVibesCliFlags as CliFlags } from './cli/types.ts';
export {
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeCommandEndpointFlagOverrides,
  applyRuntimeEndpointFlagOverrides,
  applyRuntimeFeatureFlagOverrides,
  handleGoodVibesCliCommand,
  parseGoodVibesCli,
  renderGoodVibesHelp,
  renderGoodVibesVersion,
} from './cli/index.ts';

import { parseGoodVibesCli } from './cli/parser.ts';
import type { GoodVibesCliFlags } from './cli/types.ts';

export function parseCliFlags(argv: readonly string[], binary = 'goodvibes'): GoodVibesCliFlags {
  return parseGoodVibesCli(argv, binary).flags;
}
