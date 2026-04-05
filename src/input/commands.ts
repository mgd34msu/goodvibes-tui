import type { CommandRegistry } from './command-registry.ts';
import { recordUsage } from '../providers/favorites.ts';
import { policyCommand } from './commands/policy.ts';
import { providerCommand } from './commands/provider.ts';
import { evalCommand } from './commands/eval.ts';
import { sessionCommand } from './commands/session.ts';
import { recallCommand } from './commands/memory.ts';
import { registerShellCoreCommands } from './commands/shell-core.ts';
import { registerConfigCommand } from './commands/config.ts';
import { registerSessionWorkflowCommands } from './commands/session-workflow.ts';
import { registerOperatorRuntimeCommands } from './commands/operator-runtime.ts';
import { registerIntegrationRuntimeCommands } from './commands/integration-runtime.ts';
import { registerSessionContentCommands } from './commands/session-content.ts';
import { registerLocalRuntimeCommands } from './commands/local-runtime.ts';

/**
 * registerBuiltinCommands - Register all built-in slash commands into the registry.
 * Call once during application startup.
 */
export function registerBuiltinCommands(registry: CommandRegistry): void {
  registerShellCoreCommands(registry);
  registerConfigCommand(registry);
  registerOperatorRuntimeCommands(registry);
  registerIntegrationRuntimeCommands(registry);
  registerLocalRuntimeCommands(registry);
  registerSessionWorkflowCommands(registry);
  registerSessionContentCommands(registry);

  // ── /policy ───────────────────────────────────────────────────────────────
  registry.register(policyCommand);

  // ── /provider ─────────────────────────────────────────────────────────────
  registry.register(providerCommand);

  // ── /eval ─────────────────────────────────────────────────────────────────
  registry.register(evalCommand);

  // ── /session ─────────────────────────────────────────────────────────────
  registry.register(sessionCommand);

  // ── /recall ──────────────────────────────────────────────────────────────
  registry.register(recallCommand);

}
