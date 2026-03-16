import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
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
/** Maximum characters of the label rendered in the process list modal row. */
const RENDER_LABEL_WIDTH = 44;

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
      if (a.status === 'running' || a.status === 'pending') {
        result.push({
          id: a.id,
          label: a.task.length > MAX_LABEL_LENGTH ? a.task.slice(0, MAX_LABEL_LENGTH - 3) + '\u2026' : a.task,
          type: 'agent',
          status: a.status,
          elapsedMs: now - a.startedAt,
        });
      }
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

/** Format elapsed milliseconds as a compact duration string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m${remSecs}s`;
}

/**
 * Render the process list modal as Line[] for overlay in the viewport.
 *
 * @param modal  ProcessModal state
 * @param width  Terminal width
 */
export function renderProcessModal(modal: ProcessModal, width: number): Line[] {
  modal.refresh();

  if (modal.entries.length === 0) {
    return ModalFactory.createModal({
      title: 'Background Processes',
      width: 72,
      margin: 4,
      sections: [
        { type: 'text', content: 'No background processes running.' },
      ],
      hints: ['[Esc] Close'],
    }, width);
  }

  const items = modal.entries.map((e, i) => {
    const typeTag = e.type === 'agent' ? '[agent]' : '[exec]';
    const dur = formatDuration(e.elapsedMs);
    const label = `${typeTag} ${e.label.slice(0, RENDER_LABEL_WIDTH)}  ${e.status}  ${dur}`;
    return {
      label,
      selected: i === modal.selectedIndex,
    };
  });

  return ModalFactory.createModal({
    title: 'Background Processes',
    width: 72,
    margin: 4,
    sections: [
      { type: 'list', items },
    ],
    hints: ['[↑↓] Navigate', '[Enter] Peek output', '[k] Kill', '[Esc] Close'],
  }, width);
}
