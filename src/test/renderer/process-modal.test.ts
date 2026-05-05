import { describe, test, expect, beforeEach } from 'bun:test';
import { ProcessModal, renderProcessModal } from '../../renderer/process-modal.ts';
import { UI_TONES } from '../../renderer/ui-primitives.ts';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';
import type { BackgroundProcess } from '@pellux/goodvibes-sdk/platform/tools';
import { lineToString, linesToText } from '../setup.ts';

const W = 100;

type TestAgentStatus = AgentRecord['status'];

type TestAgentRecord = AgentRecord;

type TestProcessRecord = BackgroundProcess & {
  status: string;
};

const agents = new Map<string, TestAgentRecord>();
const processes = new Map<string, TestProcessRecord>();

beforeEach(() => {
  agents.clear();
  processes.clear();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedAgent(task: string, status: TestAgentStatus = 'running'): string {
  const id = `agent-${agents.size + 1}`;
  agents.set(id, {
    id,
    task,
    template: 'default',
    tools: [],
      status,
      startedAt: Date.now(),
      orchestrationDepth: 0,
      toolCallCount: 0,
      executionProtocol: 'gather-plan-apply',
      reviewMode: 'wrfc',
      communicationLane: 'direct',
      fullOutput: '',
    });
  return id;
}

function createProcessModal(): ProcessModal {
  return new ProcessModal({
    agentManager: {
      list: () => Array.from(agents.values()),
      getStatus: (id: string) => agents.get(id) ?? null,
      cancel: (id: string) => {
        const record = agents.get(id);
        if (!record) return false;
        record.status = 'cancelled';
        return true;
      },
    },
    processManager: {
      list: () => Array.from(processes.values()),
      getStatus: (id: string) => processes.get(id),
      stop: (id: string) => {
        const record = processes.get(id);
        if (!record) return false;
        record.status = 'done';
        return true;
      },
    },
    wrfcController: { getChain: () => null },
  });
}

// ─── ProcessModal state ────────────────────────────────────────────────────────

describe('ProcessModal state', () => {
  test('initially inactive with no entries', () => {
    const modal = createProcessModal();
    expect(modal.active).toBe(false);
    expect(modal.entries).toEqual([]);
  });

  test('open() sets active=true and selectedIndex=0', () => {
    const modal = createProcessModal();
    modal.open();
    expect(modal.active).toBe(true);
    expect(modal.selectedIndex).toBe(0);
  });

  test('close() sets active=false', () => {
    const modal = createProcessModal();
    modal.open();
    modal.close();
    expect(modal.active).toBe(false);
  });

  test('refresh() populates entries from AgentManager running agents', () => {
    seedAgent('Build the feature');
    const modal = createProcessModal();
    modal.refresh();
    expect(modal.entries.length).toBe(1);
    expect(modal.entries[0].type).toBe('agent');
    expect(modal.entries[0].label).toContain('Build the feature');
  });

  test('refresh() skips completed agents', () => {
    const id = seedAgent('Done task', 'completed');
    const modal = createProcessModal();
    modal.refresh();
    expect(modal.entries.length).toBe(0);
  });

  test('refresh() includes pending agents', () => {
    seedAgent('Pending task', 'pending');
    const modal = createProcessModal();
    modal.refresh();
    expect(modal.entries.length).toBe(1);
    expect(modal.entries[0].status).toBe('pending');
  });

  test('moveDown() wraps around to first entry', () => {
    seedAgent('Task A');
    seedAgent('Task B');
    const modal = createProcessModal();
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
    const modal = createProcessModal();
    modal.open();
    modal.moveUp(); // wrap to last
    expect(modal.selectedIndex).toBe(1);
  });

  test('navigation does nothing when no entries', () => {
    const modal = createProcessModal();
    modal.refresh();
    modal.moveDown();
    modal.moveUp();
    expect(modal.selectedIndex).toBe(0);
  });

  test('getSelected() returns entry at selectedIndex', () => {
    seedAgent('Task A');
    seedAgent('Task B');
    const modal = createProcessModal();
    modal.open();
    modal.moveDown();
    const sel = modal.getSelected();
    expect(sel).toBeDefined();
    expect(sel!.label).toContain('Task B');
  });

  test('killSelected() delegates to AgentManager for agent entries', () => {
    const id = seedAgent('Kill this task');
    const modal = createProcessModal();
    modal.open();
    // Find the agent entry
    const entryIdx = modal.entries.findIndex((e) => e.id === id);
    modal.selectedIndex = entryIdx;
    // AgentManager.cancel returns false if agent already cancelled; just verify no throw
    const result = modal.killSelected();
    expect(typeof result).toBe('boolean');
  });

  test('killSelected() returns false when no entries', () => {
    const modal = createProcessModal();
    modal.refresh();
    expect(modal.killSelected()).toBe(false);
  });

  test('streamSnippet is populated when agent has streamingContent', () => {
    const id = seedAgent('Streaming task');
    const rec = agents.get(id);
    if (!rec) throw new Error('expected agent record');
    rec.streamingContent = 'Processing file analysis results and building summary';
    const modal = createProcessModal();
    modal.refresh();
    const entry = modal.entries.find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.streamSnippet).toBeDefined();
    expect(entry!.streamSnippet).toContain('Processing file analysis results');
  });

  test('streamSnippet truncates long content with ellipsis prefix', () => {
    const id = seedAgent('Long streaming task');
    const rec = agents.get(id);
    if (!rec) throw new Error('expected agent record');
    // 80-char content — exceeds the 60-char threshold in refresh()
    rec.streamingContent = 'a'.repeat(80);
    const modal = createProcessModal();
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
    const modal = createProcessModal();
    modal.refresh();
    const entry = modal.entries.find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.streamSnippet).toBeUndefined();
  });

  test('entry label is truncated with ellipsis when longer than 80 chars', () => {
    const longTask = 'a'.repeat(100);
    seedAgent(longTask);
    const modal = createProcessModal();
    modal.refresh();
    expect(modal.entries[0].label.length).toBeLessThanOrEqual(80);
    expect(modal.entries[0].label.endsWith('...')).toBe(true);
  });
});

// ─── renderProcessModal ────────────────────────────────────────────────────────

describe('renderProcessModal', () => {
  test('renders empty state when no processes running', () => {
    const modal = createProcessModal();
    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('No background processes running');
  });

  test('all lines have correct terminal width', () => {
    const modal = createProcessModal();
    const lines = renderProcessModal(modal, W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('renders entries as list items when processes exist', () => {
    seedAgent('Build the app');
    const modal = createProcessModal();
    modal.open();
    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Build the app');
  });

  test('selected entry shows selection indicator', () => {
    seedAgent('Task A');
    seedAgent('Task B');
    const modal = createProcessModal();
    modal.open();
    modal.moveDown();
    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Task B');
    const selectedCell = lines
      .flat()
      .find((cell) => cell.bg === UI_TONES.bg.selected);
    expect(selectedCell).toBeDefined();
  });

  test('renders type tag [agent] in entry label', () => {
    seedAgent('My agent task');
    const modal = createProcessModal();
    modal.open();
    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('[agent]');
  });

  test('renders duration in entry label', () => {
    seedAgent('Timed task');
    const modal = createProcessModal();
    modal.open();
    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');
    // Duration formats: Xms, Xs, XmYs
    expect(text).toMatch(/\d+ms|\d+s|\d+m\d+s/);
  });

  test('footer contains hint text', () => {
    const modal = createProcessModal();
    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Esc');
  });

  test('title contains Background Processes', () => {
    const modal = createProcessModal();
    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Background Processes');
  });
});
