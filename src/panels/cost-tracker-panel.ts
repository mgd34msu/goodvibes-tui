// ---------------------------------------------------------------------------
// CostTrackerPanel — per-session / per-agent / per-plan cost estimates
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { AgentEvent, TurnEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildStyledPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import { getPricing } from '../export/cost-utils.ts';

// Pricing lookups are provided by ../export/cost-utils.ts (single source of truth).

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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

const C = {
  header:    '#ffffff',
  label:     '#aaaaaa',
  value:     '#00ff88',
  cost:      '#ffdd44',
  alert:     '#ff4444',
  dim:       '#555555',
  model:     '#88aaff',
  running:   '#88aaff',
  done:      '#00ff88',
  failed:    '#ff4444',
  separator: '#333333',
  bg:        '',
} as const;

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

  constructor(
    turnEvents: UiEventFeed<TurnEvent>,
    agentEvents: UiEventFeed<AgentEvent>,
    getOrchestratorUsage: () => UsageSnapshot & { model?: string },
    opts: { budgetThreshold?: number } = {},
  ) {
    super('cost', 'Cost', '$', 'monitoring');
    this.getOrchestratorUsage = getOrchestratorUsage;
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
          task: payload.task.length > 40 ? payload.task.slice(0, 37) + '...' : payload.task,
          model: 'unknown',
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          status: 'running',
        });
        this.markDirty();
      }),
    );

    // Agent completed — capture token data from result if available
    this.unsubs.push(
      agentEvents.on('AGENT_COMPLETED', (payload) => {
        const entry = this.agents.get(payload.agentId);
        if (entry) {
          entry.status = 'done';
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
    const pricing = getPricing(this.sessionModel);
    const billableInput = usage.input + usage.cacheRead + usage.cacheWrite;
    const totalCost = (billableInput * pricing.input + usage.output * pricing.output) / 1_000_000;
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

    const pricing = getPricing(this.sessionModel);
    const totalInputTokens = this.sessionUsage.input + this.sessionUsage.cacheRead + this.sessionUsage.cacheWrite;
    const sessionCost = (totalInputTokens * pricing.input + this.sessionUsage.output * pricing.output) / 1_000_000;
    const overBudget = this.budgetThreshold > 0 && sessionCost > this.budgetThreshold;
    const sparkline = buildSparkline(this.costHistory);
    const costStr = formatCost(sessionCost);
    const costFg = overBudget ? C.alert : C.cost;
    const budgetStr = this.budgetThreshold > 0
      ? ` / ${formatCost(this.budgetThreshold)}`
      : '';
    const alertStr = overBudget ? ' ! OVER BUDGET' : '';
    const sessionLines: Line[] = [
      this.renderKeyValue(width, ' Total', `${costStr}${budgetStr}${alertStr}`, costFg),
    ];
    if (sparkline.length > 0) sessionLines.push(this.renderLabeledLine(width, ' Trend', sparkline, C.value));
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
    if (agentList.length > 0) {
      const planCost = agentList.reduce((sum, a) => sum + a.cost, 0);
      const agentRows: Line[] = [
        this.renderKeyValue(width, ' Plan total', formatCost(planCost + sessionCost), C.cost),
        this.renderDivider(width),
      ];
      for (const agent of agentList) {
        const statusFg = agent.status === 'running' ? C.running
          : agent.status === 'failed' ? C.failed
          : C.done;
        const statusIcon = agent.status === 'running' ? '…'
          : agent.status === 'failed' ? '✕'
          : '✓';

        const agentLabel = `${statusIcon} ${agent.id}`;
        const taskText = agent.task;
        agentRows.push(this.renderAgent(width, agentLabel, taskText, statusFg));

        if (agent.inputTokens > 0 || agent.outputTokens > 0) {
          const tokenInfo = `  in:${formatTokens(agent.inputTokens)} out:${formatTokens(agent.outputTokens)} ${formatCost(agent.cost)}`;
          agentRows.push(this.renderLabeledLine(width, '', tokenInfo, C.dim));
        }
      }
      const sessionSection: PanelWorkspaceSection = sections[0]!;
      const agentsSection = resolveScrollablePanelSection(width, height, {
        intro: 'Track per-session and per-agent token spend using model pricing and live usage snapshots.',
        footerLines: [
          buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' scroll agents', DEFAULT_PANEL_PALETTE.dim]]),
        ],
        palette: DEFAULT_PANEL_PALETTE,
        beforeSections: [sessionSection],
        section: {
          title: 'Agents',
          scrollableLines: agentRows,
          scrollOffset: this.scrollOffset,
          minRows: 4,
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
          [],
          DEFAULT_PANEL_PALETTE,
        ),
      });
    }

    return buildPanelWorkspace(width, height, {
      title: ' Cost Tracker',
      intro: 'Track per-session and per-agent token spend using model pricing and live usage snapshots.',
      sections,
      footerLines: [
        buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' scroll agents', DEFAULT_PANEL_PALETTE.dim]]),
      ],
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  private renderKeyValue(width: number, label: string, value: string, valueFg: string): Line {
    const LABEL_W = 10;
    return buildStyledPanelLine(width, [
      { text: label.padEnd(LABEL_W).slice(0, LABEL_W), fg: C.label, bg: C.bg },
      { text: ': ', fg: C.dim, bg: C.bg },
      { text: value, fg: valueFg, bg: C.bg, bold: true },
    ]);
  }

  private renderLabeledLine(width: number, label: string, value: string, valueFg: string): Line {
    return buildStyledPanelLine(width, [
      ...(label.length > 0 ? [{ text: `${label.slice(0, 10).padEnd(10)} `, fg: C.label }] : []),
      { text: value, fg: valueFg },
    ]);
  }

  private renderAgent(width: number, label: string, task: string, fg: string): Line {
    const LABEL_W = 12;
    const remaining = width - LABEL_W - 1;
    const trimmed = task.length > remaining ? task.slice(0, remaining - 3) + '...' : task;
    return buildStyledPanelLine(width, [
      { text: `${label.padEnd(LABEL_W).slice(0, LABEL_W)} `, fg, bold: true },
      { text: trimmed, fg: C.label },
    ]);
  }

  private renderDivider(width: number): Line {
    return buildStyledPanelLine(width, [{ text: '─'.repeat(width), fg: C.separator }]);
  }

}
