import { execTool } from './index.ts';
import { asPhasedTool } from '../../runtime/tools/adapter.ts';
import type { PhasedTool } from '../../runtime/tools/adapter.ts';

/**
 * Creates a phased version of the exec tool.
 *
 * The exec tool is categorised as `execute` — it runs arbitrary shell commands
 * and therefore requires full permission checks in the prehook phase.
 * It is cancellable: the underlying process manager supports SIGTERM/SIGKILL,
 * so the phased executor can abort long-running commands via AbortSignal.
 *
 * Phase timeout: 120 000 ms (2 min) for the executing phase, matching the
 * exec tool's own default timeout for individual commands.
 *
 * @returns A PhasedTool wrapping the singleton execTool instance.
 */
export function createPhasedExecTool(): PhasedTool {
  return asPhasedTool(execTool, {
    category: 'execute',
    cancellable: true,
    phaseTimeouts: {
      executing: 120_000,
    },
  });
}
