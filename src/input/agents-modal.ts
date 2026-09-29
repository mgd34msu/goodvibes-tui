/**
 * agents-modal.ts, the Agents modal (/agents, F2, ctrl+o, ctrl+p "agents" and
 * every old console name: fleet, cockpit, tasks, wrfc, inspector, ops, …).
 *
 * One list of everything running or finished this session (agents, WRFC
 * chains and their members, workflows, watchers, schedules, background
 * processes, third-party agents hosted over ACP, observed foreign sessions)
 * plus the daemon-hosted conversation this terminal is attached to. The right
 * side tails the selected one live.
 *
 * Keys on the list: ↑↓ move; Enter opens the selected agent (or background
 * process) full screen, outside the modal, with its own composer (or acts on
 * a row waiting on you: pick a winner, resolve a conflict); other kinds with
 * a transcript open full height inside the modal; s steers
 * (inline input); x stops it and its descendants (asks first); i interrupts;
 * p pauses or resumes; n hosts a third-party agent; D discards a worktree;
 * b jumps to the next thing waiting on you; f follows the newest running
 * agent; v switches to the archive, a archives or restores, A archives
 * everything finished; / filters. In the full view ctrl+x stops (asks first),
 * [ ] steps between opened agents, and Esc goes back up a level and never
 * interrupts anything.
 */

import { readFile } from 'node:fs/promises';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ProcessNode, SteerResult } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { SurfaceModal, SurfaceModalHost } from './surface-modal-host.ts';
import type { KitHint, SurfaceLayer } from '../renderer/surface-kit.ts';
import type { KitRow } from '../renderer/surface-kit-list.ts';
import { activeTokens } from '../renderer/theme.ts';
import { renderAgentsModal, type AgentsDetail, type AgentsModalView, type AgentsText } from '../renderer/agents-modal.ts';
import { formatUsd } from '../renderer/usage-modal.ts';
import {
  fleetAttentionText, fleetNodeAttention, fleetStallMarker, isBlockedOnUserNode, isRunningProcessState, isTerminalProcessState,
  type FleetReadModel, type FleetTreeRow,
} from '../panels/fleet-read-model.ts';
import type { FleetActs } from '../panels/fleet-acts.ts';
import type { FleetSpawn } from '../panels/fleet-spawn.ts';
import {
  activeFleetTab, attachFleetTab, EMPTY_FLEET_TABS_STATE, isAttachableFleetKind, stepFleetTab, type FleetTab, type FleetTabsState,
} from '../panels/fleet-tabs.ts';
import { liveSteerableLabels, reconcileSteerBadges, steerBadgeGlyph, steerRefusalMessage } from '../panels/fleet-steer.ts';
import { FleetStopTracker, fleetKillConfirmArgs, fleetStateDisplay, toggleFleetPause } from '../panels/fleet-stop.ts';
import { formatFleetCost, renderFleetDetailLines } from '../panels/fleet-panel-format.ts';
import { hasFleetCost } from '../panels/fleet-read-model.ts';
import { parseAgentLedger, renderFleetAgentTranscript, renderFleetChainSummary, renderFleetLedgerFallback, renderFleetTranscriptLoading } from '../panels/fleet-transcript.ts';
import { isObservedExternalNode } from '../panels/fleet-observed-render.ts';
import type { HostedSessionFeed } from '../panels/hosted-session-feed.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import { isTextBackspace } from './delete-key-policy.ts';
import type { ConfirmOptions } from './confirm-dialog.ts';
import type { ViewTarget } from './views.ts';
import { hostedBody, hostedHeaderTexts, hostedRowTexts, transcriptTail } from './agents-modal-text.ts';

/** What the modal can do to a process (the process registry, through the fleet read model). */
export interface FleetActionCallbacks {
  readonly interrupt: (id: string) => boolean;
  readonly resume: (id: string) => boolean;
  readonly kill: (id: string, opts: { readonly cascade: boolean }) => readonly string[];
  /** An agent's conversation, live or just finished; empty when unavailable. */
  readonly getConversationSnapshot: (agentId: string) => readonly ConversationMessageSnapshot[];
  /** The agent's on-disk event log, the fallback when its conversation is gone. */
  readonly resolveSessionLogPath: (agentId: string) => string;
  readonly steer: (id: string, text: string) => SteerResult;
}

