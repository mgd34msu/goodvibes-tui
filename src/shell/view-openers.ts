/**
 * view-openers.ts, the openers for the built-in modals: Agents, Usage,
 * Changes (and its previews), Notifications and the local-auth password
 * prompt, plus ctx.openView, which turns any current or old view name
 * ('fleet', 'cockpit', 'tokens', 'git', 'providers', …) into the modal that
 * holds it now (input/views.ts).
 *
 * Every modal is a kit SurfaceModal pushed on the input handler's modal host.
 * Opening one that is already open brings it to the top instead of stacking a
 * second copy.
 */

import type { CommandContext } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { SurfaceModal } from '../input/surface-modal-host.ts';
import type { ShellViews } from '../panels/builtin-views.ts';
import type { ViewPanelAdapter } from '../panels/view-panel-adapter.ts';
import { AgentsModal } from '../input/agents-modal.ts';
import { UsageModal } from '../input/usage-modal.ts';
import { ChangesModal, type ChangesDeps } from '../input/changes-modal.ts';
import { NotificationsModal } from '../input/notifications-modal.ts';
import { MaskedEntryModal } from '../input/masked-entry-modal.ts';
import { confirmThrough } from '../input/confirm-dialog.ts';
import { resolveViewName, type ViewTarget } from '../input/views.ts';
import { getSharedNotificationFeed } from '../panels/notifications-feed.ts';
import { getSharedHostedSessionFeed } from '../panels/hosted-session-feed.ts';
import { revertReviewHunk } from '../input/commands/review-runtime.ts';

export interface WireViewOpenersOptions {
  readonly commandContext: CommandContext;
  readonly input: InputHandler;
  readonly views: ShellViews;
  readonly viewPanels: ViewPanelAdapter;
  readonly render: () => void;
}

/** Split a preview text into a diff and a note: `@@ label @@\n text` is a note, not a hunk. */
function previewParts(text: string): { diff: string | null; note: string | null } {
  const first = text.split('\n', 1)[0] ?? '';
  if (/^@@ (?!-)/.test(first)) return { diff: null, note: text.slice(first.length + 1).trim() || null };
  return { diff: text, note: null };
}

