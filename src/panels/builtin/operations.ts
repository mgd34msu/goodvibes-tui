import type { PanelManager } from '../panel-manager.ts';
import { FleetPanel } from '../fleet-panel.ts';
import { createFleetReadModel } from '../fleet-read-model.ts';
import { FleetActs, type FleetDiffSurface } from '../fleet-acts.ts';
import { createFleetGateway } from '../fleet-gateway.ts';
import { FleetSpawn, createAcpSpawnGateway } from '../fleet-spawn.ts';
import { DiffPanel } from '../diff-panel.ts';
import { LocalAuthPanel } from '../local-auth-panel.ts';
import { NotificationsPanel } from '../notifications-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireUiServices } from './shared.ts';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';

// the former single 'monitoring' category (33 panels pre-merge) is
// split into five operator domains, applied per-registration below. Kept in
// this file's original registration order (rather than physically regrouped
// by category) because several registrations below close over shared local
// state — `ui` — defined once near the top of this function.
//
// (the purge): cockpit, approval, automation, routes, control-plane,
// worktrees, tasks, orchestration, ops, ops-control, and communication were
// RETIRE-INTO-FLEET (their live views are subsumed by the Fleet panel below
// — each id now redirects there via registerAlias); debug and eval were
// DELETE-disposition (no surviving human surface). See
// .goodvibes/audit/2026-07-04-wave6-briefs.json for the full
// disposition map. The rosterReadModel/agent-lifecycle wiring that used to
// feed CockpitPanel exclusively was removed along with it — Fleet reads the
// process registry directly via fleetReadModel below, not via the roster
// read-model.
//
// MIGRATE-TO-MODAL: the Providers & Connectivity group (services,
// subscription, remote, provider-health) and Security group (settings-sync,
// sandbox) migrated to config-modal surfaces registered in builtin-modals.ts
//; the Ecosystem & Governance group (plugins, skills, hooks, security,
// marketplace, policy, knowledge, memory, docs, qr-code, work-plan,
// project-planning) migrated to config-modal surfaces. All surfaces AND
// their panel-id redirects are registered centrally in registerBuiltinModals
// (builtin-modals.ts) now — the interim ecosystem redirect bridge was deleted
// with the group-B port. local-auth is a DELIBERATE EXCEPTION — see below.
export function registerOperationsPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  const ui = requireUiServices(deps);

  // Fleet — the live unified process tree, read from the single
  // process registry constructed once in runtime/services.ts (shared with
  // every other consumer rather than duplicated here; the registry owns its
  // own coalesced tick, so no manual lifecycle-event wiring is needed).
  // runtimeBus is also passed so the read model can subscribe
  // to the honest COMMUNICATION_CONSUMED steer-ack signal (fleet-read-model.ts).
  const fleetReadModel = createFleetReadModel(ui.runtime.processRegistry, ui.runtime.runtimeBus);

  // The Fleet panel's waiting-on-human acts (pick / conflict / discard) drive
  // gateway verbs over the same operator invoke path the command layer uses, and
  // reuse the shared DiffPanel (candidate diffs + the pick confirm overlay) and
  // the CI fix-session jump affordance. Built here so the panel stays thin.
  const fleetNotify = deps.fleetActsNotify ?? (() => {});
  const armFixSessionAttach = deps.armFixSessionAttach ?? (() => {});
  const diffSurface: FleetDiffSurface = {
    show: (_title, unifiedDiff) => {
      let panel = manager.getAllOpen().find((p) => p.id === 'diff');
      if (!panel) { try { panel = manager.open('diff'); } catch { return; } }
      manager.activateById('diff');
      if (!manager.isVisible()) manager.show();
      manager.focusPanels();
      (panel as DiffPanel).loadRawDiff(unifiedDiff);
    },
    armConfirm: (opts) => {
      let panel = manager.getAllOpen().find((p) => p.id === 'diff');
      if (!panel) { try { panel = manager.open('diff'); } catch { return; } }
      manager.activateById('diff');
      if (!manager.isVisible()) manager.show();
      manager.focusPanels();
      (panel as DiffPanel).confirmOverlay.arm(opts);
    },
    close: () => { manager.close('diff'); },
  };
  const fleetActs = new FleetActs({
    resolveGateway: () => createFleetGateway({
      configManager: deps.configManager,
      homeDirectory: ui.environment.shellPaths.homeDirectory,
      armFixSessionAttach,
    }),
    diffSurface,
    notify: fleetNotify,
    markDirty: deps.requestRender ?? (() => {}),
    findNode: (nodeId: string) => fleetReadModel.getSnapshot().rows.find((r) => r.node.id === nodeId)?.node ?? null,
  });

  // The ACP spawn affordance ('n'): host a discovered third-party agent as an
  // acp-agent row over the same operator invoke path the acts use.
  const fleetSpawn = new FleetSpawn({
    resolveGateway: () => createAcpSpawnGateway({
      configManager: deps.configManager,
      homeDirectory: ui.environment.shellPaths.homeDirectory,
    }),
    currentDirectory: () => ui.environment.shellPaths.workingDirectory,
    notify: fleetNotify,
    markDirty: deps.requestRender ?? (() => {}),
  });

  manager.registerType({
    id: 'fleet',
    name: 'Fleet',
    // '⊟' verified free against the full icon registry at wiring time.
    icon: '⊟',
    category: 'runtime-ops',
    description: 'Live unified process tree: agents, WRFC chains, workflows, watchers, and background processes, with interrupt/kill/steer controls',
    factory: () => new FleetPanel(fleetReadModel, {
      interrupt: (id: string) => fleetReadModel.interrupt(id),
      // Re-arm a paused trigger/schedule/automation job.
      resume: (id: string) => fleetReadModel.resume(id),
      kill: (id: string, opts: { cascade: boolean }) => fleetReadModel.kill(id, opts),
      // Full-fidelity transcript source for an attached agent
      // tab — live while the agent runs, frozen briefly after it completes
      // (AgentManager's bounded retention ring), empty once evicted (the
      // panel degrades to the on-disk ledger fallback in that case).
      getConversationSnapshot: (agentId: string) => ui.agents.agentManager.getConversationSnapshot(agentId),
      resolveSessionLogPath: (agentId: string) => ui.environment.shellPaths.resolveProjectPath(GOODVIBES_TUI_SURFACE_ROOT, 'sessions', `${agentId}.jsonl`),
      // Queue a message for a live in-process agent/wrfc-subtask member.
      steer: (id: string, text: string) => fleetReadModel.steer(id, text),
    }, deps.configManager, fleetActs, fleetSpawn),
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
  // workspace; both ids now land on fleet directly — alias
  // resolution is a single hop, so this cannot chain through 'incident'.
  manager.registerAlias('forensics', 'fleet');

  // Notifications — the visible home for the panel_only notification
  // target: anything a NotificationRouter (SDK) routes there (including
  // burst/batch-collapsed groups, shown with their real running count)
  // renders here instead of having nowhere to go. See notifications-feed.ts
  // for why this exists. Not preloaded (only 'tokens' preloads, per the
  // panel-consolidation cleanup below) — the shared feed singleton
  // accumulates independently of whether this view has been opened yet, so
  // nothing is lost by instantiating it lazily on first open like every
  // other panel here.
  manager.registerType({
    id: 'notifications',
    name: 'Notifications',
    icon: 'N',
    category: 'runtime-ops',
    description: 'Notifications routed to the panel-only target (quiet/balanced-mode operational chatter, burst- and batch-collapsed groups) with their real collapsed counts',
    factory: () => new NotificationsPanel(),
  });

  // local-auth is a DELIBERATE EXCEPTION to the purge: it stays a
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
}
