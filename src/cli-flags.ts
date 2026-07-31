// Compatibility wrapper for older imports. New CLI code lives in src/cli.
export type { GoodVibesCliFlags as CliFlags } from '@pellux/goodvibes-terminal-shell';
export {
  applyRuntimeConfigDefault,
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeCommandEndpointFlagOverrides,
  applyRuntimeEndpointFlagOverrides,
  applyRuntimeFeatureFlagOverrides,
  handleGoodVibesCliCommand,
  parseGoodVibesCli,
  renderGoodVibesCommandHelp,
  renderGoodVibesHelp,
  renderGoodVibesVersion,
} from './cli/index.ts';

import { parseGoodVibesCli } from '@pellux/goodvibes-terminal-shell';
import type { GoodVibesCliFlags } from '@pellux/goodvibes-terminal-shell';

export function parseCliFlags(argv: readonly string[], binary = 'goodvibes'): GoodVibesCliFlags {
  return parseGoodVibesCli(argv, binary).flags;
}
