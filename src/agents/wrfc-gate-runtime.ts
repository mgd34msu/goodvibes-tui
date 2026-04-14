import type { ConfigManager } from '../config/manager.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import { logger } from '../utils/logger.ts';
import type { QualityGateResult } from './wrfc-types.ts';
import {
  executeGateCommand,
  getSkippedGateReason,
  loadPackageScripts,
} from './wrfc-gates.ts';
import { getEnabledWrfcGates } from './wrfc-config.ts';
import { emitWrfcGateResult } from './wrfc-runtime-events.ts';

export async function runWrfcGateChecks(options: {
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly projectRoot: string;
  readonly runtimeBus: RuntimeEventBus;
  readonly sessionId: string;
  readonly chainId: string;
  readonly onResult?: (results: readonly QualityGateResult[], result: QualityGateResult) => void;
}): Promise<QualityGateResult[]> {
  const gates = getEnabledWrfcGates(options.configManager);
  if (gates.length === 0) {
    logger.debug('Wrfc gate runner: no gates configured', { chainId: options.chainId });
    return [];
  }

  logger.debug('Wrfc gate runner: executing gates', {
    chainId: options.chainId,
    gateCount: gates.length,
  });

  const pkgScripts = await loadPackageScripts(options.projectRoot);
  const results: QualityGateResult[] = [];

  for (const gate of gates) {
    const skipReason = getSkippedGateReason(gate.name, options.projectRoot, pkgScripts);
    if (skipReason !== null) {
      const result: QualityGateResult = {
        gate: gate.name,
        passed: true,
        output: skipReason,
        durationMs: 0,
      };
      results.push(result);
      emitWrfcGateResult(options.runtimeBus, options.sessionId, options.chainId, gate.name, true);
      options.onResult?.(results.slice(), result);
      logger.debug('Wrfc gate runner: gate skipped', {
        chainId: options.chainId,
        gate: gate.name,
        reason: skipReason,
      });
      continue;
    }

    const startedAt = Date.now();
    const { passed, output } = await executeGateCommand(gate.command);
    const result: QualityGateResult = {
      gate: gate.name,
      passed,
      output,
      durationMs: Date.now() - startedAt,
    };
    results.push(result);
    emitWrfcGateResult(options.runtimeBus, options.sessionId, options.chainId, gate.name, passed);
    options.onResult?.(results.slice(), result);
    logger.debug('Wrfc gate runner: gate result', {
      chainId: options.chainId,
      gate: gate.name,
      passed,
      durationMs: result.durationMs,
    });
  }

  return results;
}
