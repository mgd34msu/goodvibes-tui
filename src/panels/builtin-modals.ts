import type { PanelManager } from './panel-manager.ts';

/**
 * Register modal redirects for MIGRATE-TO-MODAL panel ids (W6.1, the purge).
 *
 * Mirrors registerBuiltinPanels' shape and call site — invoked once during
 * application startup, before opening any panels — but instead of
 * `manager.registerType(...)` it calls `manager.registerModalRedirect(id,
 * modalName)` for every retired panel id whose replacement is a ModalFactory
 * config rather than a live panel view. See PanelManager.registerModalRedirect
 * (panel-manager.ts) for the mechanism this feeds: `open(id)` on a redirected
 * id invokes the injected openModal callback and returns without
 * constructing the old panel.
 *
 * Intentionally empty for now (WO-C mechanism-only stage) — WO-A (Providers
 * & Connectivity: provider-health, services, subscription, remote,
 * local-auth, settings-sync, sandbox) and WO-B (Ecosystem & Governance:
 * marketplace, plugins, skills, hooks, policy, security, knowledge, memory,
 * qr-code, sessions, docs, work-plan, project-planning) each add their own
 * `manager.registerModalRedirect(id, modalName)` calls here as they migrate
 * a panel's view onto a ModalFactory config. See
 * .goodvibes/audit/2026-07-04-wave6-briefs.json (W6.1) for the full
 * MIGRATE-TO-MODAL disposition list (20 ids).
 */
export function registerBuiltinModals(manager: PanelManager): void {
  void manager;
}
