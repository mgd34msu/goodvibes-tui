// ---------------------------------------------------------------------------
// fleet-acts.ts
//
// The Fleet panel's waiting-on-human ACTS: the flagged pick row, the flagged
// conflict row, and the worktree discard all act from the panel selection with
// no id ever typed. This controller owns that flow so fleet-panel.ts stays under
// the 800-line architecture cap, the panel delegates the trigger keys, the
// pick-mode input, and the pick-mode render here.
//
//   • Pick , the flagged workstream row (needsAttention 'pick') opens a
//     candidate picker (best-of-N held attempts, from fleet.attempts.list);
//     ↑↓ chooses the winner, its diff shows in the shared DiffPanel, and Enter
//     drives fleet.attempts.pick preview (confirm:false) -> confirm (confirm:true)
//     through the DiffPanel's existing confirm overlay. No group/candidate id is
//     ever typed, the panel derives them from the node and the selection.
//   • Conflict, the flagged work-item row (needsAttention 'conflict') runs
//     fleet.conflicts.resolve and hands the STAMPED resolution session id to the
//     shared one-key jump/attach affordance (the CI fix-session machinery). On
//     resolution the SDK reclaims the tree and the row clears on the next tick.
//   • Discard, a worktree-owning work-item row runs worktrees.discard behind a
//     confirm and renders the honest receipt (branch KEPT, dirty state preserved
//     as a commit), no path retyping.
// ---------------------------------------------------------------------------

