import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { ProcessManager } from '@pellux/goodvibes-sdk/platform/tools';
import type { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import type { ProcessEntry } from './process-modal.ts';
import { getOverlaySurfaceMetrics, getStableOverlayContentRows } from './overlay-viewport.ts';

export interface LiveTailModalDeps {
  readonly agentManager: Pick<AgentManager, 'cancel' | 'getStatus'>;
  readonly processManager: Pick<ProcessManager, 'stop' | 'getOutput'>;
}

// ─── LiveTailModal ────────────────────────────────────────────────────────────

/**
 * LiveTailModal — manages state for the live output peek modal.
 *
 * Shows streaming stdout/stderr from a selected background process or agent
 * progress notes. Auto-scrolls to the bottom unless the user scrolled up.
 */
export class LiveTailModal {
  public active = false;
  public entry: ProcessEntry | null = null;

  /** Number of lines scrolled up from the bottom (0 = at bottom). */
  public scrollOffset = 0;

  constructor(private readonly deps: LiveTailModalDeps) {}

  open(entry: ProcessEntry): void {
    this.entry = entry;
    this.scrollOffset = 0;
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.entry = null;
    this.scrollOffset = 0;
  }

  scrollUp(): void {
    this.scrollOffset++;
  }

  scrollDown(): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - 1);
  }

  /**
   * Kill the current process.
   * Returns true if the process was found and stopped.
   */
  killProcess(): boolean {
    if (!this.entry) return false;

    if (this.entry.type === 'exec') {
      return this.deps.processManager.stop(this.entry.id);
    } else {
      return this.deps.agentManager.cancel(this.entry.id);
    }
  }

  /** Retrieve the current output text for the watched process. */
  getOutput(): string {
    if (!this.entry) return '';

    if (this.entry.type === 'exec') {
      const out = this.deps.processManager.getOutput(this.entry.id);
      if (!out) return '';
      const combined = [out.stdout, out.stderr].filter(Boolean).join('\n').trim();
      return combined || '(no output yet)';
    } else {
      // For agents, show progress note and status
      const rec = this.deps.agentManager.getStatus(this.entry.id);
      if (!rec) return '(process not found)';
      const parts: string[] = [
        `Task: ${rec.task}`,
        `Status: ${rec.status}`,
        `Tool calls: ${rec.toolCallCount}`,
      ];
      if (rec.progress) parts.push(`Progress: ${rec.progress}`);
      if (rec.error) parts.push(`Error: ${rec.error}`);
      return parts.join('\n');
    }
  }
}

// ─── renderLiveTailModal ──────────────────────────────────────────────────────

/**
 * Render the live-tail peek modal as Line[] for overlay in the viewport.
 *
 * Shows a scrollable view of the process output. scrollOffset=0 means the
 * bottom of the output is visible (auto-scroll behaviour).
 *
 * @param modal  LiveTailModal state
 * @param width  Terminal width
 * @param maxOutputLines  Maximum lines to show inside the box (default: 16)
 */
export function renderLiveTailModal(
  modal: LiveTailModal,
  width: number,
  viewportHeight = 24,
): Line[] {
  const entry = modal.entry;
  if (!entry) return [];
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    chromeRows: 4,
    minContentRows: 6,
    maxContentRows: 10,
  });
  const maxOutputLines = metrics.contentRows;
  const targetContentRows = getStableOverlayContentRows(metrics.contentRows, 8);

  const output = modal.getOutput();
  const allLines = output.split('\n');

  // Apply scroll: scrollOffset=0 → show tail; larger → scroll toward head
  const totalLines = allLines.length;
  // Clamp scrollOffset so we never scroll past the top of the content
  const maxScroll = Math.max(0, totalLines - maxOutputLines);
  const clampedOffset = Math.min(modal.scrollOffset, maxScroll);
  const endIdx = Math.max(maxOutputLines, totalLines - clampedOffset);
  const startIdx = Math.max(0, endIdx - maxOutputLines);
  const visibleLines = allLines.slice(startIdx, endIdx);

  const typeTag = entry.type === 'agent' ? '[agent]' : '[exec]';
  const maxLabelW = Math.max(20, width - 30);
  const title = `${typeTag} ${entry.label.slice(0, maxLabelW)}`;

  // Build scroll indicator for text section header
  const scrollInfo = totalLines > maxOutputLines
    ? `  Lines ${startIdx + 1}-${Math.min(endIdx, totalLines)} of ${totalLines}  [Up/Down] Scroll`
    : '';

  const contentText = visibleLines.join('\n') || '(no output yet)';

  const sections: import('./modal-factory.ts').ModalSection[] = [];

  if (scrollInfo) {
    sections.push({ type: 'text', content: scrollInfo });
    sections.push({ type: 'separator' });
  }

  sections.push({ type: 'text', content: contentText });

  return ModalFactory.createModal({
    title,
    width: metrics.boxWidth,
    margin: 2,
    targetContentRows,
    sections,
    hints: ['[Up/Down] Scroll', '[k] Kill', '[Esc] Back'],
  }, width);
}
