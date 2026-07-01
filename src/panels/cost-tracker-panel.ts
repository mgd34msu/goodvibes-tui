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
import { calcSessionCost } from '../export/cost-utils.ts';
import { abbreviateCount } from '../utils/format-number.ts';

// Pricing lookups are provided by ../export/cost-utils.ts (single source of truth).

function formatCost(usd: number): string {
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

  // Budget alert threshold in USD (0 = disabled)
  private budgetThreshold: number;

  // Scroll offset for agent list
  private scrollOffset = 0;

  // Unsubscribe functions
  private unsubs: Array<() => void> = [];

  // Getter for live orchestrator usage
  private readonly getOrchestratorUsage: () => UsageSnapshot & { model?: string };

  // Optional resolver for agent usage on completion — enables real cost attribution.
  // When omitted, completed agents show $0 (honest: data unavailable).
  private readonly getAgentStatus: ((agentId: string) => AgentRecord | null) | undefined;

  constructor(
    turnEvents: UiEventFeed<TurnEvent>,
    agentEvents: UiEventFeed<AgentEvent>,
    getOrchestratorUsage: () => UsageSnapshot & { model?: string },
    opts: { budgetThreshold?: number; getAgentStatus?: (agentId: string) => AgentRecord | null } = {},
  ) {
    super('cost', 'Cost', '$', 'monitoring');
    this.getOrchestratorUsage = getOrchestratorUsage;
    this.getAgentStatus = opts.getAgentStatus;
    this.budgetThreshold = opts.budgetThreshold ?? 0;
    this.attachEvents(turnEvents, agentEvents);
  }

  // -------------------------------------------------------------------------
  // Bus wiring
  // -------------------------------------------------------------------------

  private attachEvents(turnEvents: UiEventFeed<TurnEvent>, agentEvents: UiEventFeed<AgentEvent>): void {
    // Refresh after every completed turn
    this.unsubs.push(
      turnEvents.on('TURN_COMPLETED', () => this.onTurnComplete()),
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

  private onTurnComplete(): void {
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
  }

  override onDestroy(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(key: string): boolean {
    switch (key) {
      case 'up':   return this.scroll(-1);
      case 'down': return this.scroll(1);
      case 'pageup':   return this.scroll(-10);
      case 'pagedown': return this.scroll(10);
      default: return false;
    }
  }

  private scroll(delta: number): boolean {
    const prev = this.scrollOffset;
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    if (this.scrollOffset !== prev) this.markDirty();
    return true;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  render(width: number, height: number): Line[] {
    if (height <= 0 || width <= 0) return [];

    const totalInputTokens = this.sessionUsage.input + this.sessionUsage.cacheRead + this.sessionUsage.cacheWrite;
    const sessionCost = calcSessionCost(this.sessionUsage.input, this.sessionUsage.output, this.sessionUsage.cacheRead, this.sessionUsage.cacheWrite, this.sessionModel);
    const overBudget = this.budgetThreshold > 0 && sessionCost > this.budgetThreshold;
    const sparkline = buildSparkline(this.costHistory);
    const costStr = formatCost(sessionCost);
    const costFg = overBudget ? C.bad : C.cost;
    const budgetStr = this.budgetThreshold > 0
      ? ` / ${formatCost(this.budgetThreshold)}`
      : '';
    const alertStr = overBudget ? ' ! OVER BUDGET' : '';
    const sessionLines: Line[] = [
      this.renderKeyValue(width, ' Total', `${costStr}${budgetStr}${alertStr}`, costFg),
    ];
    // Budget meter — the single most important glance for this panel: how much
    // of the configured budget the session has consumed. Only shown when a
    // budget is set (otherwise the bar would be meaningless).
    if (this.budgetThreshold > 0) {
      const ratio = sessionCost / this.budgetThreshold;
      const BAR_W = 24;
      const filled = Math.max(0, Math.min(BAR_W, Math.round(ratio * BAR_W)));
      const meterFg = overBudget ? C.bad : ratio >= 0.8 ? C.warn : C.good;
      const pctStr = `${Math.round(ratio * 100)}%`;
      sessionLines.push(buildMeterLine(width, filled, BAR_W,
        { filled: meterFg, empty: C.separator, label: C.label },
        { prefix: ' Budget [', suffix: `] ${pctStr}` },
      ));
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
        ], DEFAULT_PANEL_PALETTE)
      : buildKeyboardHints(width, [
          { keys: '/cost budget <usd>', label: 'set budget alert' },
        ], DEFAULT_PANEL_PALETTE);
    if (agentList.length > 0) {
      const planCost = agentList.reduce((sum, a) => sum + a.cost, 0);
      const running = agentList.filter((a) => a.status === 'running').length;
      const failed = agentList.filter((a) => a.status === 'failed').length;
      const agentRows: Line[] = [
        buildStyledPanelLine(width, [
          { text: ' Plan total ', fg: C.label },
          { text: formatCost(planCost + sessionCost), fg: C.cost, bold: true },
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
                { text: agent.cost > 0 ? formatCost(agent.cost) : '-', fg: agent.cost > 0 ? C.cost : C.dim },
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
          [
            { command: '/cost budget <usd>', summary: 'set a session budget alert to track spend against a cap' },
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

}
