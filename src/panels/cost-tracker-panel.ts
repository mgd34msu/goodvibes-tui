// ---------------------------------------------------------------------------
// CostTrackerPanel — per-session / per-agent / per-plan cost estimates
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import { fitDisplay, truncateDisplay } from '../utils/terminal-width.ts';
import { BasePanel } from './base-panel.ts';
import type { AgentEvent, TurnEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';
import {
  buildEmptyState,
  buildKeyboardHints,
  buildMeterLine,
  buildPanelLine,
  buildStyledPanelLine,
  buildTable,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  extendPalette,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import { calcSessionCost, describePricingSource, isModelPriced, computeBudgetBreach, readBudgetAlertUsd, writeManualModelPrice, BUDGET_ALERT_USD_CONFIG_KEY, type BudgetAlertConfigAccess } from '../export/cost-utils.ts';
import { abbreviateCount } from '../utils/format-number.ts';
import { isTextBackspace } from '../input/delete-key-policy.ts';

// Pricing lookups are provided by ../export/cost-utils.ts (single source of truth).

/** unpriced=true renders the explicit "price unknown" marker instead of a $0.00 that could be mistaken for a real zero cost. */
function formatCost(usd: number, unpriced = false): string {
  if (unpriced) return 'price unknown';
  if (usd === 0) return '$0.00';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function formatTokens(n: number): string {
  return abbreviateCount(n);
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface AgentEntry {
  id: string;      // short form, e.g. first 8 chars
  task: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  status: 'running' | 'done' | 'failed';
}

// Sparkline history (rolling last N cost-per-turn values)
const SPARKLINE_BARS = '._-:=+*#';
const SPARKLINE_LEN = 16;

function buildSparkline(history: number[]): string {
  if (history.length === 0) return '';
  const max = Math.max(...history);
  if (max === 0) return '.'.repeat(history.length);
  return history
    .map(v => {
      const idx = Math.round((v / max) * (SPARKLINE_BARS.length - 1));
      return SPARKLINE_BARS[idx] ?? '.';
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Colour palette
// ---------------------------------------------------------------------------

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  cost:      '#ffdd44',
  model:     '#88aaff',
  running:   '#88aaff',
  separator: '#333333',
  bg:        '',
});

// ---------------------------------------------------------------------------
// CostTrackerPanel
// ---------------------------------------------------------------------------

export class CostTrackerPanel extends BasePanel {
  // Session-level usage (from main orchestrator)
  private sessionUsage: UsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private sessionModel = 'unknown';

  // Per-turn cost history for sparkline
  private costHistory: number[] = [];
  private lastSessionCost = 0;

  // Per-agent tracking (keyed by agent id)
  private agents = new Map<string, AgentEntry>();

  // Budget alert threshold in USD (0 = disabled). Mutable at runtime via the
  // in-panel 'b' numeric entry or the /cost budget <usd> command — both call
  // setBudgetThreshold() below. When configAccess is wired (production path),
  // this field is a cache only — currentBudgetThreshold() re-reads
  // behavior.budgetAlertUsd from config on every use so the panel and the
  // background budget-breach notifier (core/budget-breach-notifier.ts) never
  // disagree about the threshold. Tests that omit configAccess fall back to
  // this field as the sole source of truth, unchanged from prior behavior.
  private budgetThreshold: number;

  // Optional config-backed source of truth for the budget threshold. Absent
  // in most existing unit tests (which construct the panel directly) and in
  // any build that doesn't wire a config manager; present in production via
  // builtin/development.ts.
  private readonly configAccess: BudgetAlertConfigAccess | undefined;

  // Draft buffer for the in-panel budget-entry mode ('b' key). Non-null while
  // entry is active; unlike LocalAuthPanel's masked entry, the value is not
  // secret so it is echoed directly.
  private budgetEntry: string | null = null;

  // Draft buffer for the in-panel manual-price entry mode ('p' key): the one
  // action away from any price display (and from the "price unknown" marker).
  // Format: "input,output" in USD per 1M tokens; persists to the
  // pricing.modelPrices settings key live on Enter.
  private priceEntry: string | null = null;

  // Scroll offset for agent list
  private scrollOffset = 0;

  // Unsubscribe functions
  private unsubs: Array<() => void> = [];

  // Polls getAgentStatus() for agents still marked 'running' so their token/
  // cost columns fill in as usage streams, instead of staying pinned at
  // 'unknown'/$0 until AGENT_COMPLETED fires.
  private statusPollTimer: ReturnType<typeof setInterval> | null = null;

  // Getter for live orchestrator usage
  private readonly getOrchestratorUsage: () => UsageSnapshot & { model?: string };

  // Optional resolver for agent usage on completion — enables real cost attribution.
  // When omitted, completed agents show $0 (honest: data unavailable).
  private readonly getAgentStatus: ((agentId: string) => AgentRecord | null) | undefined;

  constructor(
    turnEvents: UiEventFeed<TurnEvent>,
    agentEvents: UiEventFeed<AgentEvent>,
    getOrchestratorUsage: () => UsageSnapshot & { model?: string },
    opts: {
      budgetThreshold?: number;
      getAgentStatus?: (agentId: string) => AgentRecord | null;
      configAccess?: BudgetAlertConfigAccess;
    } = {},
  ) {
    super('cost', 'Cost', '$', 'providers');
    this.getOrchestratorUsage = getOrchestratorUsage;
    this.getAgentStatus = opts.getAgentStatus;
    this.configAccess = opts.configAccess;
    this.budgetThreshold = this.configAccess ? readBudgetAlertUsd(this.configAccess.get) : (opts.budgetThreshold ?? 0);
    this.attachEvents(turnEvents, agentEvents);
  }

  /** The live budget threshold: re-read from config when configAccess is wired
   * (single source of truth shared with the background notifier), otherwise
   * the locally-cached field (test/no-config-manager fallback). */
  private currentBudgetThreshold(): number {
    return this.configAccess ? readBudgetAlertUsd(this.configAccess.get) : this.budgetThreshold;
  }

  // -------------------------------------------------------------------------
  // Bus wiring
  // -------------------------------------------------------------------------

  private attachEvents(turnEvents: UiEventFeed<TurnEvent>, agentEvents: UiEventFeed<AgentEvent>): void {
    // Refresh after every completed turn
    this.unsubs.push(
      turnEvents.on('TURN_COMPLETED', () => this.refreshSessionCost()),
    );

    // Refresh mid-turn too: a single turn can span many LLM calls (tool
    // loops), so waiting for TURN_COMPLETED leaves the meter frozen for the
    // whole turn. LLM_RESPONSE_RECEIVED fires per call — same refresh path.
    this.unsubs.push(
      turnEvents.on('LLM_RESPONSE_RECEIVED', () => this.refreshSessionCost()),
    );

    // Track agent spawns
    this.unsubs.push(
      agentEvents.on('AGENT_SPAWNING', (payload) => {
        this.agents.set(payload.agentId, {
          id: payload.agentId.slice(0, 8),
          task: truncateDisplay(payload.task, 40),
          model: 'unknown',
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          status: 'running',
        });
        this.markDirty();
      }),
    );

    // Agent completed — capture real token usage via AgentRecord when available
    this.unsubs.push(
      agentEvents.on('AGENT_COMPLETED', (payload) => {
        const entry = this.agents.get(payload.agentId);
        if (entry) {
          entry.status = 'done';
          if (this.getAgentStatus) {
            const rec = this.getAgentStatus(payload.agentId);
            if (rec?.usage) {
              entry.inputTokens = rec.usage.inputTokens + (rec.usage.cacheReadTokens ?? 0) + (rec.usage.cacheWriteTokens ?? 0);
              entry.outputTokens = rec.usage.outputTokens;
              entry.cost = calcSessionCost(rec.usage.inputTokens, rec.usage.outputTokens, rec.usage.cacheReadTokens ?? 0, rec.usage.cacheWriteTokens ?? 0, rec.model ?? 'unknown');
              if (rec.model && rec.model !== 'unknown') entry.model = rec.model;
            }
          }
          this.markDirty();
        }
      }),
    );

    // Agent error
    this.unsubs.push(
      agentEvents.on('AGENT_FAILED', (payload) => {
        const entry = this.agents.get(payload.agentId);
        if (entry) {
          entry.status = 'failed';
          this.markDirty();
        }
      }),
    );
  }

  private refreshSessionCost(): void {
    const usage = this.getOrchestratorUsage();
    this.sessionUsage = {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    };
    if (usage.model) this.sessionModel = usage.model;

    // Record cost delta for sparkline
    const totalCost = calcSessionCost(usage.input, usage.output, usage.cacheRead, usage.cacheWrite, this.sessionModel);
    const delta = Math.max(0, totalCost - this.lastSessionCost);
    this.lastSessionCost = totalCost;
    this.costHistory.push(delta);
    if (this.costHistory.length > SPARKLINE_LEN) {
      this.costHistory.shift();
    }

    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override onActivate(): void {
    // Sync latest usage on activation
    const usage = this.getOrchestratorUsage();
    this.sessionUsage = {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    };
    this.needsRender = true;
    this.startStatusPollTimer();
  }

  override onDeactivate(): void {
    // Stop polling while hidden — nothing to catch up on that a fresh
    // onActivate() poll won't cover.
    this.stopStatusPollTimer();
  }

  override onDestroy(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  private startStatusPollTimer(): void {
    if (this.statusPollTimer !== null || !this.getAgentStatus) return;
    this.statusPollTimer = this.registerTimer(setInterval(() => this.pollRunningAgents(), 3_000));
  }

  private stopStatusPollTimer(): void {
    if (this.statusPollTimer !== null) {
      this.clearTimer(this.statusPollTimer);
      this.statusPollTimer = null;
    }
  }

  /**
   * Poll getAgentStatus() for every agent still marked 'running'. Completion
   * already captures real usage via AGENT_COMPLETED, but a long-running agent
   * would otherwise show 'unknown' tokens / $0 cost for its entire lifetime —
   * this fills the row in as usage becomes available mid-flight.
   */
  private pollRunningAgents(): void {
    if (!this.getAgentStatus) return;
    let changed = false;
    for (const [agentId, entry] of this.agents) {
      if (entry.status !== 'running') continue;
      const rec = this.getAgentStatus(agentId);
      if (!rec?.usage) continue;
      const inputTokens = rec.usage.inputTokens + (rec.usage.cacheReadTokens ?? 0) + (rec.usage.cacheWriteTokens ?? 0);
      const outputTokens = rec.usage.outputTokens;
      const cost = calcSessionCost(rec.usage.inputTokens, rec.usage.outputTokens, rec.usage.cacheReadTokens ?? 0, rec.usage.cacheWriteTokens ?? 0, rec.model ?? entry.model);
      if (inputTokens !== entry.inputTokens || outputTokens !== entry.outputTokens || cost !== entry.cost) {
        entry.inputTokens = inputTokens;
        entry.outputTokens = outputTokens;
        entry.cost = cost;
        changed = true;
      }
      if (rec.model && rec.model !== 'unknown' && rec.model !== entry.model) {
        entry.model = rec.model;
        changed = true;
      }
    }
    if (changed) this.markDirty();
  }

  /** Set the budget alert threshold (USD; 0 disables it). Shared by the
   * in-panel 'b' entry and the /cost budget <usd> command. */
  public setBudgetThreshold(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) return;
    this.budgetThreshold = usd;
    this.configAccess?.set(BUDGET_ALERT_USD_CONFIG_KEY, usd);
    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * The budget-threshold entry field wants every character of a burst
   * (paste, or fast typing landing in one input.feed() call) delivered one
   * at a time, same as it always has — see the interface doc on
   * `Panel.isCapturingTextBurst`.
   */
  isCapturingTextBurst(): boolean {
    return this.budgetEntry !== null || this.priceEntry !== null;
  }

  handleInput(key: string): boolean {
    if (this.budgetEntry !== null) return this.handleBudgetEntryInput(key);
    if (this.priceEntry !== null) return this.handlePriceEntryInput(key);

    if (key === 'b') {
      const threshold = this.currentBudgetThreshold();
      this.budgetEntry = threshold > 0 ? String(threshold) : '';
      this.markDirty();
      return true;
    }

    if (key === 'p') {
      // One action from any price display: edit the manual price for the
      // session's provider:model. Needs a wired config (production path) —
      // without one the key falls through rather than opening a dead editor.
      if (!this.configAccess) return false;
      this.priceEntry = '';
      this.markDirty();
      return true;
    }

    switch (key) {
      case 'up':   return this.scroll(-1);
      case 'down': return this.scroll(1);
      case 'pageup':   return this.scroll(-10);
      case 'pagedown': return this.scroll(10);
      default: return false;
    }
  }

  private handleBudgetEntryInput(key: string): boolean {
    if (key === 'escape') {
      this.budgetEntry = null;
      this.markDirty();
      return true;
    }
    if (key === 'enter' || key === 'return') {
      const raw = this.budgetEntry ?? '';
      this.budgetEntry = null;
      const parsed = Number(raw);
      if (raw.length > 0 && Number.isFinite(parsed) && parsed >= 0) {
        this.setBudgetThreshold(parsed);
      } else {
        this.markDirty();
      }
      return true;
    }
    if (isTextBackspace(key)) {
      if (this.budgetEntry && this.budgetEntry.length > 0) {
        this.budgetEntry = this.budgetEntry.slice(0, -1);
        this.markDirty();
      }
      return true;
    }
    // Digits and a single decimal point only — this is a USD amount, not free text.
    if (key.length === 1 && /[0-9.]/.test(key) && !(key === '.' && this.budgetEntry?.includes('.'))) {
      this.budgetEntry = (this.budgetEntry ?? '') + key;
      this.markDirty();
      return true;
    }
    return true; // absorb everything else while entry is active
  }

  /** True when the session model can carry a manual price (pricing.modelPrices keys are `provider:model`). */
  private canEditSessionModelPrice(): boolean {
    return this.sessionModel !== 'unknown' && this.sessionModel.includes(':');
  }

  private handlePriceEntryInput(key: string): boolean {
    if (key === 'escape') {
      this.priceEntry = null;
      this.markDirty();
      return true;
    }
    if (key === 'enter' || key === 'return') {
      const raw = (this.priceEntry ?? '').trim();
      if (!this.canEditSessionModelPrice()) {
        // The prompt already explains why; Enter just closes it.
        this.priceEntry = null;
        this.markDirty();
        return true;
      }
      const parts = raw.split(/[\s,]+/).filter((part) => part.length > 0);
      const input = Number(parts[0]);
      const output = Number(parts[1]);
      if (parts.length === 2 && Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0) {
        writeManualModelPrice(this.configAccess!, this.sessionModel, { input, output });
        this.priceEntry = null;
      }
      // Malformed input keeps the editor open so the draft can be corrected.
      this.markDirty();
      return true;
    }
    if (isTextBackspace(key)) {
      if (this.priceEntry && this.priceEntry.length > 0) {
        this.priceEntry = this.priceEntry.slice(0, -1);
        this.markDirty();
      }
      return true;
    }
    // Two USD amounts separated by a comma (or space) — digits, dots, comma, space.
    if (key.length === 1 && /[0-9., ]/.test(key)) {
      this.priceEntry = (this.priceEntry ?? '') + key;
      this.markDirty();
      return true;
    }
    return true; // absorb everything else while entry is active
  }

  /**
   * Scroll the agent list. Over-consumption fix: only absorbs the key (and
   * only advances) when the agent list is actually long enough to scroll —
   * mirrors the same `> 5` threshold render() uses to decide whether to show
   * scroll hints (below). Previously this always returned true and grew
   * scrollOffset unboundedly even with a handful of agents, swallowing
   * up/down/page keys that had nothing to do.
   */
  private scroll(delta: number): boolean {
    const agentCount = this.agents.size;
    if (agentCount <= 5) return false;
    const maxOffset = Math.max(0, agentCount - 1);
    const prev = this.scrollOffset;
    this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
    if (this.scrollOffset !== prev) this.markDirty();
    return true;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  render(width: number, height: number): Line[] {
    if (height <= 0 || width <= 0) return [];
    if (this.budgetEntry !== null) return this.renderBudgetEntryPrompt(width, height);
    if (this.priceEntry !== null) return this.renderPriceEntryPrompt(width, height);

    const totalInputTokens = this.sessionUsage.input + this.sessionUsage.cacheRead + this.sessionUsage.cacheWrite;
    const sessionCost = calcSessionCost(this.sessionUsage.input, this.sessionUsage.output, this.sessionUsage.cacheRead, this.sessionUsage.cacheWrite, this.sessionModel);
    const budgetThreshold = this.currentBudgetThreshold();
    const overBudget = computeBudgetBreach(sessionCost, budgetThreshold);
    const sparkline = buildSparkline(this.costHistory);
    const sessionPriced = isModelPriced(this.sessionModel);
    const costStr = formatCost(sessionCost, !sessionPriced);
    const costFg = overBudget ? C.bad : C.cost;
    // Dollars carry their source: "your price" for a manual entry,
    // "catalog price, as of <date>" for the dated catalog, etc. The
    // "price unknown" marker carries the one-key action to fix it instead.
    const sourceDescription = sessionPriced ? describePricingSource(this.sessionModel) : null;
    const sourceStr = sessionPriced
      ? (sourceDescription ? ` (${sourceDescription})` : '')
      : ' — press p to set a price';
    const budgetStr = budgetThreshold > 0
      ? ` / ${formatCost(budgetThreshold)}`
      : '';
    const alertStr = overBudget ? ' ! OVER BUDGET' : '';
    const sessionLines: Line[] = [
      this.renderKeyValue(width, ' Total', `${costStr}${budgetStr}${alertStr}${sourceStr}`, costFg),
    ];
    // Budget meter — the single most important glance for this panel: how much
    // of the configured budget the session has consumed. Only shown when a
    // budget is set (otherwise the bar would be meaningless).
    if (budgetThreshold > 0) {
      const ratio = sessionCost / budgetThreshold;
      const BAR_W = 24;
      const filled = Math.max(0, Math.min(BAR_W, Math.round(ratio * BAR_W)));
      const meterFg = overBudget ? C.bad : ratio >= 0.8 ? C.warn : C.good;
      const pctStr = `${Math.round(ratio * 100)}%`;
      sessionLines.push(buildMeterLine(width, filled, BAR_W,
        { filled: meterFg, empty: C.separator, label: C.label },
        { prefix: ' Budget [', suffix: `] ${pctStr}` },
      ));
      // Unpriced-spend honesty wherever budget state shows: a meter over a
      // partially-unpriced session must say the % undercounts real spend.
      const anyUnpricedSpend = (!sessionPriced && (totalInputTokens > 0 || this.sessionUsage.output > 0))
        || Array.from(this.agents.values()).some((agent) => agent.inputTokens > 0 && !isModelPriced(agent.model));
      if (anyUnpricedSpend) {
        sessionLines.push(this.renderKeyValue(width, '', 'some spend has no known price and is not counted above', C.warn));
      }
    }
    if (sparkline.length > 0) sessionLines.push(this.renderLabeledLine(width, ' Trend', sparkline, C.good));
    sessionLines.push(this.renderKeyValue(width, ' Input',  formatTokens(this.sessionUsage.input),  C.label));
    sessionLines.push(this.renderKeyValue(width, ' Output', formatTokens(this.sessionUsage.output), C.label));
    if (this.sessionUsage.cacheRead > 0 || this.sessionUsage.cacheWrite > 0) {
      sessionLines.push(this.renderKeyValue(width, ' Cache W', formatTokens(this.sessionUsage.cacheWrite), C.dim));
      sessionLines.push(this.renderKeyValue(width, ' Cache R', formatTokens(this.sessionUsage.cacheRead), C.dim));
    }
    sessionLines.push(this.renderKeyValue(width, ' Total T', formatTokens(totalInputTokens + this.sessionUsage.output), C.label));
    sessionLines.push(this.renderKeyValue(width, ' Model', this.sessionModel, C.model));

    const sections: PanelWorkspaceSection[] = [
      {
        title: 'Session Cost',
        lines: sessionLines,
      },
    ];

    const agentList = Array.from(this.agents.values());
    const scrollableAgents = agentList.length > 5;
    // Footer hints adapt to whether the agent list is long enough to scroll.
    const hintRow = scrollableAgents
      ? buildKeyboardHints(width, [
          { keys: 'Up/Down', label: 'scroll agents' },
          { keys: 'PgUp/PgDn', label: 'page' },
          { keys: 'b', label: 'set budget' },
          { keys: 'p', label: 'set model price' },
        ], DEFAULT_PANEL_PALETTE)
      : buildKeyboardHints(width, [
          { keys: 'b', label: 'set budget alert' },
          { keys: 'p', label: 'set model price' },
        ], DEFAULT_PANEL_PALETTE);
    if (agentList.length > 0) {
      const planCost = agentList.reduce((sum, a) => sum + a.cost, 0);
      const running = agentList.filter((a) => a.status === 'running').length;
      const failed = agentList.filter((a) => a.status === 'failed').length;
      // Plan total mixes the session model with every agent's model — flag it
      // as unpriced (rather than showing a sum that silently omits unpriced
      // agents' contribution) if any one of them has no real pricing.
      const planHasUnpriced = !isModelPriced(this.sessionModel) || agentList.some((a) => !isModelPriced(a.model));
      const agentRows: Line[] = [
        buildStyledPanelLine(width, [
          { text: ' Plan total ', fg: C.label },
          { text: formatCost(planCost + sessionCost, planHasUnpriced), fg: C.cost, bold: true },
          { text: `  ${agentList.length} agent${agentList.length === 1 ? '' : 's'}`, fg: C.dim },
          ...(running > 0 ? [{ text: `  ${running} running`, fg: C.running }] : []),
          ...(failed > 0 ? [{ text: `  ${failed} failed`, fg: C.bad }] : []),
        ]),
        // Per-agent cost ledger as an aligned table — agent, model, tokens, cost
        // line up in columns instead of wrapping across two ragged rows.
        ...buildTable(
          width,
          [
            { label: 'Agent', width: 14 },
            { label: 'Model', width: 18 },
            { label: 'In', width: 7, align: 'right' },
            { label: 'Out', width: 7, align: 'right' },
            { label: 'Cost', align: 'right' },
          ],
          agentList.map((agent) => {
            const statusFg = agent.status === 'running' ? C.running
              : agent.status === 'failed' ? C.bad
              : C.good;
            const statusIcon = agent.status === 'running' ? '…'
              : agent.status === 'failed' ? '✕'
              : '✓';
            return {
              cells: [
                { text: `${statusIcon} ${agent.id}`, fg: statusFg },
                { text: agent.model, fg: C.model },
                { text: agent.inputTokens > 0 ? formatTokens(agent.inputTokens) : '-', fg: C.dim },
                { text: agent.outputTokens > 0 ? formatTokens(agent.outputTokens) : '-', fg: C.dim },
                {
                  // '-' means no usage reported yet; 'unpriced' means usage
                  // exists but the model has no real price; otherwise the cost.
                  text: agent.inputTokens > 0 && !isModelPriced(agent.model)
                    ? 'unpriced'
                    : agent.cost > 0 ? formatCost(agent.cost) : '-',
                  fg: agent.cost > 0 ? C.cost : C.dim,
                },
              ],
            };
          }),
          DEFAULT_PANEL_PALETTE,
        ),
      ];
      const sessionSection: PanelWorkspaceSection = sections[0]!;
      const agentsSection = resolveScrollablePanelSection(width, height, {
        intro: 'Track per-session and per-agent token spend using model pricing and live usage snapshots.',
        footerLines: [hintRow],
        palette: DEFAULT_PANEL_PALETTE,
        beforeSections: [sessionSection],
        section: {
          title: 'Agents',
          scrollableLines: agentRows,
          scrollOffset: this.scrollOffset,
          minRows: 4,
          appendWindowSummary: scrollableAgents ? { dimColor: DEFAULT_PANEL_PALETTE.dim } : undefined,
        },
      });
      this.scrollOffset = agentsSection.scrollOffset;
      sections.push(agentsSection.section);
    } else {
      sections.push({
        title: 'Agents',
        lines: buildEmptyState(
          width,
          ' No agents spawned this session',
          'Agent-level cost estimates appear here once delegated or background agents start running.',
          // 'b' already opens the in-panel budget-entry field (see
          // handleInput/handleBudgetEntryInput above) and is advertised in
          // the footer's 'b: set budget' hint, so the printed
          // '/cost budget <usd>' command was a redundant action substitute.
          [
            { command: 'b', summary: 'set a session budget alert to track spend against a cap' },
          ],
          DEFAULT_PANEL_PALETTE,
        ),
      });
    }

    return buildPanelWorkspace(width, height, {
      title: ' Cost Tracker',
      intro: 'Track per-session and per-agent token spend using model pricing and live usage snapshots.',
      sections,
      footerLines: [hintRow],
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  private renderKeyValue(width: number, label: string, value: string, valueFg: string): Line {
    const LABEL_W = 10;
    return buildStyledPanelLine(width, [
      { text: fitDisplay(label, LABEL_W), fg: C.label, bg: C.bg },
      { text: ': ', fg: C.dim, bg: C.bg },
      { text: value, fg: valueFg, bg: C.bg, bold: true },
    ]);
  }

  private renderLabeledLine(width: number, label: string, value: string, valueFg: string): Line {
    return buildStyledPanelLine(width, [
      ...(label.length > 0 ? [{ text: `${fitDisplay(label, 10)} `, fg: C.label }] : []),
      { text: value, fg: valueFg },
    ]);
  }

  // Non-masked numeric entry for the 'b' budget-alert key — the value is a
  // USD amount, not a secret, so (unlike LocalAuthPanel's masked entry) it is
  // echoed directly rather than dotted out.
  private renderBudgetEntryPrompt(width: number, height: number): Line[] {
    const draft = this.budgetEntry ?? '';
    const display = `$${draft}█`;
    const promptLines: Line[] = [
      buildPanelLine(width, [[' Set the session budget alert (USD). 0 disables it.', C.label]]),
      buildPanelLine(width, [['', C.label]]),
      buildPanelLine(width, [[' Budget  ', C.label], [display, C.cost]]),
      buildPanelLine(width, [['', C.label]]),
      buildPanelLine(width, [[' [Enter] Confirm   [Esc] Cancel   [Backspace] Delete char', C.dim]]),
    ];
    const workspace = buildPanelWorkspace(width, height, {
      title: ' Cost Tracker — Budget',
      intro: 'Type a USD amount and press Enter to set the budget alert threshold.',
      sections: [{ lines: promptLines }],
      palette: DEFAULT_PANEL_PALETTE,
    });
    while (workspace.length < height) workspace.push(createEmptyLine(width));
    return workspace.slice(0, height);
  }

  // Non-masked entry for the 'p' manual-price key. Two USD-per-1M-token
  // amounts (input,output); persists to pricing.modelPrices for the session's
  // provider:model live. A model without a provider prefix cannot carry a
  // manual price (the settings key is keyed provider:model) — the prompt says
  // so instead of accepting a value it could not store.
  private renderPriceEntryPrompt(width: number, height: number): Line[] {
    const editable = this.canEditSessionModelPrice();
    const draft = this.priceEntry ?? '';
    const display = `${draft}█`;
    const promptLines: Line[] = editable
      ? [
          buildPanelLine(width, [[` Set your manual price for ${this.sessionModel} (USD per 1M tokens).`, C.label]]),
          buildPanelLine(width, [[' Format: input,output — for example 3.00,15.00', C.dim]]),
          buildPanelLine(width, [['', C.label]]),
          buildPanelLine(width, [[' Price  ', C.label], [display, C.cost]]),
          buildPanelLine(width, [['', C.label]]),
          buildPanelLine(width, [[' [Enter] Save   [Esc] Cancel   [Backspace] Delete char', C.dim]]),
        ]
      : [
          buildPanelLine(width, [[` The current model (${this.sessionModel}) has no provider prefix, so a`, C.label]]),
          buildPanelLine(width, [[' manual price cannot be stored for it (prices are keyed provider:model).', C.label]]),
          buildPanelLine(width, [['', C.label]]),
          buildPanelLine(width, [[' [Esc] Close', C.dim]]),
        ];
    const workspace = buildPanelWorkspace(width, height, {
      title: ' Cost Tracker — Model Price',
      intro: editable
        ? 'Your price wins over provider and catalog prices, immediately and everywhere.'
        : 'Manual prices are stored per provider:model.',
      sections: [{ lines: promptLines }],
      palette: DEFAULT_PANEL_PALETTE,
    });
    while (workspace.length < height) workspace.push(createEmptyLine(width));
    return workspace.slice(0, height);
  }

}