export function wireViewOpeners(options: WireViewOpenersOptions): void {
  const { commandContext, input, views, viewPanels, render } = options;
  const host = input.surfaceModals;

  const findOpen = <T extends SurfaceModal>(type: abstract new (...args: never[]) => T): T | undefined =>
    host.modals().find((modal): modal is T => modal instanceof type);

  const show = (modal: SurfaceModal): void => {
    host.push(modal);
    render();
  };

  // ── Agents ────────────────────────────────────────────────────────────────
  commandContext.openAgents = (opts = {}) => {
    const modal = findOpen(AgentsModal) ?? new AgentsModal({
      readModel: views.fleet.readModel,
      actions: views.fleet.actions,
      acts: views.fleet.acts,
      spawn: views.fleet.spawn,
      configManager: views.configManager,
      hosted: getSharedHostedSessionFeed(),
      steerHosted: (text) => { void commandContext.executeCommand?.('hosted', ['say', ...text.split(/\s+/)]); },
      sessionCost: () => {
        const cost = views.usage.sessionCost();
        return cost.priced ? cost.usd : null;
      },
      confirm: (confirmOptions) => confirmThrough(host, confirmOptions),
      requestRender: render,
      openSessionView: (target) => commandContext.openSessionView?.(target) ?? false,
    });
    if (opts.target) modal.reveal(opts.target);
    if (opts.hosted) modal.showHosted();
    show(modal);
  };

  // ── Usage ─────────────────────────────────────────────────────────────────
  commandContext.openUsage = (opts = {}) => {
    const existing = findOpen(UsageModal);
    if (existing) {
      if (opts.tab) existing.tab = opts.tab;
      show(existing);
      return;
    }
    show(new UsageModal({
      tracker: views.usage,
      tab: opts.tab,
      compact: () => { void commandContext.executeCommand?.('compact', []).finally(render); },
      requestRender: render,
    }));
  };
  // A click on the footer's token or context row opens Usage.
  input.onFooterTarget = (target) => {
    if (target === 'usage') commandContext.openUsage?.();
  };

  // ── Changes ───────────────────────────────────────────────────────────────
  const changesDeps: ChangesDeps = {
    workingDirectory: views.workingDirectory,
    getSessionFiles: views.getSessionFiles,
    requestRender: render,
    submitInput: (text) => commandContext.submitInput?.(text),
    openInEditor: (path, line) => commandContext.openFileInEditor?.(path, line),
    revertHunk: (hunk) => revertReviewHunk(commandContext, hunk),
    confirm: (confirmOptions) => confirmThrough(host, confirmOptions),
  };
  // One workspace for the session: reviewed marks and attached comments survive closing it.
  const workspace = new ChangesModal(changesDeps, 'workspace');
  commandContext.openChanges = (opts = {}) => {
    show(workspace);
    void workspace.reload(opts.source ?? workspace.source);
  };

  const preview = (title: string, text: string | null, note: string | null): ChangesModal => {
    const modal = new ChangesModal(changesDeps, 'preview');
    const parts = text ? previewParts(text) : { diff: null, note: null };
    modal.loadPreview(title, parts.diff, note ?? parts.note);
    show(modal);
    return modal;
  };
  commandContext.previewChanges = async (opts) => {
    const modal = preview(opts.title, opts.diff ?? null, opts.note ?? null);
    if (!opts.question) return false;
    return modal.ask(opts.question);
  };

  // The fleet acts show candidate diffs and ask over them through this.
  let fleetPreview: ChangesModal | null = null;
  views.bridge.diffSurface = {
    show: (title, diff) => {
      if (fleetPreview) host.close(fleetPreview, 'done');
      fleetPreview = preview(title, diff, null);
    },
    armConfirm: (arm) => {
      const tone = arm.verb === 'Discard' ? 'danger' as const : 'warning' as const;
      const asked = fleetPreview && host.modals().includes(fleetPreview)
        ? fleetPreview.ask({ text: arm.label, confirmLabel: arm.verb, tone })
        : confirmThrough(host, { title: `${arm.verb}?`, body: arm.label, confirmLabel: arm.verb, tone });
      void asked.then((ok) => {
        if (ok) void arm.onConfirm();
        else arm.onCancel?.();
        render();
      });
    },
    close: () => {
      if (fleetPreview) host.close(fleetPreview, 'done');
      fleetPreview = null;
      render();
    },
  };

  // ── Notifications ─────────────────────────────────────────────────────────
  const redirect = (name: string): string | undefined => views.modalSurfaces.getModalRedirect(name);
  commandContext.openNotifications = () => {
    show(findOpen(NotificationsModal) ?? new NotificationsModal({
      feed: getSharedNotificationFeed(),
      resolveSubject: (subject) => (resolveViewName(subject, redirect) ? () => { openView(subject); } : null),
    }));
  };

  // ── Local-auth password prompt ────────────────────────────────────────────
  const openMaskedEntry = (kind: 'add-user' | 'rotate-password', username?: string): void => {
    show(new MaskedEntryModal({
      kind,
      username,
      auth: views.localUserAuthManager,
      onDone: (message) => { commandContext.print(message); render(); },
    }));
  };
  views.bridge.openMaskedEntry = openMaskedEntry;
  commandContext.openLocalAuthMaskedEntry = openMaskedEntry;

  // ── Any view by name ──────────────────────────────────────────────────────
  const openView = (name: string, target?: ViewTarget): boolean => {
    const route = resolveViewName(name, redirect);
    if (!route) return false;
    switch (route.kind) {
      case 'agents': commandContext.openAgents?.({ target, hosted: route.hosted }); break;
      case 'usage': commandContext.openUsage?.({ tab: route.tab }); break;
      case 'changes': commandContext.openChanges?.({ source: route.mode === 'git' ? 'working' : 'session' }); break;
      case 'notifications': commandContext.openNotifications?.(); break;
      case 'sessions': commandContext.openSessionPicker?.(); break;
      case 'modal': commandContext.openModal?.(route.name); break;
    }
    return true;
  };
  commandContext.openView = openView;
  viewPanels.setOpener((id) => openView(id));

  // The older per-console callbacks commands still call, each onto its modal.
  commandContext.openForensicsPanel = () => { openView('forensics'); };
  commandContext.openIncidentPanel = () => { openView('incident'); };
  commandContext.openPolicyPanel = () => { openView('policy'); };
  commandContext.openHooksPanel = () => { openView('hooks'); };
  commandContext.openCommunicationPanel = () => { openView('communication'); };
  commandContext.openOrchestrationPanel = () => { openView('orchestration'); };
  commandContext.openCockpitPanel = () => { openView('cockpit'); };
  commandContext.openSecurityPanel = () => { openView('security'); };
  commandContext.openKnowledgePanel = () => { openView('knowledge'); };
  commandContext.openMemoryPanel = () => { openView('memory'); };
  commandContext.openRemotePanel = () => { openView('remote'); };
  commandContext.openSubscriptionPanel = () => { openView('subscription'); };
}
