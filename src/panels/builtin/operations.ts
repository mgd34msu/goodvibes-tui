import type { PanelManager } from '../panel-manager.ts';
import { FleetPanel } from '../fleet-panel.ts';
import { createFleetReadModel } from '../fleet-read-model.ts';
import { LocalAuthPanel } from '../local-auth-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireUiServices } from './shared.ts';
import { registerEcosystemModalRedirects } from '../modals/modal-surface.ts';

// WO-152: the former single 'monitoring' category (33 panels pre-merge) is
// split into five operator domains, applied per-registration below. Kept in
// this file's original registration order (rather than physically regrouped
// by category) because several registrations below close over shared local
// state — `ui` — defined once near the top of this function.
//
// W6.1 (the purge): cockpit, approval, automation, routes, control-plane,
// worktrees, tasks, orchestration, ops, ops-control, and communication were
// RETIRE-INTO-FLEET (their live views are subsumed by the Fleet panel below
// — each id now redirects there via registerAlias); debug and eval were
// DELETE-disposition (no surviving human surface). See
// .goodvibes/audit/2026-07-04-wave6-briefs.json (W6.1) for the full
// disposition map. The rosterReadModel/agent-lifecycle wiring that used to
// feed CockpitPanel exclusively was removed along with it — Fleet reads the
// process registry directly via fleetReadModel below, not via the roster
// read-model.
//
// W6.1 MIGRATE-TO-MODAL: the Providers & Connectivity group (services,
// subscription, remote, provider-health) and Security group (settings-sync,
// sandbox) migrated to config-modal surfaces registered in builtin-modals.ts
// (WO-A); the Ecosystem & Governance group (plugins, skills, hooks, security,
// marketplace, policy, knowledge, memory, docs, qr-code, work-plan,
// project-planning) migrated to config-modal surfaces (WO-B). All are reached
// via their panel ids' modal redirects (registerEcosystemModalRedirects below,
// plus the WO-A redirects in builtin-modals.ts). local-auth is a DELIBERATE
// EXCEPTION — see its registration below.
export function registerOperationsPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  const ui = requireUiServices(deps);

  // W2.2: Fleet — the live unified process tree, read from the single
  // process registry constructed once in runtime/services.ts (shared with
  // every other consumer rather than duplicated here; the registry owns its
  // own coalesced tick, so no manual lifecycle-event wiring is needed).
  // Wave-3 (W3.2): runtimeBus is also passed so the read model can subscribe
  // to the honest COMMUNICATION_CONSUMED steer-ack signal (fleet-read-model.ts).
  const fleetReadModel = createFleetReadModel(ui.runtime.processRegistry, ui.runtime.runtimeBus);

  manager.registerType({
    id: 'fleet',
    name: 'Fleet',
    // W2.2: '⊟' verified free against the full icon registry at wiring time.
    icon: '⊟',
    category: 'runtime-ops',
    description: 'Live unified process tree: agents, WRFC chains, workflows, watchers, and background processes, with interrupt/kill/steer controls',
    factory: () => new FleetPanel(fleetReadModel, {
      interrupt: (id: string) => fleetReadModel.interrupt(id),
      kill: (id: string, opts: { cascade: boolean }) => fleetReadModel.kill(id, opts),
      // Wave-3 (C6): full-fidelity transcript source for an attached agent
      // tab — live while the agent runs, frozen briefly after it completes
      // (AgentManager's bounded retention ring), empty once evicted (the
      // panel degrades to the on-disk ledger fallback in that case).
      getConversationSnapshot: (agentId: string) => ui.agents.agentManager.getConversationSnapshot(agentId),
      resolveSessionLogPath: (agentId: string) => ui.environment.shellPaths.resolveProjectPath('tui', 'sessions', `${agentId}.jsonl`),
      // Wave-3 (W3.2): queue a message for a live in-process agent/wrfc-subtask member.
      steer: (id: string, text: string) => fleetReadModel.steer(id, text),
    }, deps.configManager),
  });

  // Compat: '/panel open <id>' (and any saved layout/muscle memory) for
  // every retired runtime-ops console still resolves — redirected to fleet,
  // which absorbs orchestration, permissions, communication, task, and
  // process-tree views (see FleetPanel's own description above).
  manager.registerAlias('cockpit', 'fleet');
  manager.registerAlias('approval', 'fleet');
  manager.registerAlias('automation', 'fleet');
  manager.registerAlias('routes', 'fleet');
  manager.registerAlias('control-plane', 'fleet');
  manager.registerAlias('worktrees', 'fleet');
  manager.registerAlias('tasks', 'fleet');
  manager.registerAlias('orchestration', 'fleet');
  manager.registerAlias('ops', 'fleet');
  manager.registerAlias('ops-control', 'fleet');
  manager.registerAlias('communication', 'fleet');
  manager.registerAlias('incident', 'fleet');
  // Re-pointed: forensics used to resolve to the (now-retired) incident
  // workspace (WO-114); both ids now land on fleet directly — alias
  // resolution is a single hop, so this cannot chain through 'incident'.
  manager.registerAlias('forensics', 'fleet');

  // local-auth is a DELIBERATE EXCEPTION to the W6.1 purge: it stays a
  // registered panel because it is the host for the masked password-entry
  // sub-mode (LocalAuthPanel.openMaskedEntry, driven by
  // ctx.openLocalAuthMaskedEntry — the only path that keeps a plaintext
  // password out of argv/history/scrollback). Its browse view is mirrored by
  // local-auth-modal (reached via the /local-auth front-door), but the panel
  // itself cannot be retired without regressing that secure input, and no
  // 'local-auth' modal redirect is registered (so openLocalAuthMaskedEntry's
  // showPanel('local-auth') + getPanel('local-auth') still resolve to it).
  manager.registerType({
    id: 'local-auth',
    name: 'Local Auth',
    icon: 'U',
    category: 'security-policy',
    description: 'Local daemon/listener auth users, bootstrap posture, and active sessions (also the masked password-entry host)',
    factory: () => new LocalAuthPanel(deps.localUserAuthManager),
  });

  // W6.1 (the purge) — group B: register the ecosystem/governance panel→modal
  // redirects so `/panel open <id>` and saved layouts resolve to the modal
  // (via the injected openModal callback) instead of a retired panel. Config +
  // dispatch registration with the config-modal host is a separate one-call
  // step (registerBuiltinModals in builtin-modals.ts) wired by the integrator.
  registerEcosystemModalRedirects(manager);
}
