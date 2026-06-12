import { readFile } from 'fs/promises';
import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import type { AgentMessageBus } from '@pellux/goodvibes-sdk/platform/agents';
import type { WrfcController } from '@pellux/goodvibes-sdk/platform/agents';
import { formatDuration } from './modal-utils.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { getOverlaySurfaceMetrics, getStableOverlayContentRows } from './overlay-viewport.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 10;
const AGENT_ID_DISPLAY_LENGTH = 16;

export interface AgentDetailModalDeps {
  readonly agentManager: Pick<AgentManager, 'getStatus'>;
  readonly agentMessageBus: Pick<AgentMessageBus, 'getMessages'>;
  readonly sessionLogPathResolver: (agentId: string) => string;
  /** Optional — when supplied, constraint data from the agent's WRFC chain is shown (SDK 0.23.0). */
  readonly wrfcController?: Pick<WrfcController, 'getChain'>;
}

// ─── AgentDetailModal ─────────────────────────────────────────────────────────

/**
 * AgentDetailModal — deep-view modal for a single running/completed agent.
 *
 * Displays task description, template, model, status, duration, tool-call
 * count, estimated token usage, recent messages from AgentMessageBus, and
 * the agent's current progress note.
 */
export class AgentDetailModal {
  public active = false;
  public agentId: string | null = null;

  /** Cached JSONL log entries, loaded on open(). */
  public logEntries: Record<string, unknown>[] = [];
  public logTotal = 0;

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private onRefresh: (() => void) | null = null;

  constructor(readonly deps: AgentDetailModalDeps) {}

  /** Set a callback to trigger re-render when log data updates. */
  setOnRefresh(fn: () => void): void {
    this.onRefresh = fn;
  }

  open(agentId: string): void {
    this.agentId = agentId;
    this.active = true;
    this.logEntries = [];
    this.logTotal = 0;
    this.loadLog().catch((err) => { logger.debug('agent detail log load failed', { err }); });
    // Auto-refresh log every 500ms while modal is open
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      this.loadLog().then(() => this.onRefresh?.()).catch((err) => { logger.debug('agent detail log refresh tick failed', { err }); });
    }, 500);
  }

  close(): void {
    this.active = false;
    this.agentId = null;
    this.logEntries = [];
    this.logTotal = 0;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async loadLog(): Promise<void> {
    if (!this.agentId) { this.logEntries = []; this.logTotal = 0; return; }
    try {
      const sessionFile = this.deps.sessionLogPathResolver(this.agentId);
      const logContent = await readFile(sessionFile, 'utf-8');
      const logLines = logContent.trim().split('\n');
      this.logTotal = logLines.length;
      const parsed = logLines.slice(-MAX_LOG_ENTRIES).map(line => {
        try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
      });
      const failedCount = parsed.filter(e => e === null).length;
      if (failedCount > 0) {
        logger.debug('AgentDetailModal: skipped malformed JSONL lines', { count: failedCount });
      }
      this.logEntries = parsed.filter((e): e is Record<string, unknown> => e !== null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.debug('AgentDetailModal: failed to load session log', { error: summarizeError(err) });
      }
      this.logEntries = [];
      this.logTotal = 0;
    }
  }
}

// ─── renderAgentDetailModal ───────────────────────────────────────────────────

/**
 * Render the agent detail modal as Line[] for overlay in the viewport.
 *
 * Shows a deep view of the selected agent: task, template, model, status,
 * duration, tool call count, token estimate, recent bus messages, and
 * progress text.
 *
 * @param modal  AgentDetailModal state
 * @param width  Terminal width
 */
