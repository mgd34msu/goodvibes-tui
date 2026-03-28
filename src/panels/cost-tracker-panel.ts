// ---------------------------------------------------------------------------
// CostTrackerPanel — per-session / per-agent / per-plan cost estimates
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { EventBus } from '../core/event-bus.ts';
import { getPricingForModel } from '../providers/model-limits.ts';
import { getCostFromCatalog } from '../providers/model-catalog.ts';

// ---------------------------------------------------------------------------
// Pricing table  (USD per 1M tokens)
// ---------------------------------------------------------------------------

interface ModelPricing {
  input: number;
  output: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Free tier
  'openrouter/free': { input: 0, output: 0 },

  // InceptionLabs
  'mercury-2':    { input: 0.50, output: 1.50 },
  'mercury-edit': { input: 0.50, output: 1.50 },

  // OpenAI
  'gpt-5.4':              { input: 5,    output: 15 },
  'gpt-5.3-chat-latest':  { input: 3,    output: 10 },
  'gpt-5-mini':           { input: 0.15, output: 0.60 },
  'gpt-5-nano':           { input: 0.05, output: 0.20 },
  'gpt-oss-120b':         { input: 0,    output: 0 },

  // Anthropic (correct registry IDs)
  'claude-opus-4-6':   { input: 15,   output: 75 },
  'claude-sonnet-4-6': { input: 3,    output: 15 },
  'claude-haiku-4-5':  { input: 0.80, output: 4 },

  // Google
  'gemini-3.1-pro':        { input: 1.25,  output: 5 },
  'gemini-3-flash':        { input: 0.075, output: 0.30 },
  'gemini-3.1-flash-lite': { input: 0.02,  output: 0.10 },
  'gemini-2.5-pro':        { input: 1.25,  output: 5 },
};

/**
 * Look up pricing from the model catalog.
 * Returns { input: 0, output: 0 } for free models and unknown models.
 * Unknown models also emit a debug log to stderr.
 */
function getCostFromCatalogForPanel(modelId: string): ModelPricing {
  return getCostFromCatalog(modelId, { debug: true });
}

function getPricing(modelId: string, provider = ''): ModelPricing {
  // 1. Live OpenRouter pricing (USD per token → convert to per million)
  const livePricing = getPricingForModel(modelId, provider);
  if (livePricing) {
    return {
      input: Math.max(0, livePricing.prompt * 1_000_000),
      output: Math.max(0, livePricing.completion * 1_000_000),
    };
  }
  // 2. Hardcoded table — exact match
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId]!;
  // 3. OpenRouter :free suffix — treat as free
  if (modelId.endsWith(':free')) return { input: 0, output: 0 };
  // 4. Prefix match (e.g. "openrouter/free:..." or "claude-sonnet-4-6-20..")
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelId.startsWith(key) || modelId.includes(key)) return pricing;
  }
  // 5. Catalog lookup — covers models added after hardcoded table was written
  return getCostFromCatalogForPanel(modelId);
}

