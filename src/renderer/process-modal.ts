import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import type { ProcessManager } from '@pellux/goodvibes-sdk/platform/tools';
import type { AgentManager, AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';
import type { WrfcController } from '@pellux/goodvibes-sdk/platform/agents';
import { getOverlaySurfaceMetrics, getStableOverlayContentRows } from './overlay-viewport.ts';
import { getVisibleWindow } from './surface-layout.ts';

// ─── ProcessEntry ─────────────────────────────────────────────────────────────

export interface ProcessEntry {
  /** Unique process identifier */
  id: string;
  /** Display label (agent task or exec command) */
  label: string;
  /** Tree prefix for child processes, e.g. "└─ " under a WRFC owner. */
  treePrefix?: string;
  /** Process type */
  type: 'agent' | 'exec';
  /** Current status string */
  status: string;
  /** Elapsed milliseconds since start */
  elapsedMs: number;
  /** Live streaming snippet for running agents (last ~60 chars of current turn output). */
  streamSnippet?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum characters from agent task / exec command stored in ProcessEntry.label. */
const MAX_LABEL_LENGTH = 80;
/** Border and margin width subtracted from terminal width to get modal content width. */
const MODAL_BORDER_WIDTH = 8;

const WRFC_ROLE_ORDER: Record<string, number> = {
  owner: 0,
  engineer: 1,
  reviewer: 2,
  fixer: 3,
  verifier: 4,
};

export interface ProcessModalDeps {
  readonly agentManager: Pick<AgentManager, 'list' | 'getStatus' | 'cancel'>;
  readonly processManager: Pick<ProcessManager, 'list' | 'getStatus' | 'stop'>;
  readonly wrfcController: Pick<WrfcController, 'getChain'> & Partial<Pick<WrfcController, 'listChains'>>;
}

type WrfcChainLike = {
  readonly id: string;
  readonly state: string;
  readonly task: string;
  readonly ownerAgentId: string;
  readonly engineerAgentId?: string;
  readonly reviewerAgentId?: string;
  readonly fixerAgentId?: string;
  readonly allAgentIds?: readonly string[];
  readonly constraints?: readonly unknown[];
};

/** Build a display label for an agent based on its task and template. */
function buildAgentLabel(rec: AgentRecord, deps: ProcessModalDeps): string {
  const task = rec.task;

  // Look up the original task from the WRFC chain if available
  const originalTask = getChainTask(rec.wrfcId, deps);

  if (rec.wrfcRole === 'owner') {
    const desc = truncateFirst(originalTask ?? task, MAX_LABEL_LENGTH - 13);
    return `[WRFC owner] ${desc}`;
  }

  if (rec.wrfcRole === 'engineer') {
    const desc = truncateFirst(originalTask ?? task, MAX_LABEL_LENGTH - 11);
    return `[Engineer] ${desc}`;
  }

  if (rec.wrfcRole === 'verifier') {
    const desc = truncateFirst(originalTask ?? task, MAX_LABEL_LENGTH - 13);
    return `[Verifier] ${desc}`;
  }

  // WRFC Review agent
  if (task.startsWith('WRFC Review Request')) {
    const thresholdMatch = task.match(/threshold is (\d+(?:\.\d+)?)/);
    const threshold = thresholdMatch ? thresholdMatch[1] : '9.9';
    const desc = truncateFirst(originalTask ?? embeddedTaskDescription(task) ?? 'review in progress', 50);
    return `[Review] ${desc}  (target: ${threshold}/10)`;
  }

  // WRFC Fix agent
  if (task.startsWith('WRFC Fix Request')) {
    const scoreMatch = task.match(/Review score:\s*(\d+(?:\.\d+)?)\/(\d+)\s*\(threshold:\s*(\d+(?:\.\d+)?)/);
    const fromScore = scoreMatch ? scoreMatch[1] : '?';
    const toScore = scoreMatch ? scoreMatch[3] : '?';
    const attemptMatch = task.match(/Fix attempt:\s*(\d+)/);
    const attempt = attemptMatch ? attemptMatch[1] : '?';
    const desc = truncateFirst(originalTask ?? embeddedTaskDescription(task) ?? 'fix in progress', 45);
    // Show constraint count when the chain has constraints to target (SDK 0.23.0)
    const chain = rec.wrfcId ? safeGetChain(rec.wrfcId, deps) : null;
    const constraintCount = chain && (chain.constraints?.length ?? 0) > 0 ? chain.constraints?.length ?? 0 : 0;
    const constraintSuffix = constraintCount > 0 ? `  [${constraintCount}c]` : '';
    return `[Fix #${attempt}] ${desc}  (${fromScore} \u2192 ${toScore}/10)${constraintSuffix}`;
  }

  // Regular agent — show template and truncated first line
  const templateLabels: Record<string, string> = {
    engineer: 'Engineer', reviewer: 'Reviewer', tester: 'Tester',
    researcher: 'Researcher', general: 'Agent',
  };
  const tag = templateLabels[rec.template] ?? 'Agent';
  const maxDesc = MAX_LABEL_LENGTH - tag.length - 3;
  return `[${tag}] ${truncateFirst(task, maxDesc)}`;
}

function isActiveAgent(rec: AgentRecord): boolean {
  return rec.status !== 'completed' && rec.status !== 'failed' && rec.status !== 'cancelled';
}

function isActiveWrfcState(state: string): boolean {
  return state !== 'passed' && state !== 'failed';
}

function getStreamSnippet(rec: AgentRecord): string | undefined {
  if (!rec.streamingContent) return undefined;
  const raw = rec.streamingContent.replace(/\n/g, ' ').trim();
  return raw.length > 60 ? '...' + raw.slice(-57) : raw;
}

function compareAgents(a: AgentRecord, b: AgentRecord): number {
  const roleDelta = (WRFC_ROLE_ORDER[a.wrfcRole ?? ''] ?? 50) - (WRFC_ROLE_ORDER[b.wrfcRole ?? ''] ?? 50);
  if (roleDelta !== 0) return roleDelta;
  return a.startedAt - b.startedAt || a.id.localeCompare(b.id);
}

function buildAgentEntry(
  rec: AgentRecord,
  deps: ProcessModalDeps,
  now: number,
  treePrefix = '',
): ProcessEntry {
  return {
    id: rec.id,
    label: buildAgentLabel(rec, deps),
    treePrefix,
    type: 'agent',
    status: rec.status,
    elapsedMs: now - rec.startedAt,
    streamSnippet: getStreamSnippet(rec),
  };
}

function appendAgentSubtree(
  result: ProcessEntry[],
  rec: AgentRecord,
  childrenByParent: Map<string, AgentRecord[]>,
  deps: ProcessModalDeps,
  now: number,
  prefix: string,
  connector: string,
  visited: Set<string>,
): void {
  if (visited.has(rec.id)) return;
  visited.add(rec.id);
  result.push(buildAgentEntry(rec, deps, now, `${prefix}${connector}`));

  const children = (childrenByParent.get(rec.id) ?? []).slice().sort(compareAgents);
  const descendantPrefix = connector === '├─ ' ? '│  ' : connector === '└─ ' ? '   ' : '';
  children.forEach((child, index) => {
    const last = index === children.length - 1;
    appendAgentSubtree(
      result,
      child,
      childrenByParent,
      deps,
      now,
      `${prefix}${descendantPrefix}`,
      last ? '└─ ' : '├─ ',
      visited,
    );
  });
}

function appendAgentGroupEntries(
  result: ProcessEntry[],
  records: AgentRecord[],
  deps: ProcessModalDeps,
  now: number,
): void {
  const group = records.slice().sort(compareAgents);
  const byId = new Map(group.map((rec) => [rec.id, rec]));
  const childrenByParent = new Map<string, AgentRecord[]>();

  for (const rec of group) {
    if (!rec.parentAgentId || !byId.has(rec.parentAgentId)) continue;
    const children = childrenByParent.get(rec.parentAgentId) ?? [];
    children.push(rec);
    childrenByParent.set(rec.parentAgentId, children);
  }

  const chain = group[0]?.wrfcId ? safeGetChain(group[0].wrfcId, deps) : null;
  const owner = group.find((rec) => rec.id === chain?.ownerAgentId)
    ?? group.find((rec) => rec.wrfcRole === 'owner');
  const roots = owner
    ? [owner]
    : group.filter((rec) => !rec.parentAgentId || !byId.has(rec.parentAgentId));
  const visited = new Set<string>();

  roots.forEach((root, index) => {
    const connector = owner || roots.length === 1 ? '' : (index === roots.length - 1 ? '└─ ' : '├─ ');
    appendAgentSubtree(result, root, childrenByParent, deps, now, '', connector, visited);
  });

  const leftovers = group.filter((rec) => !visited.has(rec.id));
  leftovers.forEach((rec, index) => {
    appendAgentSubtree(
      result,
      rec,
      childrenByParent,
      deps,
      now,
      '',
      index === leftovers.length - 1 ? '└─ ' : '├─ ',
      visited,
    );
  });
}

function buildAgentEntries(
  agents: AgentRecord[],
  deps: ProcessModalDeps,
  now: number,
  getGroupOrder?: (key: string) => number | undefined,
  ensureGroupOrder?: (key: string) => number,
): ProcessEntry[] {
  const result: ProcessEntry[] = [];
  const displayAgents = prepareAgentRecordsForDisplay(agents, deps);
  const activeById = new Map(displayAgents.map((agent) => [agent.id, agent]));
  const groups = new Map<string, AgentRecord[]>();

  for (const agent of displayAgents) {
    const groupKey = getAgentGroupKey(agent, activeById);
    const group = groups.get(groupKey) ?? [];
    group.push(agent);
    groups.set(groupKey, group);
  }

  const sortedGroups = Array.from(groups.entries()).sort(([aKey, a], [bKey, b]) => {
    const aOrder = getGroupOrder?.(aKey);
    const bOrder = getGroupOrder?.(bKey);
    if (aOrder !== undefined || bOrder !== undefined) {
      if (aOrder === undefined) return 1;
      if (bOrder === undefined) return -1;
      return aOrder - bOrder;
    }
    const aStarted = Math.min(...a.map((rec) => rec.startedAt));
    const bStarted = Math.min(...b.map((rec) => rec.startedAt));
    return aStarted - bStarted || aKey.localeCompare(bKey);
  });
  for (const [key, group] of sortedGroups) {
    ensureGroupOrder?.(key);
    appendAgentGroupEntries(result, group, deps, now);
  }

  return result;
}

function prepareAgentRecordsForDisplay(agents: AgentRecord[], deps: ProcessModalDeps): AgentRecord[] {
  const chains = listWrfcChains(deps);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const normalizedById = new Map<string, AgentRecord>();

  for (const agent of agents) {
    if (!isActiveAgent(agent)) continue;
    normalizedById.set(agent.id, normalizeWrfcAgentRecord(agent, chains));
  }

  // A WRFC owner is the durable root of the chain. Keep it visible until the
  // chain itself is terminal, even if the underlying owner agent has already
  // emitted a completed phase event before reviewer/fixer/gate work finishes.
  for (const chain of chains) {
    if (!isActiveWrfcState(chain.state)) continue;
    const owner = agentById.get(chain.ownerAgentId);
    if (!owner || normalizedById.has(owner.id)) continue;
    const chainHasActiveMember = agents.some((agent) =>
      agent.id !== owner.id
      && isActiveAgent(agent)
      && isAgentInChain(agent, chain)
    );
    if (!chainHasActiveMember) continue;
    normalizedById.set(owner.id, normalizeWrfcAgentRecord({
      ...owner,
      status: 'running',
      completedAt: undefined,
      progress: owner.progress ?? `WRFC chain ${chain.state}`,
    }, chains));
  }

  const normalized = Array.from(normalizedById.values());
  return inferDuplicateWrfcOwnerRows(normalized);
}

function normalizeWrfcAgentRecord(agent: AgentRecord, chains: WrfcChainLike[]): AgentRecord {
  const chain = findChainForAgent(agent, chains);
  if (!chain) return agent;

  const role = inferWrfcRole(agent, chain);
  const parentAgentId = role && role !== 'owner'
    ? agent.parentAgentId ?? chain.ownerAgentId
    : agent.parentAgentId;

  return {
    ...agent,
    wrfcId: agent.wrfcId ?? chain.id,
    wrfcRole: agent.wrfcRole ?? role,
    parentAgentId,
  };
}

function inferDuplicateWrfcOwnerRows(agents: AgentRecord[]): AgentRecord[] {
  const byTask = new Map<string, AgentRecord[]>();
  for (const agent of agents) {
    if (agent.wrfcId || agent.wrfcRole || agent.parentAgentId) continue;
    if (agent.reviewMode !== 'wrfc') continue;
    const key = agent.task.trim();
    if (!key) continue;
    const group = byTask.get(key) ?? [];
    group.push(agent);
    byTask.set(key, group);
  }

  const inferredIds = new Set<string>();
  const inferred = new Map<string, AgentRecord>();
  for (const [task, group] of byTask) {
    if (group.length < 2) continue;
    const sorted = group.slice().sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    const owner = sorted[0]!;
    const syntheticWrfcId = `inferred:${owner.id}`;
    inferred.set(owner.id, {
      ...owner,
      wrfcId: syntheticWrfcId,
      wrfcRole: 'owner',
    });
    inferredIds.add(owner.id);
    for (const child of sorted.slice(1)) {
      inferred.set(child.id, {
        ...child,
        wrfcId: syntheticWrfcId,
        wrfcRole: child.template === 'reviewer' ? 'reviewer' : 'engineer',
        parentAgentId: owner.id,
      });
      inferredIds.add(child.id);
    }

    // Avoid accidentally grouping unrelated long-running WRFC roots that just
    // happen to share an empty or generic task after this exact duplicate group.
    byTask.delete(task);
  }

  if (inferredIds.size === 0) return agents;
  return agents.map((agent) => inferred.get(agent.id) ?? agent);
}

function listWrfcChains(deps: ProcessModalDeps): WrfcChainLike[] {
  const controller = deps.wrfcController as ProcessModalDeps['wrfcController'] & {
    listChains?: () => unknown;
  };
  if (typeof controller.listChains !== 'function') return [];
  try {
    const value = controller.listChains();
    return Array.isArray(value) ? value.filter(isWrfcChainLike) : [];
  } catch {
    return [];
  }
}

function isWrfcChainLike(value: unknown): value is WrfcChainLike {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.state === 'string'
    && typeof record.task === 'string'
    && typeof record.ownerAgentId === 'string';
}

function findChainForAgent(agent: AgentRecord, chains: WrfcChainLike[]): WrfcChainLike | null {
  if (agent.wrfcId) {
    const direct = chains.find((chain) => chain.id === agent.wrfcId);
    if (direct) return direct;
  }
  return chains.find((chain) => isAgentInChain(agent, chain)) ?? null;
}

function isAgentInChain(agent: AgentRecord, chain: WrfcChainLike): boolean {
  return chain.ownerAgentId === agent.id
    || chain.engineerAgentId === agent.id
    || chain.reviewerAgentId === agent.id
    || chain.fixerAgentId === agent.id
    || (chain.allAgentIds?.includes(agent.id) ?? false)
    || agent.wrfcId === chain.id;
}

function inferWrfcRole(agent: AgentRecord, chain: WrfcChainLike): AgentRecord['wrfcRole'] {
  if (agent.wrfcRole) return agent.wrfcRole;
  if (chain.ownerAgentId === agent.id) return 'owner';
  if (chain.engineerAgentId === agent.id) return 'engineer';
  if (chain.reviewerAgentId === agent.id) return 'reviewer';
  if (chain.fixerAgentId === agent.id) return 'fixer';
  if (agent.template === 'reviewer') return 'reviewer';
  return 'engineer';
}

function getAgentGroupKey(agent: AgentRecord, activeById: Map<string, AgentRecord>): string {
  if (agent.wrfcId) return `wrfc:${agent.wrfcId}`;

  const seen = new Set<string>();
  let root = agent;
  while (root.parentAgentId && activeById.has(root.parentAgentId) && !seen.has(root.parentAgentId)) {
    seen.add(root.id);
    root = activeById.get(root.parentAgentId)!;
  }

  // If the active root is an orphaned child, keep it anchored to its missing parent id
  // so it does not jump to a new group when the parent exits before its children.
  return `root:${root.parentAgentId ?? root.id}`;
}

function safeGetChain(wrfcId: string, deps: Pick<ProcessModalDeps, 'wrfcController'>): WrfcChainLike | null {
  try {
    const chain = deps.wrfcController.getChain(wrfcId);
    return isWrfcChainLike(chain) ? chain : null;
  } catch {
    return null;
  }
}

/** Get the original task description from a WRFC chain. */
function getChainTask(wrfcId: string | undefined, deps: Pick<ProcessModalDeps, 'wrfcController'>): string | null {
  if (!wrfcId) return null;
  return safeGetChain(wrfcId, deps)?.task ?? null;
}

/**
 * Fallback for when the WRFC chain lookup comes back null (chain already
 * completed/evicted, or wrfcId not populated on the record) — the record's
 * own `rec.task` is seeded as `'WRFC Review Request\n<original task
 * description>'` / `'WRFC Fix Request\n...'`, so the description is sitting
 * right there even without the chain. Returns null (not the generic
 * placeholder) when there's no second line to extract.
 */
function embeddedTaskDescription(task: string): string | null {
  const firstNewline = task.indexOf('\n');
  if (firstNewline === -1) return null;
  const desc = task.slice(firstNewline + 1).trim();
  return desc.length > 0 ? desc : null;
}

/** Truncate to first line, capped at max chars. */
function truncateFirst(text: string, max: number): string {
  const line = text.split('\n')[0].trim();
  return line.length > max ? line.slice(0, Math.max(0, max - 3)) + '...' : line;
}

/** Truncate a command string to first line, capped at MAX_LABEL_LENGTH. */
function truncateCmd(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length > MAX_LABEL_LENGTH) return firstLine.slice(0, MAX_LABEL_LENGTH - 3) + '...';
  return firstLine;
}

// ─── ProcessModalState ────────────────────────────────────────────────────────

/**
 * ProcessModal — manages the state for the background-process list modal.
 *
 * Holds the list of ProcessEntry items, selected index, and active flag.
 * Rendering is done by renderProcessModal().
 */
export class ProcessModal {
  public active = false;
  public selectedIndex = 0;
  public entries: ProcessEntry[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private onRefresh: (() => void) | null = null;
  private groupOrder = new Map<string, number>();
  private nextGroupOrder = 0;

  constructor(private readonly deps: ProcessModalDeps) {}

  /** Set a callback to trigger re-render on timer tick. */
  setOnRefresh(fn: () => void): void {
    this.onRefresh = fn;
  }

  open(): void {
    this.refresh();
    this.active = true;
    this.selectedIndex = 0;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      this.refresh();
      this.onRefresh?.();
    }, 1000);
  }

  close(): void {
    this.active = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Rebuild entries from the currently owned runtime services. */
  refresh(): void {
    const manager = this.deps.agentManager;
    if (typeof manager?.list !== 'function') return; // Guard against test mock pollution
    const now = Date.now();
    const result: ProcessEntry[] = [];

    // Agents — only show active (pending/running), grouped by stable parent/child hierarchy.
    result.push(...buildAgentEntries(
      manager.list(),
      this.deps,
      now,
      (key) => this.groupOrder.get(key),
      (key) => this.ensureGroupOrder(key),
    ));

    // Background exec processes — only show running
    const pm = this.deps.processManager;
    for (const p of pm.list()) {
      if (p.status.startsWith('done')) continue;
      const startTime = pm.getStatus(p.id)?.startTime ?? now;
      result.push({
        id: p.id,
        label: truncateCmd(p.cmd),
        type: 'exec',
        status: p.status,
        elapsedMs: now - startTime,
      });
    }

    this.entries = result;

    // Keep selection in-bounds
    if (this.selectedIndex >= this.entries.length) {
      this.selectedIndex = Math.max(0, this.entries.length - 1);
    }
  }

  private ensureGroupOrder(key: string): number {
    const existing = this.groupOrder.get(key);
    if (existing !== undefined) return existing;
    const next = this.nextGroupOrder++;
    this.groupOrder.set(key, next);
    return next;
  }

  moveUp(): void {
    if (this.entries.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.entries.length) % this.entries.length;
  }

  moveDown(): void {
    if (this.entries.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.entries.length;
  }

  getSelected(): ProcessEntry | undefined {
    return this.entries[this.selectedIndex];
  }

  /**
   * Kill the selected process.
   * Returns true if a process was killed, false otherwise.
   */
  killSelected(): boolean {
    const entry = this.getSelected();
    if (!entry) return false;

    if (entry.type === 'exec') {
      return this.deps.processManager.stop(entry.id);
    } else {
      return this.deps.agentManager.cancel(entry.id);
    }
  }
}

// ─── renderProcessModal ───────────────────────────────────────────────────────

/**
 * Render the process list modal as Line[] for overlay in the viewport.
 *
 * @param modal  ProcessModal state
 * @param width  Terminal width
 */
export function renderProcessModal(modal: ProcessModal, width: number, viewportHeight = 24): Line[] {
  modal.refresh();

  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    margin: 2,
    maxWidth: Math.max(24, width - 4),
    chromeRows: 4,
    minContentRows: 5,
    maxContentRows: 9,
  });
  const boxMargin = metrics.margin;
  const boxW = metrics.boxWidth;
  const maxVisibleRows = metrics.contentRows;
  const targetContentRows = getStableOverlayContentRows(metrics.contentRows, 7);

  if (modal.entries.length === 0) {
    return ModalFactory.createModal({
      title: 'Background Processes',
      width: boxW,
      margin: boxMargin,
      targetContentRows,
      sections: [
        { type: 'text', content: 'No background processes running.' },
      ],
      hints: ['[Esc] Close'],
    }, width);
  }

  const maxLabelW = Math.max(10, boxW - MODAL_BORDER_WIDTH);
  const window = getVisibleWindow(modal.entries.length, modal.selectedIndex, maxVisibleRows);
  const visibleEntries = modal.entries.slice(window.start, window.end);

  const items = visibleEntries.map((e, i) => {
    const absoluteIndex = window.start + i;
    const statusIcon = {
      running: '●',
      pending: '•',
      completed: '✓',
      failed: '✗',
      cancelled: '–',
    }[e.status] ?? '•';
    const typeTag = e.type === 'agent' ? '[agent]' : '[exec]';
    const dur = formatElapsed(e.elapsedMs);
    const statusStr = e.streamSnippet ? `streaming  ${dur}` : `${e.status}  ${dur}`;
    const suffix = `  ${statusStr}`;
    const treePrefix = e.treePrefix ?? '';
    const maxDescW = maxLabelW - typeTag.length - treePrefix.length - suffix.length - 4; // icon + spaces
    const desc = e.label.length > maxDescW ? e.label.slice(0, Math.max(0, maxDescW - 3)) + '...' : e.label;
    const label = `${statusIcon} ${typeTag} ${treePrefix}${desc}${suffix}`;
    return {
      label,
      selected: absoluteIndex === modal.selectedIndex,
    };
  });
  const sections: import('./modal-factory.ts').ModalSection[] = [
    { type: 'list', items },
  ];
  if (modal.entries.length > maxVisibleRows) {
    sections.push({ type: 'separator' });
  }

  return ModalFactory.createModal({
    title: 'Background Processes',
    width: boxW,
    margin: boxMargin,
    targetContentRows,
    sections,
    helpers: modal.entries.length > maxVisibleRows
      ? [{ content: `[${window.start + 1}-${window.end} of ${modal.entries.length}]` }]
      : undefined,
    hints: ['[Up/Down] Navigate', '[Enter] Peek output', '[k] Kill', '[Esc] Close'],
  }, width);
}
