import type { PanelManager } from './panel-manager.ts';
import { resolveBuiltinPanelDeps, type BuiltinPanelDeps } from './builtin/shared.ts';
import { registerDevelopmentPanels } from './builtin/development.ts';
import { registerOperationsPanels } from './builtin/operations.ts';
import { registerAgentPanels } from './builtin/agent.ts';
import { registerSessionPanels } from './builtin/session.ts';
import { registerKnowledgePanels } from './builtin/knowledge.ts';
import { registerBuiltinModals } from './builtin-modals.ts';

/**
 * Register all built-in panel types with the given PanelManager.
 *
 * Call this once during application startup, before opening any panels.
 */
export function registerBuiltinPanels(manager: PanelManager, deps: BuiltinPanelDeps): void {
  const resolved = resolveBuiltinPanelDeps(deps);
  registerDevelopmentPanels(manager, resolved);
  registerOperationsPanels(manager, resolved);
  registerAgentPanels(manager, resolved);
  registerSessionPanels(manager, resolved);
  registerKnowledgePanels(manager, resolved);
  // W6.1 (the purge): register MIGRATE-TO-MODAL surfaces + their panel-id
  // redirects. Must run after the panel registrations so a redirected id wins
  // over any lingering panel registration in open().
  registerBuiltinModals(manager, resolved);
}

export type { BuiltinPanelDeps } from './builtin/shared.ts';
