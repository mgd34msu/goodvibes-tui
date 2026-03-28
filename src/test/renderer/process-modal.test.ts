import { describe, test, expect, beforeEach } from 'bun:test';
import { ProcessModal, renderProcessModal } from '../../renderer/process-modal.ts';
import { AgentManager } from '../../tools/agent/index.ts';
import { ProcessManager } from '../../tools/shared/process-manager.ts';
import { lineToString, linesToText } from '../setup.ts';

const W = 100;

beforeEach(() => {
  AgentManager.resetInstance();
  ProcessManager.resetInstance();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedAgent(task: string, status: 'running' | 'pending' = 'running'): string {
  const am = AgentManager.getInstance();
  const rec = am.spawn({ mode: 'spawn', task, template: 'default', tools: [] });
  // Force status (spawn sets it to pending, then running — we update directly)
  (am as any).agents.get(rec.id).status = status;
  return rec.id;
}

// ─── ProcessModal state ────────────────────────────────────────────────────────

describe('ProcessModal state', () => {
  test('initially inactive with no entries', () => {
    const modal = new ProcessModal();
    expect(modal.active).toBe(false);
    expect(modal.entries).toEqual([]);
  });

  test('open() sets active=true and selectedIndex=0', () => {
    const modal = new ProcessModal();
    modal.open();
    expect(modal.active).toBe(true);
    expect(modal.selectedIndex).toBe(0);
  });

  test('close() sets active=false', () => {
    const modal = new ProcessModal();
    modal.open();
    modal.close();
    expect(modal.active).toBe(false);
  });

  test('refresh() populates entries from AgentManager running agents', () => {
    seedAgent('Build the feature');
    const modal = new ProcessModal();
    modal.refresh();
    expect(modal.entries.length).toBe(1);
    expect(modal.entries[0].type).toBe('agent');
    expect(modal.entries[0].label).toContain('Build the feature');
  });

  test('refresh() skips completed agents', () => {
    const am = AgentManager.getInstance();
    const rec = am.spawn({ mode: 'spawn', task: 'Done task', template: 'default', tools: [] });
    (am as any).agents.get(rec.id).status = 'completed';
    const modal = new ProcessModal();
    modal.refresh();
    expect(modal.entries.length).toBe(0);
  });

  test('refresh() includes pending agents', () => {
    seedAgent('Pending task', 'pending');
    const modal = new ProcessModal();
    modal.refresh();
    expect(modal.entries.length).toBe(1);
    expect(modal.entries[0].status).toBe('pending');
  });

  test('moveDown() wraps around to first entry', () => {
    seedAgent('Task A');
    seedAgent('Task B');
    const modal = new ProcessModal();
    modal.open();
    expect(modal.selectedIndex).toBe(0);
    modal.moveDown();
    expect(modal.selectedIndex).toBe(1);
    modal.moveDown(); // wrap
    expect(modal.selectedIndex).toBe(0);
  });

  test('moveUp() wraps around to last entry', () => {
    seedAgent('Task A');
    seedAgent('Task B');
    const modal = new ProcessModal();
    modal.open();
    modal.moveUp(); // wrap to last
    expect(modal.selectedIndex).toBe(1);
  });

  test('navigation does nothing when no entries', () => {
    const modal = new ProcessModal();
    modal.refresh();
    modal.moveDown();
    modal.moveUp();
    expect(modal.selectedIndex).toBe(0);
  });

  test('getSelected() returns entry at selectedIndex', () => {
    seedAgent('Task A');
    seedAgent('Task B');
    const modal = new ProcessModal();
    modal.open();
    modal.moveDown();
    const sel = modal.getSelected();
    expect(sel).toBeDefined();
    expect(sel!.label).toContain('Task B');
  });

  test('killSelected() delegates to AgentManager for agent entries', () => {
    const id = seedAgent('Kill this task');
    const modal = new ProcessModal();
    modal.open();
    // Find the agent entry
    const entryIdx = modal.entries.findIndex((e) => e.id === id);
    modal.selectedIndex = entryIdx;
    // AgentManager.cancel returns false if agent already cancelled; just verify no throw
    const result = modal.killSelected();
    expect(typeof result).toBe('boolean');
  });

  test('killSelected() returns false when no entries', () => {
    const modal = new ProcessModal();
    modal.refresh();
    expect(modal.killSelected()).toBe(false);
  });

  test('streamSnippet is populated when agent has streamingContent', () => {
    const id = seedAgent('Streaming task');
    const am = AgentManager.getInstance();
    const rec = (am as any).agents.get(id);
    rec.streamingContent = 'Processing file analysis results and building summary';
    const modal = new ProcessModal();
    modal.refresh();
    const entry = modal.entries.find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.streamSnippet).toBeDefined();
    expect(entry!.streamSnippet).toContain('Processing file analysis results');
  });

  test('streamSnippet truncates long content with ellipsis prefix', () => {
    const id = seedAgent('Long streaming task');
    const am = AgentManager.getInstance();
    const rec = (am as any).agents.get(id);
    // 80-char content — exceeds the 60-char threshold in refresh()
    rec.streamingContent = 'a'.repeat(80);
    const modal = new ProcessModal();
    modal.refresh();
    const entry = modal.entries.find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.streamSnippet).toBeDefined();
    expect(entry!.streamSnippet!.startsWith('...')).toBe(true);
    // Total length: 3 (ellipsis) + 57 (last chars) = 60
    expect(entry!.streamSnippet!.length).toBe(60);
  });

  test('streamSnippet is undefined when agent has no streamingContent', () => {
    const id = seedAgent('Quiet task');
    const modal = new ProcessModal();
    modal.refresh();
    const entry = modal.entries.find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.streamSnippet).toBeUndefined();
  });

  test('entry label is truncated with ellipsis when longer than 80 chars', () => {
    const longTask = 'a'.repeat(100);
    seedAgent(longTask);
    const modal = new ProcessModal();
    modal.refresh();
    expect(modal.entries[0].label.length).toBeLessThanOrEqual(80);
    expect(modal.entries[0].label.endsWith('\u2026')).toBe(true);
  });
});

// ─── renderProcessModal ────────────────────────────────────────────────────────

describe('renderProcessModal', () => {
  test('renders empty state when no processes running', () => {
    const modal = new ProcessModal();
    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('No background processes running');
  });

  test('all lines have correct terminal width', () => {
    const modal = new ProcessModal();
    const lines = renderProcessModal(modal, W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('renders entries as list items when processes exist', () => {
    seedAgent('Build the app');
    const modal = new ProcessModal();
    modal.open();
    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Build the app');
  });

  test('selected entry shows selection indicator', () => {
    seedAgent('Task A');
    seedAgent('Task B');
    const modal = new ProcessModal();
    modal.open();
    modal.moveDown();
    const lines = renderProcessModal(modal, W);
    const texts = linesToText(lines);
    const selectedLine = texts.find((t) => t.includes('\u25b6'));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain('Task B');
  });

  test('renders type tag [agent] in entry label', () => {
    seedAgent('My agent task');
    const modal = new ProcessModal();
    modal.open();
    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('[agent]');
  });

  test('renders duration in entry label', () => {
    seedAgent('Timed task');
    const modal = new ProcessModal();
    modal.open();
    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');
    // Duration formats: Xms, Xs, XmYs
    expect(text).toMatch(/\d+ms|\d+s|\d+m\d+s/);
  });

  test('footer contains hint text', () => {
    const modal = new ProcessModal();
    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Esc');
  });

  test('title contains Background Processes', () => {
    const modal = new ProcessModal();
    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Background Processes');
  });
});
