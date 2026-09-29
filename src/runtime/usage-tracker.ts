/**
 * usage-tracker.ts, the session's token and cost history.
 *
 * Built once at startup and subscribed to the turn and agent event feeds for
 * the life of the session, so per-turn history, the cost trend and the
 * per-agent cost ledger accumulate whether or not the Usage modal has ever
 * been opened. The Usage modal (input/usage-modal.ts) only reads it.
 *
 * Budget: the alert threshold lives in the behavior.budgetAlertUsd setting,
 * the same key the background budget-breach notifier reads, so the modal, the
 * `/cost budget <usd>` command and the notifier never disagree.
 */

import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';
import {
  BUDGET_ALERT_USD_CONFIG_KEY,
  calcSessionCost,
  computeBudgetBreach,
  describePricingSource,
  isModelPriced,
  readBudgetAlertUsd,
  writeManualModelPrice,
  type BudgetAlertConfigAccess,
} from '@pellux/goodvibes-sdk/platform/providers';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { AgentEvent, TurnEvent } from '@pellux/goodvibes-sdk/events';
import { evaluateSessionMaintenance } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { SessionMemoryQuery, UiEventFeed } from '@pellux/goodvibes-sdk/platform/runtime/ui';
import type { UiReadModel, UiSessionSnapshot } from './ui-read-models.ts';

/** Tokens one completed turn added. */
export interface UsageTurn {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Unix ms the turn completed. */
  readonly ts: number;
}

export interface UsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type UsageAgentStatus = 'running' | 'done' | 'failed';

/** One spawned agent's tokens and cost. */
export interface UsageAgentEntry {
  readonly agentId: string;
  readonly task: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly status: UsageAgentStatus;
}

/** What the session cost, and where the price came from. */
export interface UsageCost {
  readonly usd: number;
  /** False when the model has no known price (the figure is then not a real zero). */
  readonly priced: boolean;
  /** "your price", "catalog price, as of …", or null. */
  readonly source: string | null;
}

export interface UsageTrackerDeps {
  readonly turnEvents: UiEventFeed<TurnEvent>;
  readonly agentEvents: UiEventFeed<AgentEvent>;
  /** Cumulative main-session usage (the orchestrator's counters). */
  readonly getUsage: () => UsageTotals & { readonly model?: string };
  /** Tokens in the context window right now. */
  readonly getContextTokens: () => number;
  /** The current model's context window (0 when unknown). */
  readonly getContextWindow: () => number;
  /** The current model id (for pricing). */
  readonly getModelId: () => string;
  /** An agent's live record, for its usage and model. */
  readonly getAgentStatus?: (agentId: string) => AgentRecord | null;
  /** The fleet's priced total (every agent, chain and workflow), or null when nothing is priced. */
  readonly getFleetCost?: () => number | null;
  readonly configManager: Pick<ConfigManager, 'get' | 'set'>;
  readonly sessionMemoryStore?: SessionMemoryQuery;
  readonly sessionReadModel?: UiReadModel<UiSessionSnapshot>;
  readonly requestRender?: () => void;
}

/** Turns kept in history. */
const MAX_TURNS = 100;
/** Cost-trend points kept (one per model response). */
const MAX_COST_POINTS = 32;
/** Agents kept in the cost ledger (oldest finished ones go first). */
const MAX_AGENTS = 200;

interface MutableAgent {
  agentId: string;
  task: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  status: UsageAgentStatus;
}