import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { WorkItem } from '@pellux/goodvibes-sdk/platform/orchestration';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { isPanelSearchBackspace, isPanelSearchCancel, isPanelSearchCommit, isPanelSearchPrintable } from './search-focus.ts';
import { appendSteerText } from './fleet-tabs.ts';
import { isObservedExternalNode, observedKindLabel, type ObservedNode } from './fleet-observed-render.ts';
import {
  buildKeyboardHints,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';
import { buildPanelLine } from './polish.ts';
import { formatAgentCost } from './agent-inspector-shared.ts';
import { fleetNodeAttention } from './fleet-read-model.ts';
import {
  workItemIdFromNodeId,
  workstreamIdFromNodeId,
  type FleetAttemptCandidate,
  type FleetGateway,
  type FleetGatewayResolution,
  type FleetGraphSnapshot,
  type FleetHeldMergeGroup,
} from './fleet-gateway.ts';

/** The DiffPanel-backed surface the pick act reuses: show a diff, arm its confirm overlay, close it. */
export interface FleetDiffSurface {
  /** Open + focus the diff panel showing this unified diff (title labels the candidate). */
  show(title: string, unifiedDiff: string): void;
  /** Arm the diff panel's existing confirm overlay (Enter/y merges, n/Esc cancels). */
  armConfirm(opts: {
    readonly id: string;
    readonly label: string;
    readonly verb: string;
    readonly onConfirm: () => void | Promise<void>;
    readonly onCancel?: () => void;
  }): void;
  /** Close the diff panel and return focus to the prompt. */
  close(): void;
}

export interface FleetActsDeps {
  /** Resolve a live gateway per act (so a daemon that comes up mid-session is seen); honest unavailable reason otherwise. */
  readonly resolveGateway: () => FleetGatewayResolution;
  /** The shared DiffPanel surface (reused for candidate diffs + the pick confirm). */
  readonly diffSurface: FleetDiffSurface;
  /** Surface a result/receipt/error line to the operator (system message, high priority). */
  readonly notify: (message: string) => void;
  /** Repaint request when the controller's own state (pick mode) changes. */
  readonly markDirty: () => void;
  /** The live node for an id in the current snapshot, for reading raw work-item fields; null when pruned. */
  readonly findNode: (nodeId: string) => ProcessNode | null;
}

/** Live pick-mode state: the group being decided + the currently-highlighted candidate. */
interface PickMode {
  readonly workstreamNodeId: string;
  readonly group: FleetHeldMergeGroup;
  /** Index into the group's HELD (pickable) candidates. */
  selectedHeldIndex: number;
}

const C = DEFAULT_PANEL_PALETTE;

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 10)}…` : id;
}

/** The held (pick-ready) candidates of a group, in attempt order, the only ones a winner can be chosen from. */
export function heldCandidates(group: FleetHeldMergeGroup): FleetAttemptCandidate[] {
  return group.candidates.filter((c) => c.state === 'held-merge').slice().sort((a, b) => a.attemptIndex - b.attemptIndex);
}

/** The raw WorkItem behind a work-item node, or null (non-work-item / no raw). */
export function workItemFromNode(node: ProcessNode): WorkItem | null {
  const item = (node.raw as { item?: WorkItem } | undefined)?.item;
  return item ?? null;
}

export class FleetActs {
  private pick: PickMode | null = null;
  /** Live observed-agent steer composer: the row being steered + its draft. Drill-in only. */
  private observedSteer: { readonly nodeId: string; draft: string } | null = null;
  /** Per-workstream-node graph snapshot cache (null = fetched, unavailable). undefined = not fetched. */
  private readonly graphCache = new Map<string, FleetGraphSnapshot | null>();
  private readonly graphInFlight = new Set<string>();

  public constructor(private readonly deps: FleetActsDeps) {}

  /** True while the candidate picker owns the fleet view + input. */
  public pickModeActive(): boolean {
    return this.pick !== null;
  }

  /**
   * Dispatch an act-trigger key pressed on the tree while `node` is selected.
   * Returns true when consumed (an act fired), false to fall through to the
   * panel's ordinary key handling (so Enter still attaches an agent tab, etc.).
   */
  public handleTreeKey(key: string, node: ProcessNode): boolean {
    if (key === 'enter' || key === 'return') {
      const attention = fleetNodeAttention(node);
      if (attention?.reason === 'pick') { void this.beginPick(node); return true; }
      if (attention?.reason === 'conflict') { void this.resolveConflict(node); return true; }
      return false; // not an act row, let attach handle it
    }
    if (key === 'D') {
      return this.discardWorktree(node);
    }
    // Observed foreign agents steer as a DRILL-IN only: 's' on the selected row
    // opens the composer in its detail (never an attach, never a list verb).
    if (key === 's' && isObservedExternalNode(node)) {
      return this.openObservedSteer(node);
    }
    return false;
  }

  // ── Observed-agent steer (drill-in composer) ──────────────────────────────

  /** True while the observed-steer composer owns input. */
  public observedSteerActive(): boolean {
    return this.observedSteer !== null;
  }

  /** The active observed-steer draft for `nodeId`, or null, the detail renderer shows the compose line only for the composing row. */
  public observedSteerDraftFor(nodeId: string): string | null {
    return this.observedSteer && this.observedSteer.nodeId === nodeId ? this.observedSteer.draft : null;
  }

  /**
   * Open the drill-in steer composer for an observed foreign-agent row. A row
   * with a live tmux channel opens an input; a channel-less row keeps NO input
   * and states the honest reason (owner ruling: steer is drill-in-only, and stop
   * is never offered on an observed row).
   */
  public openObservedSteer(node: ObservedNode): boolean {
    const channel = node.observed.steer;
    if (channel.kind !== 'tmux') {
      this.deps.notify(`Cannot steer this ${observedKindLabel(node.observed.externalKind)} session: ${channel.reason}.`);
      return true;
    }
    this.observedSteer = { nodeId: node.id, draft: '' };
    this.deps.markDirty();
    return true;
  }

  /** Input while the observed-steer composer is open (mirrors the tab steer composer). */
  public handleObservedSteerInput(key: string): boolean {
    if (!this.observedSteer) return false;
    if (isPanelSearchCancel(key)) { this.observedSteer = null; this.deps.markDirty(); return true; }
    if (isPanelSearchCommit(key)) { void this.submitObservedSteer(); return true; }
    if (isPanelSearchBackspace(key)) { this.observedSteer.draft = this.observedSteer.draft.slice(0, -1); this.deps.markDirty(); return true; }
    if (key.length === 1 && (isPanelSearchPrintable(key) || key === '\r' || key === '\n')) {
      this.observedSteer.draft = appendSteerText(this.observedSteer.draft, key);
      this.deps.markDirty();
      return true;
    }
    return true; // absorb every other key while composing
  }

  /** Drive fleet.observed.steer over the daemon; the row's own channel routes the send-keys server-side. */
  private async submitObservedSteer(): Promise<void> {
    if (!this.observedSteer) return;
    const { nodeId, draft } = this.observedSteer;
    const text = draft.trim();
    this.observedSteer = null;
    this.deps.markDirty();
    if (text.length === 0) return; // empty submit just closes the composer
    const gateway = this.requireGateway();
    if (!gateway) return;
    try {
      const result = await gateway.steerObserved({ id: nodeId, text });
      this.deps.notify(result.queued
        ? '[Fleet] Steer delivered to the foreign session (tmux send-keys).'
        : `[Fleet] Steer refused: ${result.reason ?? 'the foreign session exposes no channel'}.`);
    } catch (err) {
      this.deps.notify(`Observed steer failed: ${summarizeError(err)}`);
    }
  }

  // ── Task-graph posture (in-panel edges/pool under a workstream) ───────────

  /**
   * Lazily fetch the task graph (fleet.graph.get) for a selected workstream row
   * so the in-panel detail can render its edges/pool posture WITHOUT opening
   * /graph. Idempotent: fetches once per node (cache + in-flight guard), quiet
   * on an unavailable daemon (caches null rather than nagging every frame). A
   * no-op for any non-workstream node.
   */
  public ensureGraphFor(node: ProcessNode): void {
    const workstreamId = workstreamIdFromNodeId(node.id);
    if (workstreamId === null) return;
    if (this.graphCache.has(node.id) || this.graphInFlight.has(node.id)) return;
    const resolution = this.deps.resolveGateway();
    if (!resolution.available) { this.graphCache.set(node.id, null); return; }
    this.graphInFlight.add(node.id);
    void resolution.gateway.getGraph(workstreamId)
      .then((snapshot) => { this.graphCache.set(node.id, snapshot); })
      .catch(() => { this.graphCache.set(node.id, null); })
      .finally(() => { this.graphInFlight.delete(node.id); this.deps.markDirty(); });
  }

  /** The cached graph for a node (null = fetched/unavailable, undefined = not yet fetched). */
  public graphFor(nodeId: string): FleetGraphSnapshot | null | undefined {
    return this.graphCache.get(nodeId);
  }

  // ── Pick (STEP 3) ─────────────────────────────────────────────────────────

  /** Open the candidate picker for a flagged pick row (the workstream node). */
  public async beginPick(node: ProcessNode): Promise<void> {
    const workstreamId = workstreamIdFromNodeId(node.id);
    if (workstreamId === null) { this.deps.notify('This row is not a workstream with a ready pick.'); return; }
    const gateway = this.requireGateway();
    if (!gateway) return;
    let group: FleetHeldMergeGroup | undefined;
    try {
      const { groups } = await gateway.listAttempts(workstreamId);
      group = groups.find((g) => g.ready && heldCandidates(g).length > 0);
    } catch (err) {
      this.deps.notify(`Could not read the best-of-N candidates: ${summarizeError(err)}`);
      return;
    }
    if (!group) { this.deps.notify('No ready best-of-N group on this workstream; every attempt must settle first.'); return; }
    this.pick = { workstreamNodeId: node.id, group, selectedHeldIndex: 0 };
    this.showSelectedDiff();
    this.deps.markDirty();
  }

  /** Input while the candidate picker is active. */
  public handlePickInput(key: string): boolean {
    if (!this.pick) return false;
    const held = heldCandidates(this.pick.group);
    if (key === 'escape' || key === 'esc') { this.pick = null; this.deps.markDirty(); return true; }
    if (key === 'up' || key === 'k') {
      this.pick.selectedHeldIndex = (this.pick.selectedHeldIndex - 1 + held.length) % held.length;
      this.showSelectedDiff();
      this.deps.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.pick.selectedHeldIndex = (this.pick.selectedHeldIndex + 1) % held.length;
      this.showSelectedDiff();
      this.deps.markDirty();
      return true;
    }
    if (key === 'enter' || key === 'return') { void this.confirmSelectedPick(); return true; }
    return true; // absorb every other key while the picker owns the view
  }

  private showSelectedDiff(): void {
    if (!this.pick) return;
    const cand = heldCandidates(this.pick.group)[this.pick.selectedHeldIndex];
    if (!cand) return;
    const diff = cand.diff?.unifiedDiff?.trim();
    if (diff) this.deps.diffSurface.show(cand.title, cand.diff!.unifiedDiff);
    else this.deps.diffSurface.show(cand.title, '@@ pick @@\n (no diff to preview for this candidate)');
  }

  /**
   * Drive fleet.attempts.pick preview (confirm:false) then, behind the DiffPanel
   * confirm overlay, confirm (confirm:true). No id is typed, the group id and
   * the winner item id both come from the picker state.
   */
  private async confirmSelectedPick(): Promise<void> {
    if (!this.pick) return;
    const { group } = this.pick;
    const cand = heldCandidates(group)[this.pick.selectedHeldIndex];
    if (!cand) return;
    const gateway = this.requireGateway();
    if (!gateway) return;
    // Preview: confirm:false returns the group WITHOUT applying (the honest
    // "here is what you are about to merge"). A refusal to even preview surfaces.
    try {
      await gateway.pick({ groupId: group.groupId, winnerItemId: cand.itemId, confirm: false });
    } catch (err) {
      this.deps.notify(`Pick preview failed: ${summarizeError(err)}`);
      return;
    }
    const losers = heldCandidates(group).length - 1;
    this.deps.diffSurface.show(cand.title, cand.diff?.unifiedDiff?.trim() ? cand.diff.unifiedDiff : '@@ pick @@\n (no diff to preview for this candidate)');
    this.deps.diffSurface.armConfirm({
      id: `${group.groupId}:${cand.itemId}`,
      verb: 'Pick',
      label: `Pick attempt ${cand.attemptIndex + 1} ("${cand.title}"): merge it, clean the ${losers} other worktree(s)`,
      onConfirm: async () => {
        try {
          const result = await gateway.pick({ groupId: group.groupId, winnerItemId: cand.itemId, confirm: true });
          if (result.applied) {
            const losersCleaned = result.loserItemIds?.length ?? losers;
            this.deps.notify(`[Fleet] Winner picked for group ${shortId(group.groupId)}: attempt ${cand.attemptIndex + 1} merged, ${losersCleaned} loser worktree(s) cleaned.`);
          } else {
            this.deps.notify(`[Fleet] Pick not applied for group ${shortId(group.groupId)}: the daemon still requires confirmation.`);
          }
        } catch (err) {
          this.deps.notify(`Pick failed: ${summarizeError(err)}`);
        }
        this.deps.diffSurface.close();
        this.pick = null;
        this.deps.markDirty();
      },
      onCancel: () => {
        this.deps.diffSurface.close();
        this.pick = null;
        this.deps.notify('Pick cancelled: nothing merged, no worktree cleaned.');
        this.deps.markDirty();
      },
    });
  }

  // ── Conflict (STEP 4) ─────────────────────────────────────────────────────

  /** Run fleet.conflicts.resolve on a flagged conflict row; on success arm the shared jump/attach on the stamped session. */
  public async resolveConflict(node: ProcessNode): Promise<void> {
    const itemId = workItemIdFromNodeId(node.id);
    if (itemId === null) { this.deps.notify('This row is not a conflicted work item.'); return; }
    const gateway = this.requireGateway();
    if (!gateway) return;
    try {
      const result = await gateway.resolveConflict(itemId);
      const files = result.files.length > 0 ? ` over ${result.files.length} conflicted file(s)` : '';
      this.deps.notify(`[Fleet] Conflict resolution session started for ${shortId(itemId)}${files}; press j to jump to it.`);
      // Reuse the CI fix-session machinery: hand the STAMPED session id to the
      // shared one-key jump affordance. The kept tree is reclaimed by the SDK on
      // a successful re-merge, and the flagged row clears on the next snapshot.
      gateway.armFixSessionAttach(result.sessionId);
    } catch (err) {
      this.deps.notify(`Conflict resolution failed: ${summarizeError(err)}`);
    }
  }

  // ── Discard (STEP 5) ──────────────────────────────────────────────────────

  /**
   * Discard the worktree a work-item row owns, behind a confirm, rendering the
   * honest receipt (branch KEPT, dirty state preserved as a commit). Returns
   * true when the key is consumed (a worktree row), false to fall through.
   */
  public discardWorktree(node: ProcessNode): boolean {
    const item = workItemFromNode(node);
    const path = item?.worktreePath;
    if (!path) return false; // not a worktree-owning row, let the key fall through
    const gateway = this.requireGateway();
    if (!gateway) return true;
    this.deps.diffSurface.armConfirm({
      id: `discard:${path}`,
      verb: 'Discard',
      label: `Discard worktree ${path}: the branch is KEPT and dirty state preserved as a commit`,
      onConfirm: async () => {
        try {
          const receipt = await gateway.discardWorktree(path);
          if (receipt.ok) {
            this.deps.notify(`[Fleet] Worktree discarded: ${receipt.path}\n  branch kept: ${receipt.branch || '(unknown)'}\n  preservation commit: ${receipt.preservedCommit || '(none; nothing to preserve)'}\n  ${receipt.detail}`);
          } else {
            this.deps.notify(`[Fleet] Worktree discard refused for ${receipt.path}: ${receipt.detail}`);
          }
        } catch (err) {
          this.deps.notify(`Worktree discard failed: ${summarizeError(err)}`);
        }
        this.deps.diffSurface.close();
        this.deps.markDirty();
      },
      onCancel: () => {
        this.deps.diffSurface.close();
        this.deps.notify('Discard cancelled: the worktree is untouched.');
        this.deps.markDirty();
      },
    });
    return true;
  }

  // ── Render (pick mode) ────────────────────────────────────────────────────

  /** The candidate picker view (replaces the tree while pick mode is active). */
  public renderPickMode(width: number, height: number, palette: PanelPalette = C): Line[] {
    const P = palette;
    if (!this.pick) return [];
    const { group } = this.pick;
    const held = heldCandidates(group);
    const lines: Line[] = [];
    lines.push(buildPanelLine(width, [
      [' Best-of-N winner pick: ', P.label],
      [group.sourceTitle, P.value],
    ]));
    lines.push(buildPanelLine(width, [[' Choose the winner; its diff shows in the diff panel. No id is typed.', P.dim]]));
    lines.push(buildPanelLine(width, [['', P.dim]]));
    held.forEach((cand, index) => {
      const selected = index === this.pick!.selectedHeldIndex;
      const files = cand.diff ? `${cand.diff.files.length} file(s)` : 'no diff';
      const cost = cand.usage.costUsd !== null && cand.usage.costState !== 'unpriced'
        ? formatAgentCost(cand.usage.costUsd)
        : 'unpriced';
      lines.push(buildPanelLine(width, [
        [selected ? ' ▸ ' : '   ', selected ? P.info : P.dim],
        [`${cand.attemptIndex + 1}. `, P.label],
        [cand.title, selected ? P.value : P.dim],
        [`, ${files}, ${cost}`, P.dim],
      ]));
    });
    if (group.judgment?.proposedWinnerItemId) {
      const proposed = held.find((c) => c.itemId === group.judgment!.proposedWinnerItemId);
      lines.push(buildPanelLine(width, [['', P.dim]]));
      lines.push(buildPanelLine(width, [
        [' judge proposal (model, advisory): ', P.label],
        [proposed ? `attempt ${proposed.attemptIndex + 1}` : shortId(group.judgment.proposedWinnerItemId), P.info],
      ]));
    }
    const footerLines = [buildKeyboardHints(width, [
      { keys: '↑↓', label: 'choose' },
      { keys: 'Enter', label: 'pick (confirm)' },
      { keys: 'Esc', label: 'cancel' },
    ], P)];
    return buildPanelWorkspace(width, height, { title: 'Fleet: Pick winner', sections: [{ lines }], footerLines, palette: P });
  }

  private requireGateway(): FleetGateway | null {
    const resolution = this.deps.resolveGateway();
    if (!resolution.available) { this.deps.notify(`[Fleet] ${resolution.reason}`); return null; }
    return resolution.gateway;
  }
}