export interface AgentsModalDeps {
  readonly readModel: FleetReadModel;
  readonly actions: FleetActionCallbacks;
  readonly acts?: FleetActs | null;
  readonly spawn?: FleetSpawn | null;
  readonly configManager?: ConfigManager | null;
  readonly hosted?: HostedSessionFeed;
  /** Send a line to the hosted session (/hosted say). */
  readonly steerHosted?: (text: string) => void;
  /** This session's own cost (the "you" half of the header), or null when unpriced. */
  readonly sessionCost?: () => number | null;
  readonly confirm?: (options: ConfirmOptions) => Promise<boolean>;
  readonly requestRender: () => void;
  /** Tick for elapsed times and steer badges (ms; 0 disables, for tests). */
  readonly tickMs?: number;
  /** Open an agent or background process full screen (shell/session-views.ts); false when it is not known here. */
  readonly openSessionView?: (target: { readonly kind: 'agent' | 'process'; readonly id: string }) => boolean;
}

const HOSTED_ID = 'hosted-session';

type ListEntry = { readonly kind: 'node'; readonly row: FleetTreeRow } | { readonly kind: 'hosted' };

/** One key in the vocabulary the fleet controllers (acts, spawn) take. */
function keyName(token: InputToken): string | null {
  if (token.type === 'text') return token.value.length === 1 ? token.value : null;
  if (token.type === 'key') return token.logicalName ?? null;
  return null;
}