export class UsageTracker {
  private readonly turnsList: UsageTurn[] = [];
  private readonly costPoints: number[] = [];
  private readonly agentMap = new Map<string, MutableAgent>();
  private prevCumulative: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private lastSessionCost = 0;
  private readonly unsubs: Array<() => void> = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: UsageTrackerDeps) {
    this.unsubs.push(deps.turnEvents.on('TURN_COMPLETED', () => this.recordTurn()));
    this.unsubs.push(deps.turnEvents.on('LLM_RESPONSE_RECEIVED', () => this.recordCostPoint()));
    this.unsubs.push(deps.turnEvents.on('TURN_SUBMITTED', () => this.emit()));
    this.unsubs.push(deps.agentEvents.on('AGENT_SPAWNING', (payload) => {
      this.agentMap.set(payload.agentId, {
        agentId: payload.agentId,
        task: payload.task,
        model: 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        status: 'running',
      });
      this.trimAgents();
      this.emit();
    }));
    this.unsubs.push(deps.agentEvents.on('AGENT_COMPLETED', (payload) => {
      const entry = this.agentMap.get(payload.agentId);
      if (!entry) return;
      entry.status = 'done';
      this.readAgentUsage(entry);
      this.emit();
    }));
    this.unsubs.push(deps.agentEvents.on('AGENT_FAILED', (payload) => {
      const entry = this.agentMap.get(payload.agentId);
      if (!entry) return;
      entry.status = 'failed';
      this.readAgentUsage(entry);
      this.emit();
    }));
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.listeners.clear();
  }

  /** Called on every change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
    this.deps.requestRender?.();
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  /** Snapshot a completed turn (the delta since the previous one). */
  recordTurn(now: number = Date.now()): void {
    const cu = this.totals();
    this.turnsList.push({
      input: Math.max(0, cu.input - this.prevCumulative.input),
      output: Math.max(0, cu.output - this.prevCumulative.output),
      cacheRead: Math.max(0, cu.cacheRead - this.prevCumulative.cacheRead),
      cacheWrite: Math.max(0, cu.cacheWrite - this.prevCumulative.cacheWrite),
      ts: now,
    });
    this.prevCumulative = cu;
    if (this.turnsList.length > MAX_TURNS) this.turnsList.shift();
    this.recordCostPoint();
  }

  private recordCostPoint(): void {
    const total = this.sessionCost().usd;
    this.costPoints.push(Math.max(0, total - this.lastSessionCost));
    this.lastSessionCost = total;
    if (this.costPoints.length > MAX_COST_POINTS) this.costPoints.shift();
    this.emit();
  }

  private readAgentUsage(entry: MutableAgent): boolean {
    const rec = this.deps.getAgentStatus?.(entry.agentId);
    if (!rec?.usage) return false;
    const input = rec.usage.inputTokens + (rec.usage.cacheReadTokens ?? 0) + (rec.usage.cacheWriteTokens ?? 0);
    const model = rec.model && rec.model !== 'unknown' ? rec.model : entry.model;
    const cost = calcSessionCost(rec.usage.inputTokens, rec.usage.outputTokens, rec.usage.cacheReadTokens ?? 0, rec.usage.cacheWriteTokens ?? 0, model);
    const changed = input !== entry.inputTokens || rec.usage.outputTokens !== entry.outputTokens || cost !== entry.cost || model !== entry.model;
    entry.inputTokens = input;
    entry.outputTokens = rec.usage.outputTokens;
    entry.cost = cost;
    entry.model = model;
    return changed;
  }

  /**
   * Read live usage for agents still running (their token and cost columns
   * fill in as they stream instead of staying empty until they finish).
   * Called while the Usage modal is open. Returns whether anything changed.
   */
  pollRunningAgents(): boolean {
    let changed = false;
    for (const entry of this.agentMap.values()) {
      if (entry.status === 'running' && this.readAgentUsage(entry)) changed = true;
    }
    return changed;
  }

  private trimAgents(): void {
    if (this.agentMap.size <= MAX_AGENTS) return;
    for (const [id, entry] of this.agentMap) {
      if (this.agentMap.size <= MAX_AGENTS) break;
      if (entry.status !== 'running') this.agentMap.delete(id);
    }
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  totals(): UsageTotals {
    const u = this.deps.getUsage();
    return { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
  }

  /** Completed turns, oldest first. */
  turns(): readonly UsageTurn[] {
    return this.turnsList;
  }

  /** Cost added per model response, oldest first. */
  costTrend(): readonly number[] {
    return this.costPoints;
  }

  /** Agents spawned this session, in spawn order. */
  agents(): readonly UsageAgentEntry[] {
    return [...this.agentMap.values()];
  }

  modelId(): string {
    return this.deps.getUsage().model || this.deps.getModelId();
  }

  contextTokens(): number {
    return Math.max(0, this.deps.getContextTokens());
  }

  contextWindow(): number {
    return Math.max(0, this.deps.getContextWindow());
  }

  /**
   * Where auto-compaction starts, as a fraction of the window (0 when it is
   * off). The same figure the maintenance check and the compactor use.
   */
  compactThreshold(): number {
    return this.maintenance().thresholdPct / 100;
  }

  maintenance(): ReturnType<typeof evaluateSessionMaintenance> {
    const session = this.deps.sessionReadModel?.getSnapshot();
    return evaluateSessionMaintenance({
      configManager: this.deps.configManager,
      currentTokens: this.contextTokens(),
      contextWindow: this.contextWindow(),
      messageCount: session?.totalTurns,
      sessionMemoryCount: this.deps.sessionMemoryStore?.list().length ?? 0,
      session: session?.session,
    });
  }

  sessionCost(): UsageCost {
    const u = this.totals();
    const model = this.modelId();
    const priced = isModelPriced(model);
    return {
      usd: calcSessionCost(u.input, u.output, u.cacheRead, u.cacheWrite, model),
      priced,
      source: priced ? describePricingSource(model) : null,
    };
  }

  /** Cost of everything the fleet ran (agents, chains, workflows), or null when nothing is priced. */
  fleetCost(): number | null {
    const fromFleet = this.deps.getFleetCost?.() ?? null;
    if (fromFleet !== null) return fromFleet;
    const ledger = [...this.agentMap.values()].reduce((sum, a) => sum + a.cost, 0);
    return ledger > 0 ? ledger : null;
  }

  /** True when some spend has no known price (so totals undercount it). */
  hasUnpricedSpend(): boolean {
    const u = this.totals();
    if (!isModelPriced(this.modelId()) && (u.input + u.output + u.cacheRead + u.cacheWrite) > 0) return true;
    return [...this.agentMap.values()].some((a) => a.inputTokens > 0 && !isModelPriced(a.model));
  }

  // ── Budget and price ───────────────────────────────────────────────────────

  private configAccess(): BudgetAlertConfigAccess {
    const config = this.deps.configManager;
    return {
      get: (key) => config.get(key as Parameters<typeof config.get>[0]),
      set: (key, value) => config.set(key as Parameters<typeof config.set>[0], value as never),
    };
  }

  /** The budget alert threshold in USD (0 = none). */
  budget(): number {
    return readBudgetAlertUsd(this.configAccess().get);
  }

  /** Set the budget alert threshold (0 turns it off). Returns false for a bad amount. */
  setBudget(usd: number): boolean {
    if (!Number.isFinite(usd) || usd < 0) return false;
    this.configAccess().set(BUDGET_ALERT_USD_CONFIG_KEY, usd);
    this.emit();
    return true;
  }

  overBudget(): boolean {
    return computeBudgetBreach(this.sessionCost().usd, this.budget());
  }

  /** True when the current model can carry a manual price (prices are keyed provider:model). */
  canSetModelPrice(): boolean {
    const model = this.modelId();
    return model !== 'unknown' && model.includes(':');
  }

  /** Store your own price for the current model, USD per 1M tokens. */
  setModelPrice(input: number, output: number): boolean {
    if (!this.canSetModelPrice()) return false;
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) return false;
    writeManualModelPrice(this.configAccess(), this.modelId(), { input, output });
    this.emit();
    return true;
  }
}