function calcCost(inputTokens: number, outputTokens: number, pricing: ModelPricing): number {
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

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
const SPARKLINE_BARS = '▁▂▃▄▅▆▇█';
const SPARKLINE_LEN = 16;

function buildSparkline(history: number[]): string {
  if (history.length === 0) return '';
  const max = Math.max(...history);
  if (max === 0) return '▁'.repeat(history.length);
  return history
    .map(v => {
      const idx = Math.round((v / max) * (SPARKLINE_BARS.length - 1));
      return SPARKLINE_BARS[idx] ?? '▁';
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
    bus: EventBus,
    getOrchestratorUsage: () => UsageSnapshot & { model?: string },
    opts: { budgetThreshold?: number } = {},
  ) {
    super('cost', 'Cost', '$', 'monitoring');
    this.getOrchestratorUsage = getOrchestratorUsage;
    this.budgetThreshold = opts.budgetThreshold ?? 0;
    this.attachBus(bus);
  }

  // -------------------------------------------------------------------------
  // Bus wiring
  // -------------------------------------------------------------------------

  private attachBus(bus: EventBus): void {
    // Refresh after every completed turn
    this.unsubs.push(
      bus.on('turn:complete', () => this.onTurnComplete()),
    );

    // Track agent spawns
    this.unsubs.push(
      bus.on('subagent:spawned', ({ id, task }) => {
        this.agents.set(id, {
          id: id.slice(0, 8),
          task: task.length > 40 ? task.slice(0, 37) + '…' : task,
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
      bus.on('subagent:complete', ({ id, result }) => {
        const entry = this.agents.get(id);
        if (entry) {
          entry.status = result.success ? 'done' : 'failed';
          this.markDirty();
        }
      }),
    );

    // Agent error
    this.unsubs.push(
      bus.on('subagent:error', ({ id }) => {
        const entry = this.agents.get(id);
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
    const sessionProvider = this.sessionModel.includes('/') ? this.sessionModel.split('/')[0]! : '';
    const pricing = getPricing(this.sessionModel, sessionProvider);
    const totalCost = calcCost(usage.input + usage.cacheRead + usage.cacheWrite, usage.output, pricing);
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

    const lines: Line[] = [];

    const sessionProvider = this.sessionModel.includes('/') ? this.sessionModel.split('/')[0]! : '';
    const pricing = getPricing(this.sessionModel, sessionProvider);
    const totalInputTokens = this.sessionUsage.input + this.sessionUsage.cacheRead + this.sessionUsage.cacheWrite;
    const sessionCost = calcCost(this.sessionUsage.input + this.sessionUsage.cacheRead + this.sessionUsage.cacheWrite, this.sessionUsage.output, pricing);
    const overBudget = this.budgetThreshold > 0 && sessionCost > this.budgetThreshold;

    // ── Section 1: Running total header ──────────────────────────────────────
    lines.push(this.renderSectionHeader(width, ' SESSION COST'));
    if (lines.length >= height) return lines.slice(0, height);

    // Cost + sparkline row
    const sparkline = buildSparkline(this.costHistory);
    const costStr = formatCost(sessionCost);
    const costFg = overBudget ? C.alert : C.cost;
    const budgetStr = this.budgetThreshold > 0
      ? ` / ${formatCost(this.budgetThreshold)}`
      : '';
    const alertStr = overBudget ? ' ⚠ OVER BUDGET' : '';
    lines.push(this.renderKeyValue(
      width,
      ' Total',
      `${costStr}${budgetStr}${alertStr}`,
      costFg,
    ));
    if (lines.length >= height) return lines.slice(0, height);

    // Sparkline
    if (sparkline.length > 0) {
      lines.push(this.renderLabeledLine(width, ' Trend', sparkline, C.value));
      if (lines.length >= height) return lines.slice(0, height);
    }

    // Token breakdown
    lines.push(this.renderKeyValue(width, ' Input',  formatTokens(this.sessionUsage.input),  C.label));
    if (lines.length >= height) return lines.slice(0, height);
    lines.push(this.renderKeyValue(width, ' Output', formatTokens(this.sessionUsage.output), C.label));
    if (lines.length >= height) return lines.slice(0, height);
    if (this.sessionUsage.cacheRead > 0 || this.sessionUsage.cacheWrite > 0) {
      lines.push(this.renderKeyValue(width, ' Cache↑', formatTokens(this.sessionUsage.cacheWrite), C.dim));
      if (lines.length >= height) return lines.slice(0, height);
      lines.push(this.renderKeyValue(width, ' Cache↓', formatTokens(this.sessionUsage.cacheRead), C.dim));
      if (lines.length >= height) return lines.slice(0, height);
    }
    lines.push(this.renderKeyValue(width, ' Total T', formatTokens(totalInputTokens + this.sessionUsage.output), C.label));
    if (lines.length >= height) return lines.slice(0, height);

    // Model
    lines.push(this.renderKeyValue(width, ' Model', this.sessionModel, C.model));
    if (lines.length >= height) return lines.slice(0, height);

    // ── Section 2: Per-plan cost (sum across all agents) ─────────────────────
    const agentList = Array.from(this.agents.values());
    if (agentList.length > 0) {
      lines.push(this.renderEmpty(width));
      if (lines.length >= height) return lines.slice(0, height);
      lines.push(this.renderSectionHeader(width, ' AGENTS'));
      if (lines.length >= height) return lines.slice(0, height);

      const planCost = agentList.reduce((sum, a) => sum + a.cost, 0);
      lines.push(this.renderKeyValue(width, ' Plan total', formatCost(planCost + sessionCost), C.cost));
      if (lines.length >= height) return lines.slice(0, height);

      lines.push(this.renderDivider(width));
      if (lines.length >= height) return lines.slice(0, height);

      // Scrollable agent list
      const agentStart = Math.min(this.scrollOffset, Math.max(0, agentList.length - 1));
      const visibleAgents = agentList.slice(agentStart);
      for (const agent of visibleAgents) {
        const statusFg = agent.status === 'running' ? C.running
          : agent.status === 'failed' ? C.failed
          : C.done;
        const statusIcon = agent.status === 'running' ? '…'
          : agent.status === 'failed' ? '✗'
          : '✓';

        // Agent header row: icon + id + task truncated
        const agentLabel = `${statusIcon} ${agent.id}`;
        const taskText = agent.task;
        lines.push(this.renderAgent(width, agentLabel, taskText, statusFg));
        if (lines.length >= height) return lines.slice(0, height);

        // Token + cost row (if we have data)
        if (agent.inputTokens > 0 || agent.outputTokens > 0) {
          const tokenInfo = `  in:${formatTokens(agent.inputTokens)} out:${formatTokens(agent.outputTokens)} ${formatCost(agent.cost)}`;
          lines.push(this.renderLabeledLine(width, '', tokenInfo, C.dim));
          if (lines.length >= height) return lines.slice(0, height);
        }
      }
    } else {
      // No agents — show placeholder
      lines.push(this.renderEmpty(width));
      if (lines.length >= height) return lines.slice(0, height);
      lines.push(this.renderDimText(width, ' No agents spawned this session'));
      if (lines.length >= height) return lines.slice(0, height);
    }

    // Pad remainder
    while (lines.length < height) {
      lines.push(createEmptyLine(width));
    }

    return lines.slice(0, height);
  }

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  private renderSectionHeader(width: number, text: string): Line {
    const cells: Line = [];
    const padded = text.padEnd(width);
    for (let i = 0; i < Math.min(padded.length, width); i++) {
      cells.push(createStyledCell(padded[i]!, { fg: C.header, bg: C.separator, bold: true }));
    }
    while (cells.length < width) {
      cells.push(createStyledCell(' ', { fg: '', bg: C.separator }));
    }
    return cells.slice(0, width);
  }

  private renderKeyValue(width: number, label: string, value: string, valueFg: string): Line {
    const cells: Line = [];
    // Label (fixed at 10 chars)
    const LABEL_W = 10;
    const paddedLabel = label.padEnd(LABEL_W).slice(0, LABEL_W);
    for (const ch of paddedLabel) {
      cells.push(createStyledCell(ch, { fg: C.label, bg: C.bg }));
    }
    // Colon separator
    cells.push(createStyledCell(':', { fg: C.dim, bg: C.bg }));
    cells.push(createStyledCell(' ', { fg: '', bg: C.bg }));
    // Value
    const remaining = width - LABEL_W - 2;
    const trimmed = value.length > remaining ? value.slice(0, remaining) : value;
    for (const ch of trimmed) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, { fg: valueFg, bg: C.bg, bold: true }));
    }
    while (cells.length < width) {
      cells.push(createStyledCell(' ', { fg: '', bg: C.bg }));
    }
    return cells.slice(0, width);
  }

  private renderLabeledLine(width: number, label: string, value: string, valueFg: string): Line {
    const cells: Line = [];
    if (label.length > 0) {
      for (const ch of label.slice(0, 10).padEnd(10)) {
        cells.push(createStyledCell(ch, { fg: C.label }));
      }
      cells.push(createStyledCell(' ', { fg: '' }));
    }
    for (const ch of value) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, { fg: valueFg }));
    }
    while (cells.length < width) {
      cells.push(createStyledCell(' ', { fg: '' }));
    }
    return cells.slice(0, width);
  }

  private renderAgent(width: number, label: string, task: string, fg: string): Line {
    const cells: Line = [];
    // label (e.g. "✓ abc12345") — ~12 chars
    const LABEL_W = 12;
    const paddedLabel = label.padEnd(LABEL_W).slice(0, LABEL_W);
    for (const ch of paddedLabel) {
      cells.push(createStyledCell(ch, { fg, bold: true }));
    }
    cells.push(createStyledCell(' ', { fg: '' }));
    // Task text fills remainder
    const remaining = width - LABEL_W - 1;
    const trimmed = task.length > remaining ? task.slice(0, remaining - 1) + '…' : task;
    for (const ch of trimmed) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, { fg: C.label }));
    }
    while (cells.length < width) {
      cells.push(createStyledCell(' ', { fg: '' }));
    }
    return cells.slice(0, width);
  }

  private renderDivider(width: number): Line {
    const cells: Line = [];
    for (let i = 0; i < width; i++) {
      cells.push(createStyledCell('─', { fg: C.separator }));
    }
    return cells;
  }

  private renderEmpty(width: number): Line {
    return createEmptyLine(width);
  }

  private renderDimText(width: number, text: string): Line {
    const cells: Line = [];
    const truncated = text.slice(0, width);
    for (const ch of truncated) {
      cells.push(createStyledCell(ch, { fg: C.dim }));
    }
    while (cells.length < width) {
      cells.push(createStyledCell(' ', { fg: '' }));
    }
    return cells.slice(0, width);
  }
}
