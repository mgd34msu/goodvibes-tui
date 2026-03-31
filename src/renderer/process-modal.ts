import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import { formatDuration } from './modal-utils.ts';
import { ProcessManager } from '../tools/shared/process-manager.ts';
import { AgentManager, type AgentRecord } from '../tools/agent/index.ts';
import { WrfcController } from '../agents/wrfc-controller.ts';

// ─── ProcessEntry ─────────────────────────────────────────────────────────────

export interface ProcessEntry {
  /** Unique process identifier */
  id: string;
  /** Display label (agent task or exec command) */
  label: string;
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
/** Columns subtracted from terminal width to derive the dynamic label width. */
const LABEL_WIDTH_SUBTRACT = 40;
/** Fixed-width columns reserved for status, duration, and padding in the process list row. */
const STATUS_COLUMNS_WIDTH = 25;
/** Border and margin width subtracted from terminal width to get modal content width. */
const MODAL_BORDER_WIDTH = 8;
/** Minimum width for the dynamic process label column. */
const MIN_LABEL_WIDTH = 20;

/** Build a display label for an agent based on its task and template. */
function buildAgentLabel(rec: AgentRecord): string {
  const task = rec.task;

  // Look up the original task from the WRFC chain if available
  const originalTask = getChainTask(rec.wrfcId);

  // WRFC Review agent
  if (task.startsWith('WRFC Review Request')) {
    const thresholdMatch = task.match(/threshold is (\d+(?:\.\d+)?)/);
    const threshold = thresholdMatch ? thresholdMatch[1] : '9.9';
    const desc = truncateFirst(originalTask ?? 'review in progress', 50);
    return `[Review] ${desc}  (target: ${threshold}/10)`;
  }

  // WRFC Fix agent
  if (task.startsWith('WRFC Fix Request')) {
    const scoreMatch = task.match(/Review score:\s*(\d+(?:\.\d+)?)\/(\d+)\s*\(threshold:\s*(\d+(?:\.\d+)?)/);
    const fromScore = scoreMatch ? scoreMatch[1] : '?';
    const toScore = scoreMatch ? scoreMatch[3] : '?';
    const attemptMatch = task.match(/Fix attempt:\s*(\d+)/);
    const attempt = attemptMatch ? attemptMatch[1] : '?';
    const desc = truncateFirst(originalTask ?? 'fix in progress', 45);
    return `[Fix #${attempt}] ${desc}  (${fromScore} \u2192 ${toScore}/10)`;
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

/** Get the original task description from a WRFC chain. */
function getChainTask(wrfcId: string | undefined): string | null {
  if (!wrfcId) return null;
  try {
    const chain = WrfcController.getInstance().getChain(wrfcId);
    return chain?.task ?? null;
  } catch { return null; }
}

/** Truncate to first line, capped at max chars. */
function truncateFirst(text: string, max: number): string {
  const line = text.split('\n')[0].trim();
  return line.length > max ? line.slice(0, max - 1) + '\u2026' : line;
}

/** Truncate a command string to first line, capped at MAX_LABEL_LENGTH. */
function truncateCmd(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length > MAX_LABEL_LENGTH) return firstLine.slice(0, MAX_LABEL_LENGTH - 3) + '\u2026';
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

  /** Rebuild entries from live singletons. */
  refresh(): void {
    const manager = AgentManager.getInstance();
    if (typeof manager?.list !== 'function') return; // Guard against test mock pollution
    const now = Date.now();
    const result: ProcessEntry[] = [];

    // Agents — only show active (pending/running)
    for (const a of manager.list()) {
      if (a.status === 'completed' || a.status === 'failed' || a.status === 'cancelled') continue;
      let streamSnippet: string | undefined;
      if (a.streamingContent) {
        const raw = a.streamingContent.replace(/\n/g, ' ').trim();
        streamSnippet = raw.length > 60 ? '...' + raw.slice(-57) : raw;
      }
      result.push({
        id: a.id,
        label: buildAgentLabel(a),
        type: 'agent',
        status: a.status,
        elapsedMs: now - a.startedAt,
        streamSnippet,
      });
    }

    // Background exec processes — only show running
    const pm = ProcessManager.getInstance();
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
      return ProcessManager.getInstance().stop(entry.id);
    } else {
      return AgentManager.getInstance().cancel(entry.id);
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
export function renderProcessModal(modal: ProcessModal, width: number): Line[] {
  modal.refresh();

  const modalContentW = Math.max(4, width - MODAL_BORDER_WIDTH); // borders + margin
  const dynamicLabelW = Math.min(Math.max(MIN_LABEL_WIDTH, width - LABEL_WIDTH_SUBTRACT), modalContentW - STATUS_COLUMNS_WIDTH);

  if (modal.entries.length === 0) {
    return ModalFactory.createModal({
      title: 'Background Processes',
      width: width - 4,
      margin: 2,
      sections: [
        { type: 'text', content: 'No background processes running.' },
      ],
      hints: ['[Esc] Close'],
    }, width);
  }

  const maxLabelW = Math.max(10, (width - 4) - 8); // modal content minus borders/padding

  const items = modal.entries.map((e, i) => {
    const statusIcon = {
      running: '\u25cf',
      pending: '\u25cb',
      completed: '\u2713',
      failed: '\u2717',
      cancelled: '\u2298',
    }[e.status] ?? '\u25cf';
    const typeTag = e.type === 'agent' ? '[agent]' : '[exec]';
    const dur = formatDuration(e.elapsedMs);
    const statusStr = e.streamSnippet ? `streaming  ${dur}` : `${e.status}  ${dur}`;
    const suffix = `  ${statusStr}`;
    const maxDescW = maxLabelW - typeTag.length - suffix.length - 4; // icon + spaces
    const desc = e.label.length > maxDescW ? e.label.slice(0, maxDescW - 1) + '\u2026' : e.label;
    const label = `${statusIcon} ${typeTag} ${desc}${suffix}`;
    return {
      label,
      selected: i === modal.selectedIndex,
    };
  });

  return ModalFactory.createModal({
    title: 'Background Processes',
    width: width - 4,
    margin: 2,
    sections: [
      { type: 'list', items },
    ],
    hints: ['[↑↓] Navigate', '[Enter] Peek output', '[k] Kill', '[Esc] Close'],
  }, width);
}
