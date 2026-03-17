import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import { formatDuration } from './modal-utils.ts';
import { ProcessManager } from '../tools/shared/process-manager.ts';
import { AgentManager } from '../tools/agent/index.ts';

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

  open(): void {
    this.refresh();
    this.active = true;
    this.selectedIndex = 0;
  }

  close(): void {
    this.active = false;
  }

  /** Rebuild entries from live singletons. */
  refresh(): void {
    const now = Date.now();
    const result: ProcessEntry[] = [];

    // Agents
    for (const a of AgentManager.getInstance().list()) {
      result.push({
        id: a.id,
        label: a.task.length > MAX_LABEL_LENGTH ? a.task.slice(0, MAX_LABEL_LENGTH - 3) + '\u2026' : a.task,
        type: 'agent',
        status: a.status,
        elapsedMs: now - a.startedAt,
      });
    }

    // Background exec processes
    const pm = ProcessManager.getInstance();
    for (const p of pm.list()) {
      const startTime = pm.getStatus(p.id)?.startTime ?? now;
      result.push({
        id: p.id,
        label: p.cmd.length > MAX_LABEL_LENGTH ? p.cmd.slice(0, MAX_LABEL_LENGTH - 3) + '\u2026' : p.cmd,
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
    const label = `${statusIcon} ${typeTag} ${e.label.slice(0, dynamicLabelW)}  ${e.status}  ${dur}`;
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