export function renderAgentDetailModal(
  modal: AgentDetailModal,
  width: number,
  viewportHeight = 24,
): Line[] {
  if (!modal.agentId) return [];
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    margin: 2,
    maxWidth: width - 4,
    chromeRows: 6,
    minContentRows: 10,
    maxContentRows: 22,
  });
  const targetContentRows = Math.max(18, Math.min(22, getStableOverlayContentRows(metrics.contentRows, 12) + 8));

  const rec = modal.deps.agentManager.getStatus(modal.agentId);
  if (!rec) {
    return ModalFactory.createModal({
      title: 'Agent Detail',
      width: metrics.boxWidth,
      margin: metrics.margin,
      targetContentRows,
      sections: [
        { type: 'text', content: '(agent not found)' },
      ],
      hints: ['[Esc] Close'],
    }, width);
  }

  const now = Date.now();
  const elapsedMs = (rec.completedAt ?? now) - rec.startedAt;

  // ── Build sections ────────────────────────────────────────────────────────

  const sections: import('./modal-factory.ts').ModalSection[] = [];

  // Task — show first line only, capped at 120 chars
  const taskFirstLine = rec.task.split('\n')[0].replace(/^(WRFC\s+(Fix|Review)\s+Request\s*)/i, '').trim();
  const taskDisplay = taskFirstLine.length > 120 ? taskFirstLine.slice(0, 117) + '\u2026' : taskFirstLine;
  sections.push({
    type: 'text',
    content: `Task: ${taskDisplay}`,
    style: { bold: true },
  });
  sections.push({ type: 'separator' });

  // Metadata grid
  const modelStr = rec.model ? `${rec.provider ?? ''}/${rec.model}` : (rec.provider ?? '(default)');
  sections.push({ type: 'text', content: `Template : ${rec.template}` });
  sections.push({ type: 'text', content: `Model    : ${modelStr}` });
  sections.push({ type: 'text', content: `Status   : ${rec.status}` });
  sections.push({ type: 'text', content: `Duration : ${formatDuration(elapsedMs)}` });
  sections.push({ type: 'separator' });

  // Metrics
  sections.push({ type: 'text', content: `Tool calls : ${rec.toolCallCount}` });
  if (rec.usage) {
    const totalIn = rec.usage.inputTokens + (rec.usage.cacheReadTokens ?? 0) + (rec.usage.cacheWriteTokens ?? 0);
    sections.push({ type: 'text', content: `Tokens in  : ${totalIn.toLocaleString()}` });
    sections.push({ type: 'text', content: `Tokens out : ${rec.usage.outputTokens.toLocaleString()}` });
  } else {
    sections.push({
      type: 'text',
      content: 'Tokens     : n/a (agent running)',
      style: { dim: true },
    });
  }

  // SDK 0.23.0: systemPromptAddendum indicator — confirms WRFC constraint addendum was injected
  if (rec.systemPromptAddendum) {
    sections.push({
      type: 'text',
      content: 'Addendum   : yes (WRFC constraint layer injected)',
      style: { fg: '#aaffee' },
    });
  }

  // SDK 0.23.0: constraint data from WRFC chain (engineer constraints + reviewer findings)
  if (rec.wrfcId && modal.deps.wrfcController) {
    try {
      const chain = modal.deps.wrfcController.getChain(rec.wrfcId);
      if (chain && chain.constraints.length > 0) {
        sections.push({ type: 'separator' });
        sections.push({
          type: 'text',
          content: `Constraints (${chain.constraints.length}):`,
          style: { dim: true },
        });
        for (const c of chain.constraints) {
          const text = c.text.length > 80 ? c.text.slice(0, 77) + '…' : c.text;
          sections.push({
            type: 'text',
            content: `  [${c.id}] ${text}`,
            style: { fg: '246' },
          });
        }
        // Reviewer constraint findings (if review has completed)
        const findings = chain.reviewerReport?.constraintFindings;
        if (findings && findings.length > 0) {
          const unsatisfied = findings.filter((f) => !f.satisfied);
          sections.push({
            type: 'text',
            content: `Findings   : ${findings.length} checked, ${unsatisfied.length} unsatisfied`,
            style: { fg: unsatisfied.length > 0 ? '#ff6666' : '#44ff88' },
          });
        }
      }
    } catch {
      // wrfcController.getChain throws when chain not found — normal during teardown
    }
  }

  // Progress
  if (rec.progress) {
    sections.push({ type: 'separator' });
    sections.push({
      type: 'text',
      content: `Progress: ${rec.progress}`,
      style: { fg: '#00ffcc' },
    });
  }

  // Error
  if (rec.error) {
    sections.push({ type: 'separator' });
    sections.push({
      type: 'text',
      content: `Error: ${rec.error}`,
      style: { fg: '#ff6666' },
    });
  }

  // Recent messages from AgentMessageBus
  const recentMessages = modal.deps.agentMessageBus
    .getMessages(modal.agentId)
    .slice(-4); // last 4 messages

  if (recentMessages.length > 0) {
    sections.push({ type: 'separator' });
    sections.push({
      type: 'text',
      content: `Recent messages (${recentMessages.length}):`,
      style: { dim: true },
    });
    for (const msg of recentMessages) {
      const fromLabel = msg.from === '*' ? 'broadcast' : msg.from.slice(0, 12);
      const preview = msg.content.length > 50
        ? msg.content.slice(0, 47) + '\u2026'
        : msg.content;
      sections.push({
        type: 'text',
        content: `  [${fromLabel}] ${preview}`,
        style: { fg: '246' },
      });
    }
  }

  // Execution history from cached JSONL session log (loaded on open())
  if (modal.logEntries.length > 0) {
    sections.push({ type: 'separator' });
    sections.push({
      type: 'text',
      content: `Execution Log (${modal.logTotal} events, showing last ${modal.logEntries.length}):`,
      style: { dim: true },
    });
    for (const entry of modal.logEntries) {
      const entryType = String(entry.type ?? 'unknown');
      const rawTs = entry.timestamp;
      const ts = typeof rawTs === 'string' && rawTs.length >= 19
        ? rawTs.slice(11, 19)
        : '';
      let detail = '';
      if (entryType === 'tool_execution') detail = ` ${entry.toolName}`;
      if (entryType === 'llm_response') detail = ` (${entry.toolCallCount} tools, ${entry.contentLength} chars)`;
      if (entryType === 'session_end') detail = ` [${entry.status}]`;
      sections.push({
        type: 'text',
        content: `  ${ts} ${entryType}${detail}`,
        style: { fg: '246' },
      });
    }
  }

  // Streaming content — show live output when agent is actively streaming
  const STREAMING_MAX_CHARS = 500;
  if (rec.status === 'running' && rec.streamingContent) {
    const content = rec.streamingContent;
    const truncated = content.length > STREAMING_MAX_CHARS;
    const display = truncated ? content.slice(-STREAMING_MAX_CHARS) : content;
    sections.push({ type: 'separator' });
    sections.push({
      type: 'text',
      content: truncated
        ? `Streaming (last ${STREAMING_MAX_CHARS} of ${content.length} chars \u2191 scroll for more):`
        : 'Streaming:',
      style: { fg: '#00ffcc', dim: true },
    });
    // Split into display lines, capped at width for readability
    const maxLineWidth = Math.max(width - 10, 40);
    const streamLines = display.split('\n');
    for (const line of streamLines) {
      const trimmed = line.length > maxLineWidth ? line.slice(0, maxLineWidth - 1) + '\u2026' : line;
      sections.push({
        type: 'text',
        content: `  ${trimmed}`,
        style: { fg: '#aaffee' },
      });
    }
  }

  return ModalFactory.createModal({
    title: `Agent: ${rec.id.slice(0, AGENT_ID_DISPLAY_LENGTH)}`,
    width: metrics.boxWidth,
    margin: metrics.margin,
    targetContentRows,
    sections,
    hints: ['[Esc] Close'],
  }, width);
}
