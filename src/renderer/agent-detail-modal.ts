import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import { AgentManager } from '../tools/agent/index.ts';
import { AgentMessageBus } from '../agents/message-bus.ts';

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

  open(agentId: string): void {
    this.agentId = agentId;
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.agentId = null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format elapsed milliseconds as a compact duration string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m${remSecs}s`;
}

/** Rough token estimate: toolCallCount * avg tokens per tool exchange. */
function estimateTokens(toolCallCount: number): number {
  return toolCallCount * 400;
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
      width: 76,
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

  // Task
  sections.push({
    type: 'text',
    content: `Task: ${rec.task}`,
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

  return ModalFactory.createModal({
    title: `Agent: ${rec.id.slice(0, 16)}`,
    width: 76,
    margin: 2,
    sections,
    hints: ['[Esc] Close'],
  }, width);
}