export class AgentsModal implements SurfaceModal {
  readonly name = 'agents';
  view: 'active' | 'archived' = 'active';
  query = '';
  filtering = false;
  selectedId: string | null = null;
  follow = false;
  tabs: FleetTabsState = EMPTY_FLEET_TABS_STATE;
  /** The full-height view of the hosted session is open. */
  hostedFull = false;
  steer: { readonly id: string; draft: string } | null = null;
  status: AgentsText | null = null;
  readonly stopTracker = new FleetStopTracker();
  private readonly unsubs: Array<() => void> = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: AgentsModalDeps) {
    this.unsubs.push(deps.readModel.subscribe(() => { this.onFleetChange(); deps.requestRender(); }));
    this.unsubs.push(deps.readModel.subscribeConsumed((event) => {
      for (const tab of this.tabs.tabs) {
        const badge = tab.steerBadge;
        if (badge && badge.messageId === event.messageId && (badge.status === 'queued' || badge.status === 'dropped')) {
          tab.steerBadge = { messageId: badge.messageId, status: 'consumed', queuedAt: badge.queuedAt, resolvedAt: Date.now() };
        }
      }
      deps.requestRender();
    }));
    if (deps.hosted) this.unsubs.push(deps.hosted.subscribe(() => deps.requestRender()));
    const tickMs = deps.tickMs ?? 1_000;
    if (tickMs > 0) this.tickTimer = setInterval(() => { this.onFleetChange(); deps.requestRender(); }, tickMs);
  }

  onClose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const tab of this.tabs.tabs) tab.lineCache.clear();
  }

  private onFleetChange(): void {
    this.applyFollow();
    if (this.tabs.tabs.length > 0) reconcileSteerBadges(this.tabs.tabs, (id) => this.findNode(id), Date.now());
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  private snapshotRows(): readonly FleetTreeRow[] {
    return this.view === 'archived' ? this.deps.readModel.getArchivedSnapshot().rows : this.deps.readModel.getSnapshot().rows;
  }

  private findNode(id: string): ProcessNode | null {
    return this.deps.readModel.getSnapshot().rows.find((row) => row.node.id === id)?.node ?? null;
  }

  private hostedAttached(): boolean {
    return this.view === 'active' && Boolean(this.deps.hosted?.getState().record);
  }

  private matches(row: FleetTreeRow): boolean {
    const q = this.query.trim().toLowerCase();
    if (!q) return true;
    const node = row.node;
    return [node.label, node.task ?? '', node.kind, node.id, node.currentActivity?.text ?? '', node.headline?.text ?? '']
      .some((text) => text.toLowerCase().includes(q));
  }

  /** The list in display order, grouped: hosted, running (whole subtrees), finished. */
  private groups(): Array<{ readonly name: string; readonly entries: ListEntry[] }> {
    const rows = this.snapshotRows().filter((row) => this.matches(row));
    if (this.view === 'archived') return rows.length > 0 ? [{ name: 'Archived', entries: rows.map((row) => ({ kind: 'node', row })) }] : [];
    const groups: Array<{ name: string; entries: ListEntry[] }> = [];
    const hostedMatches = !this.query.trim() || 'hosted'.includes(this.query.trim().toLowerCase()) || (this.deps.hosted?.getState().record?.title ?? '').toLowerCase().includes(this.query.trim().toLowerCase());
    if (this.hostedAttached() && hostedMatches) groups.push({ name: 'Hosted', entries: [{ kind: 'hosted' }] });
    // A root and everything under it stays together, in the group of its liveliest node.
    const all = this.snapshotRows();
    const rootOf = new Map<string, string>();
    let currentRoot = '';
    for (const row of all) {
      if (row.depth === 0) currentRoot = row.node.id;
      rootOf.set(row.node.id, currentRoot);
    }
    const liveRoots = new Set<string>();
    for (const row of all) if (!isTerminalProcessState(row.node.state)) liveRoots.add(rootOf.get(row.node.id) ?? row.node.id);
    const running = rows.filter((row) => liveRoots.has(rootOf.get(row.node.id) ?? row.node.id));
    const finished = rows.filter((row) => !liveRoots.has(rootOf.get(row.node.id) ?? row.node.id));
    if (running.length > 0) groups.push({ name: 'Running', entries: running.map((row) => ({ kind: 'node', row })) });
    if (finished.length > 0) groups.push({ name: 'Finished', entries: finished.map((row) => ({ kind: 'node', row })) });
    return groups;
  }

  private entries(): ListEntry[] {
    return this.groups().flatMap((group) => group.entries);
  }

  private entryId(entry: ListEntry): string {
    return entry.kind === 'hosted' ? HOSTED_ID : entry.row.node.id;
  }

  private selectedEntry(): ListEntry | null {
    const entries = this.entries();
    if (entries.length === 0) return null;
    return entries.find((entry) => this.entryId(entry) === this.selectedId) ?? entries[0]!;
  }

  selectedNode(): ProcessNode | null {
    const entry = this.selectedEntry();
    return entry?.kind === 'node' ? entry.row.node : null;
  }

  private move(delta: number): void {
    const entries = this.entries();
    if (entries.length === 0) return;
    const current = entries.findIndex((entry) => this.entryId(entry) === this.selectedId);
    const next = Math.max(0, Math.min(entries.length - 1, (current < 0 ? 0 : current) + delta));
    this.selectedId = this.entryId(entries[next]!);
    this.follow = false;
  }

  private applyFollow(): void {
    if (!this.follow) return;
    let best: FleetTreeRow | null = null;
    for (const row of this.deps.readModel.getSnapshot().rows) {
      if (!isRunningProcessState(row.node.state)) continue;
      if (!best || (row.node.startedAt ?? 0) >= (best.node.startedAt ?? 0)) best = row;
    }
    if (best) this.selectedId = best.node.id;
  }

  /** Select a specific process (a deep link from a notification, the work plan, /agents --target). */
  reveal(target: ViewTarget): boolean {
    const rows = this.deps.readModel.getSnapshot().rows;
    // A tool target (the keybindings modal's Tools tab) names a tool, not a
    // process: select the first process whose current step is that tool.
    const row = target.kind === 'tool'
      ? rows.find((r) => r.node.currentActivity?.toolName === target.id)
      : rows.find((r) => r.node.id === target.id && (!target.kind || r.node.kind === target.kind));
    this.view = 'active';
    this.tabs = { tabs: this.tabs.tabs, activeTabIndex: 0 };
    this.hostedFull = false;
    this.query = '';
    if (!row) {
      this.status = target.kind === 'tool'
        ? { text: `Nothing is running ${target.id} right now.`, tone: 'muted' }
        : { text: `${target.id} is no longer running here.`, tone: 'warning' };
      return false;
    }
    this.selectedId = row.node.id;
    this.status = null;
    return true;
  }

  /** Open the hosted session's full view (after /hosted new or attach). */
  showHosted(): void {
    this.view = 'active';
    this.selectedId = HOSTED_ID;
    this.hostedFull = this.hostedAttached();
    this.tabs = { tabs: this.tabs.tabs, activeTabIndex: 0 };
  }

  private level(): 'list' | 'full' | 'picker' {
    if (this.deps.acts?.pickModeActive() || this.deps.spawn?.spawnModeActive()) return 'picker';
    if (this.hostedFull || this.tabs.activeTabIndex > 0) return 'full';
    return 'list';
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  private say(text: string, tone: AgentsText['tone'] = 'muted'): void {
    this.status = { text, tone };
  }

  private openFull(host: SurfaceModalHost): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    if (entry.kind === 'hosted') { this.hostedFull = true; return; }
    const node = entry.row.node;
    if (this.deps.acts?.handleTreeKey('enter', node)) return;
    // An agent or a background process opens full screen, outside the modal.
    const target = node.kind === 'agent' ? { kind: 'agent' as const, id: node.id }
      : node.kind === 'background-process' ? { kind: 'process' as const, id: node.id } : null;
    if (target && this.deps.openSessionView?.(target)) {
      host.close(this, 'done');
      return;
    }
    if (!isAttachableFleetKind(node.kind)) {
      this.say(`${node.kind} has no transcript to open; its details are on the right.`, 'faint');
      return;
    }
    this.tabs = attachFleetTab(this.tabs, node);
  }

  private beginSteer(): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    if (entry.kind === 'hosted') {
      if (!this.deps.steerHosted) { this.say('Steering the hosted session is not available here.', 'error'); return; }
      this.steer = { id: HOSTED_ID, draft: '' };
      return;
    }
    const node = entry.row.node;
    if (isObservedExternalNode(node)) { this.deps.acts?.handleTreeKey('s', node); return; }
    if (isTerminalProcessState(node.state)) { this.say(`${node.label} already finished: nothing to steer.`, 'faint'); return; }
    if (!node.capabilities.steerable || !isAttachableFleetKind(node.kind)) { this.say(`${node.kind} does not take steering.`, 'faint'); return; }
    this.steer = { id: node.id, draft: '' };
  }

  private submitSteer(): void {
    const steer = this.steer;
    if (!steer) return;
    const text = steer.draft.trim();
    if (!text) { this.steer = null; return; }
    if (steer.id === HOSTED_ID) {
      this.steer = null;
      this.deps.steerHosted?.(text);
      this.say('Sent to the hosted session.');
      return;
    }
    const result = this.deps.actions.steer(steer.id, text);
    if (!result.queued) {
      // The draft stays so nothing typed is lost.
      const siblings = liveSteerableLabels(this.deps.readModel.getSnapshot().rows.map((row) => row.node), steer.id);
      this.say(steerRefusalMessage(result.reason, siblings), 'error');
      return;
    }
    const node = this.findNode(steer.id);
    if (node) {
      const keep = this.tabs.activeTabIndex;
      this.tabs = attachFleetTab(this.tabs, node);
      if (this.level() !== 'full' || keep === 0) this.tabs = { tabs: this.tabs.tabs, activeTabIndex: keep };
      const tab = this.tabs.tabs.find((t) => t.nodeId === steer.id);
      if (tab) tab.steerBadge = { messageId: result.messageId, status: 'queued', queuedAt: Date.now() };
    }
    this.steer = null;
    this.say(`Steer queued for ${node?.label ?? steer.id}: it arrives at its next turn (⧗ until then).`);
  }

  /** x / ctrl+x: stop the node and its descendants, after asking. */
  private stopSelected(nodeId?: string): void {
    const node = nodeId ? this.findNode(nodeId) : this.selectedNode();
    if (!node || isTerminalProcessState(node.state)) { if (node) this.say(`${node.label} already finished.`, 'faint'); return; }
    if (!node.capabilities.killable) { this.say(`${node.kind} cannot be stopped from here.`, 'faint'); return; }
    const args = fleetKillConfirmArgs(node, this.snapshotRows(), {
      kill: (id) => this.deps.actions.kill(id, { cascade: true }),
      markStopping: (id) => this.stopTracker.mark(id),
    });
    if (!this.deps.confirm) { this.say('Stopping needs a confirm dialog, which is not available here.', 'error'); return; }
    void this.deps.confirm({
      title: `Stop ${node.label}?`,
      body: `This stops ${args.label} and everything it started. It cannot be resumed.\nPress ctrl+x again to stop it; Esc keeps it running.`,
      confirmLabel: 'Stop',
      tone: 'danger',
      confirmChord: { key: 'x', ctrl: true },
    }).then((ok) => {
      if (ok) { args.onConfirm(); this.say(`Stopping ${node.label}…`, 'warning'); }
      this.deps.requestRender();
    });
  }

  private interruptSelected(): void {
    const node = this.selectedNode();
    if (!node || isTerminalProcessState(node.state)) return;
    if (!node.capabilities.interruptible) { this.say(`${node.kind} does not support interrupt.`, 'faint'); return; }
    this.deps.actions.interrupt(node.id);
    this.stopTracker.mark(node.id);
    this.say(`Interrupting ${node.label}…`, 'warning');
  }

  private jumpToBlocked(): void {
    const blocked = this.deps.readModel.getSnapshot().blockedNodeIds;
    if (blocked.length === 0) { this.say('Nothing is waiting on you right now.', 'faint'); return; }
    const at = this.selectedId ? blocked.indexOf(this.selectedId) : -1;
    this.view = 'active';
    this.query = '';
    this.tabs = { tabs: this.tabs.tabs, activeTabIndex: 0 };
    this.hostedFull = false;
    this.selectedId = blocked[(at + 1) % blocked.length]!;
    this.status = null;
  }

  private archiveSelected(all: boolean): void {
    if (all) {
      if (this.view !== 'active') return;
      const count = this.deps.readModel.archiveFinished();
      this.say(count > 0 ? `Archived ${count} finished process${count === 1 ? '' : 'es'}.` : 'Nothing has fully finished to archive.', 'faint');
      return;
    }
    const node = this.selectedNode();
    if (!node) return;
    if (this.view === 'archived') {
      const restored = this.deps.readModel.unarchive(node.id);
      this.say(restored > 0 ? `Restored ${node.label}.` : 'Nothing restored for this one.', 'faint');
      return;
    }
    if (!isTerminalProcessState(node.state)) { this.say('Only finished processes can be archived.', 'faint'); return; }
    const result = this.deps.readModel.archive(node.id);
    this.say(result.archived ? `Archived ${node.label}.` : result.reason ?? 'Could not archive this one.', 'faint');
  }

  // ── Keys ───────────────────────────────────────────────────────────────────

  escape(): boolean {
    if (this.steer) { this.steer = null; return true; }
    if (this.deps.acts?.observedSteerActive()) { this.deps.acts.handleObservedSteerInput('escape'); return true; }
    if (this.deps.acts?.pickModeActive()) { this.deps.acts.handlePickInput('escape'); return true; }
    if (this.deps.spawn?.spawnModeActive()) { this.deps.spawn.handleSpawnInput('escape'); return true; }
    if (this.filtering) { this.filtering = false; return true; }
    if (this.hostedFull) { this.hostedFull = false; return true; }
    if (this.tabs.activeTabIndex > 0) { this.tabs = { tabs: this.tabs.tabs, activeTabIndex: 0 }; return true; }
    if (this.query) { this.query = ''; return true; }
    return false;
  }

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    if (this.steer) { this.handleSteerToken(token); return; }
    // F2 and ctrl+o open this modal; pressed again here, they close it.
    if (token.type === 'key' && ((token.logicalName === 'f2' && !token.ctrl) || (token.ctrl && token.logicalName === 'o'))) {
      host.close(this, 'done');
      return;
    }
    const key = keyName(token);
    if (this.deps.acts?.observedSteerActive()) {
      if (token.type === 'text') for (const ch of token.value) this.deps.acts.handleObservedSteerInput(ch);
      else if (key) this.deps.acts.handleObservedSteerInput(key);
      return;
    }
    if (this.deps.acts?.pickModeActive()) { if (key) this.deps.acts.handlePickInput(key); return; }
    if (this.deps.spawn?.spawnModeActive()) { if (key) this.deps.spawn.handleSpawnInput(key); return; }
    if (this.filtering) { this.handleFilterToken(token); return; }
    if (this.level() === 'full') { this.handleFullToken(token); return; }
    if (token.type === 'key') {
      const name = token.logicalName ?? '';
      if (token.ctrl && name === 'x') { this.stopSelected(); return; }
      if (name === 'up') this.move(-1);
      else if (name === 'down') this.move(1);
      else if (name === 'pageup') this.move(-10);
      else if (name === 'pagedown') this.move(10);
      else if (name === 'enter') this.openFull(host);
      else if (isTextBackspace(name) && this.query) this.query = this.query.slice(0, -1);
      return;
    }
    if (token.type !== 'text' || token.value.length !== 1) return;
    this.status = null;
    const node = this.selectedNode();
    switch (token.value) {
      case '/': this.filtering = true; break;
      case 'j': this.move(1); break;
      case 'k': this.move(-1); break;
      case 's': this.beginSteer(); break;
      case 'x': case 'K': this.stopSelected(); break;
      case 'i': this.interruptSelected(); break;
      case 'p':
        if (node) toggleFleetPause(node, { interrupt: (id) => this.deps.actions.interrupt(id), resume: (id) => this.deps.actions.resume(id), setError: (m) => this.say(m, 'faint'), markDirty: () => {}, tracker: this.stopTracker });
        break;
      case 'n':
        if (this.deps.spawn) void this.deps.spawn.begin().then(() => this.deps.requestRender());
        else this.say('Hosting a third-party agent needs the daemon, which is not connected.', 'faint');
        break;
      case 'D':
        if (node && !this.deps.acts?.handleTreeKey('D', node)) this.say('This row does not own a worktree.', 'faint');
        break;
      case 'b': this.jumpToBlocked(); break;
      case 'f': this.follow = !this.follow; this.applyFollow(); this.say(this.follow ? 'Following the newest running agent.' : 'Stopped following.', 'faint'); break;
      case 'v': this.view = this.view === 'active' ? 'archived' : 'active'; this.selectedId = null; break;
      case 'a': this.archiveSelected(false); break;
      case 'A': this.archiveSelected(true); break;
      case ']':
        if (this.tabs.tabs.length > 0) this.tabs = { tabs: this.tabs.tabs, activeTabIndex: 1 };
        break;
      case '[':
        if (this.tabs.tabs.length > 0) this.tabs = { tabs: this.tabs.tabs, activeTabIndex: this.tabs.tabs.length };
        break;
      default: break;
    }
  }

  private handleFilterToken(token: InputToken): void {
    if (token.type === 'text') {
      this.query += [...token.value].filter((ch) => ch >= ' ').join('');
      this.selectedId = null;
      return;
    }
    if (token.type !== 'key') return;
    const name = token.logicalName ?? '';
    if (isTextBackspace(name)) { this.query = this.query.slice(0, -1); return; }
    if (name === 'enter') { this.filtering = false; return; }
    if (name === 'up' || name === 'down') { this.filtering = false; this.move(name === 'up' ? -1 : 1); }
  }

  private handleFullToken(token: InputToken): void {
    if (token.type === 'key') {
      const name = token.logicalName ?? '';
      if (token.ctrl && name === 'x') {
        const tab = activeFleetTab(this.tabs);
        if (tab) this.stopSelected(tab.nodeId);
        else this.say('The hosted session ends with /hosted kill; detaching keeps or ends it by its policy.', 'faint');
      }
      return;
    }
    if (token.type !== 'text' || token.value.length !== 1) return;
    if (token.value === 's') {
      const tab = activeFleetTab(this.tabs);
      if (tab) this.selectedId = tab.nodeId;
      this.beginSteer();
    } else if ((token.value === ']' || token.value === '[') && !this.hostedFull) {
      const next = stepFleetTab(this.tabs, token.value === ']' ? 1 : -1);
      if (next.activeTabIndex > 0) this.tabs = next;
    }
  }

  private handleSteerToken(token: InputToken): void {
    const steer = this.steer!;
    if (token.type === 'text') {
      steer.draft += token.value.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
      return;
    }
    if (token.type !== 'key') return;
    const name = token.logicalName ?? '';
    if (name === 'enter') this.submitSteer();
    else if (isTextBackspace(name)) steer.draft = steer.draft.slice(0, -1);
  }

  // ── View ───────────────────────────────────────────────────────────────────

  private badgeFor(nodeId: string): FleetTab['steerBadge'] {
    return this.tabs.tabs.find((tab) => tab.nodeId === nodeId)?.steerBadge ?? null;
  }

  private nodeRow(row: FleetTreeRow, selected: boolean): KitRow {
    const t = activeTokens();
    const node = row.node;
    const stopping = this.stopTracker.isStopping(node.id);
    const blocked = !stopping && isBlockedOnUserNode(node);
    const disp = fleetStateDisplay(node.state, stopping, blocked);
    const running = isRunningProcessState(node.state) || node.state === 'awaiting-approval';
    const mark = stopping || blocked ? disp.glyph : running ? '◐' : node.state === 'done' ? '✓' : node.state === 'failed' || node.state === 'killed' ? '✕' : '○';
    const markFg = stopping || blocked ? t.warning : running ? t.brand : node.state === 'done' ? t.success : node.state === 'failed' || node.state === 'killed' ? t.error : t.textFaint;
    const badge = this.badgeFor(node.id);
    const attention = fleetNodeAttention(node);
    const stall = fleetStallMarker(node);
    const activity = stopping ? 'stopping…'
      : blocked ? fleetAttentionText(attention ?? { reason: 'approval' })
        : [node.currentActivity?.toolName ? `${node.currentActivity.toolName}: ${node.currentActivity.text}` : node.headline?.text ?? node.currentActivity?.text ?? node.task ?? '', stall ?? ''].filter(Boolean).join(' · ');
    const attempt = node.attemptGroup ? ` attempt ${node.attemptGroup.index + 1}/${node.attemptGroup.total}${node.attemptGroup.held ? ' held' : ''}` : '';
    const kindTag = node.kind === 'agent' ? '' : node.kind === 'acp-agent' ? 'hosted' : node.kind.replace(/-/g, ' ');
    const desc = [kindTag, `${activity}${attempt}`.trim(), badge ? steerBadgeGlyph(badge.status) : ''].filter(Boolean).join(' · ');
    const cost = hasFleetCost(node.costUsd, node.costState) ? formatFleetCost(node.costUsd, node.costState) : '';
    const prefix = row.depth > 0 ? `${'│ '.repeat(row.depth - 1)}└ ` : '';
    return { label: `${prefix}${node.label}`, desc: desc || undefined, right: [formatElapsed(node.elapsedMs), cost].filter(Boolean).join(' · '), mark, markFg, selected };
  }

  private listRows(): KitRow[] {
    const t = activeTokens();
    const selected = this.selectedEntry();
    const rows: KitRow[] = [];
    for (const group of this.groups()) {
      rows.push({ header: group.name, headerRight: group.name === 'Hosted' ? 'on the daemon' : undefined });
      for (const entry of group.entries) {
        const isSelected = selected !== null && this.entryId(entry) === this.entryId(selected);
        if (entry.kind === 'hosted') {
          const state = this.deps.hosted!.getState();
          const record = state.record!;
          rows.push({ label: record.title.trim() || record.id, desc: `${state.streaming ? 'live' : 'not streaming'} · ${record.status}`, right: `${record.turnCount} turns`, mark: '◈', markFg: t.brandEnd, selected: isSelected });
        } else {
          rows.push(this.nodeRow(entry.row, isSelected));
        }
      }
    }
    return rows;
  }

  private detail(): AgentsDetail | null {
    const entry = this.selectedEntry();
    if (!entry) return null;
    if (entry.kind === 'hosted') {
      const state = this.deps.hosted!.getState();
      return { title: state.record!.title.trim() || 'Hosted session', meta: 'a conversation running inside the daemon', blocks: [{ kind: 'text', lines: hostedHeaderTexts(state) }], tail: hostedRowTexts(state.rows.slice(-40)) };
    }
    const node = entry.row.node;
    const stopping = this.stopTracker.isStopping(node.id);
    const blocked = !stopping && isBlockedOnUserNode(node);
    this.deps.acts?.ensureGraphFor(node);
    const observedDraft = this.deps.acts?.observedSteerDraftFor(node.id) ?? null;
    const graph = this.deps.acts?.graphFor(node.id) ?? null;
    const meta = [node.kind === 'acp-agent' ? 'hosted over ACP' : node.kind, node.model, node.provider].filter(Boolean).join(' · ');
    const tail = node.kind === 'agent' || node.kind === 'acp-agent' ? transcriptTail(this.deps.actions.getConversationSnapshot(node.id), 30) : [];
    return { title: node.label, meta, blocks: [{ kind: 'lines', build: (width) => renderFleetDetailLines(node, width, stopping, blocked, undefined, observedDraft, graph) }], tail };
  }

  private fullBody(width: number, height: number): readonly Line[] {
    if (this.hostedFull) return [];
    const tab = activeFleetTab(this.tabs);
    if (!tab) return [];
    const live = this.findNode(tab.nodeId);
    if (tab.kind === 'wrfc-chain') {
      const members = this.deps.readModel.getSnapshot().rows.filter((row) => row.node.parentId === tab.nodeId);
      return renderFleetChainSummary(members, width, live === null || isTerminalProcessState(live.state));
    }
    const isTerminal = live ? isTerminalProcessState(live.state) : true;
    const snapshot = this.deps.actions.getConversationSnapshot(tab.nodeId);
    const result = renderFleetAgentTranscript(snapshot, isTerminal, tab.lineCache, width, height, this.deps.configManager ?? null);
    if (result.mode !== 'unavailable') return result.lines;
    if (!tab.ledgerLoadStarted) {
      tab.ledgerLoadStarted = true;
      readFile(this.deps.actions.resolveSessionLogPath(tab.nodeId), 'utf-8')
        .then((raw) => { tab.ledgerEntries = parseAgentLedger(raw); })
        .catch(() => { tab.ledgerEntries = []; })
        .finally(() => this.deps.requestRender());
    }
    return tab.ledgerEntries !== null ? renderFleetLedgerFallback(tab.ledgerEntries, width, height) : renderFleetTranscriptLoading(width);
  }

  private sub(): string {
    const snapshot = this.deps.readModel.getSnapshot();
    const failed = snapshot.rows.filter((row) => row.node.state === 'failed').length;
    const blocked = snapshot.blockedNodeIds.length;
    const parts = [`${snapshot.runningCount} running`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (blocked > 0) parts.push(`${blocked} waiting on you`);
    const you = this.deps.sessionCost?.();
    if (you !== undefined) parts.push(`you ${you === null ? 'unpriced' : formatUsd(you)}`);
    parts.push(`fleet ${snapshot.totalCost === null ? '$0.00' : formatUsd(snapshot.totalCost)}`);
    return parts.join(' · ');
  }

  private hints(level: 'list' | 'full' | 'picker'): KitHint[] {
    if (this.steer) return [['⏎', 'send'], ['esc', 'cancel']];
    if (this.deps.acts?.observedSteerActive()) return [['⏎', 'send to the session'], ['esc', 'cancel']];
    if (level === 'picker') return [['↑↓', 'choose'], ['⏎', this.deps.acts?.pickModeActive() ? 'pick (asks first)' : 'next'], ['esc', 'back']];
    if (this.filtering) return [['⏎', 'done'], ['esc', 'stop filtering']];
    if (level === 'full') {
      if (this.hostedFull) return [['s', 'say'], ['esc', 'back']];
      return [['s', 'steer'], ['ctrl+x', 'stop (asks first)'], ['[ ]', 'other agents'], ['esc', 'back']];
    }
    const node = this.selectedNode();
    const attention = node ? fleetNodeAttention(node) : null;
    const enter = attention?.reason === 'pick' ? 'pick a winner' : attention?.reason === 'conflict' ? 'resolve conflict' : 'open full screen';
    const hints: KitHint[] = [['⏎', enter], ['s', 'steer'], ['ctrl+x', 'stop'], ['n', 'new agent']];
    if (node && !isTerminalProcessState(node.state) && node.capabilities.interruptible) hints.push(['i', 'interrupt']);
    if (node && (node.state === 'paused' ? node.capabilities.resumable : node.capabilities.pausable && !isTerminalProcessState(node.state))) hints.push(['p', node.state === 'paused' ? 'resume' : 'pause']);
    const blocked = this.deps.readModel.getSnapshot().blockedNodeIds.length;
    if (blocked > 0) hints.push(['b', `waiting on you (${blocked})`]);
    hints.push(['v', this.view === 'archived' ? 'live' : 'archive'], ['a', this.view === 'archived' ? 'restore' : 'archive one'], ['f', this.follow ? 'following' : 'follow']);
    return hints;
  }

  private buildView(): AgentsModalView {
    const level = this.level();
    const tab = activeFleetTab(this.tabs);
    const input = this.steer
      ? { label: this.steer.id === HOSTED_ID ? 'say: ' : `steer ${this.findNode(this.steer.id)?.label ?? ''}: `, draft: this.steer.draft }
      : this.deps.acts?.observedSteerActive() && this.selectedNode()
        ? { label: 'steer the foreign session: ', draft: this.deps.acts.observedSteerDraftFor(this.selectedNode()!.id) ?? '' }
        : null;
    const pick = this.deps.acts?.pickView() ?? null;
    const spawn = this.deps.spawn?.spawnView() ?? null;
    const shown = this.entries().length;
    const total = this.snapshotRows().length + (this.hostedAttached() ? 1 : 0);
    const hostedState = this.deps.hosted?.getState();
    return {
      level,
      crumbs: level === 'full' ? [this.hostedFull ? (hostedState?.record?.title || 'hosted session') : (this.findNode(tab!.nodeId)?.label ?? tab!.label)]
        : level === 'picker' ? [pick ? 'pick a winner' : spawn?.title ?? 'host an agent']
          : this.view === 'archived' ? ['archive'] : [],
      sub: level === 'list' ? this.sub() : '',
      hints: this.hints(level),
      status: this.status,
      input,
      filter: { query: this.query, active: this.filtering, count: this.query ? `${shown} of ${total}` : `${total} shown` },
      rows: level === 'list' ? this.listRows() : [],
      detail: level === 'list' ? this.detail() : null,
      full: level === 'full' ? {
        meta: this.hostedFull ? 'hosted on the daemon' : [tab!.kind, this.findNode(tab!.nodeId)?.state ?? 'finished'].join(' · '),
        header: this.hostedFull && hostedState ? hostedHeaderTexts(hostedState) : [],
        body: this.hostedFull && hostedState ? (width, height) => hostedBody(hostedState.rows, width, height) : (width, height) => this.fullBody(width, height),
      } : null,
      picker: level === 'picker'
        ? pick
          ? { intro: `Best of N: ${pick.title}. Choose the winner; Enter shows its diff and asks before merging.${pick.proposal ? ` The judge proposes ${pick.proposal} (advisory).` : ''}`, options: pick.candidates, side: pick.diff ? diffSide(pick.diff) : [{ text: 'This candidate has no diff to preview.', tone: 'faint' }] }
          : { intro: spawn?.creating ? 'Hosting the agent…' : spawn?.intro ?? '', options: spawn?.options ?? [], side: [] }
        : null,
      scrollOwner: this,
    };
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return renderAgentsModal(this.buildView(), screenWidth, screenHeight);
  }
}

/** The files a candidate diff touches, for the picker's side panel. */
function diffSide(diff: string): AgentsText[] {
  const files = diff.split('\n').filter((line) => line.startsWith('diff --git ')).map((line) => line.replace(/^diff --git a\/.+? b\//, ''));
  const added = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  return [
    { text: `${files.length} file${files.length === 1 ? '' : 's'} · +${added} −${removed}`, tone: 'text', bold: true },
    ...files.map((file) => ({ text: file, tone: 'muted' as const })),
  ];
}
