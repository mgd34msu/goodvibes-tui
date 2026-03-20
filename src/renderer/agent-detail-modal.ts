import { join } from 'path';
import { readFile } from 'fs/promises';
import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import { AgentManager } from '../tools/agent/index.ts';
import { AgentMessageBus } from '../agents/message-bus.ts';
import { formatDuration } from './modal-utils.ts';
import { logger } from '../utils/logger.ts';

// ─── Constants ────────────────────────────────────────────────────────────────

const TOKENS_PER_TOOL_CALL = 400;
const MAX_LOG_ENTRIES = 10;
const AGENT_ID_DISPLAY_LENGTH = 16;

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

  /** Set a callback to trigger re-render when log data updates. */
  setOnRefresh(fn: () => void): void {
    this.onRefresh = fn;
  }

  open(agentId: string): void {
    this.agentId = agentId;
    this.active = true;
    this.logEntries = [];
    this.logTotal = 0;
    this.loadLog().catch(() => {});
    // Auto-refresh log every 500ms while modal is open
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      this.loadLog().then(() => this.onRefresh?.()).catch(() => {});
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
      const sessionFile = join(process.cwd(), '.goodvibes', 'tui', 'sessions', `${this.agentId}.jsonl`);
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
        logger.debug('AgentDetailModal: failed to load session log', { error: String(err) });
      }
      this.logEntries = [];
      this.logTotal = 0;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Rough token estimate: toolCallCount * avg tokens per tool exchange. */
function estimateTokens(toolCallCount: number): number {
  return toolCallCount * TOKENS_PER_TOOL_CALL;
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
): Line[] {
  if (!modal.agentId) return [];

  const rec = AgentManager.getInstance().getStatus(modal.agentId);
  if (!rec) {
    return ModalFactory.createModal({
      title: 'Agent Detail',
      width: width - 4,
      margin: 2,
      sections: [
        { type: 'text', content: '(agent not found)' },
      ],
      hints: ['[Esc] Close'],
    }, width);
  }

  const now = Date.now();
  const elapsedMs = (rec.completedAt ?? now) - rec.startedAt;
  const tokenEst = estimateTokens(rec.toolCallCount);

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
  sections.push({ type: 'text', content: `Est tokens : ~${tokenEst.toLocaleString()}` });

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
  const recentMessages = AgentMessageBus.getInstance()
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

  return ModalFactory.createModal({
    title: `Agent: ${rec.id.slice(0, AGENT_ID_DISPLAY_LENGTH)}`,
    width: width - 4,
    margin: 2,
    sections,
    hints: ['[Esc] Close'],
  }, width);
}
