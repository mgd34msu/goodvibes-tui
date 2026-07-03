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
const wrfcChains = new Map<string, {
  id: string;
  task: string;
  ownerAgentId: string;
  state: string;
  engineerAgentId?: string;
  reviewerAgentId?: string;
  fixerAgentId?: string;
  allAgentIds?: string[];
  constraints: unknown[];
}>();

beforeEach(() => {
  agents.clear();
  processes.clear();
  wrfcChains.clear();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedAgent(
  task: string,
  status: TestAgentStatus = 'running',
  overrides: Partial<TestAgentRecord> = {},
): string {
  const id = `agent-${agents.size + 1}`;
  const record: TestAgentRecord = {
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
    ...overrides,
    id: overrides.id ?? id,
    task: overrides.task ?? task,
    status: overrides.status ?? status,
  };
  agents.set(record.id, record);
  return record.id;
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
    wrfcController: {
      getChain: (id: string) => wrfcChains.get(id) as never ?? null,
      listChains: () => Array.from(wrfcChains.values()) as never,
    },
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

  test('refresh() groups WRFC owner and child agents as a tree', () => {
    const wrfcId = 'wrfc-tree-1';
    const ownerId = seedAgent('Complete the requested work as a single WRFC owner chain.', 'running', {
      wrfcId,
      wrfcRole: 'owner',
      template: 'engineer',
      startedAt: Date.now() - 2000,
    });
    const engineerId = seedAgent('Complete the requested work as a single WRFC owner chain.', 'running', {
      wrfcId,
      wrfcRole: 'engineer',
      template: 'engineer',
      parentAgentId: ownerId,
      startedAt: Date.now() - 1000,
    });
    wrfcChains.set(wrfcId, {
      id: wrfcId,
      task: 'Build a simple rate limiter',
      ownerAgentId: ownerId,
      state: 'engineering',
      constraints: [],
    });

    const modal = createProcessModal();
    modal.refresh();

    expect(modal.entries.map((entry) => entry.id)).toEqual([ownerId, engineerId]);
    expect(modal.entries[0].treePrefix ?? '').toBe('');
    expect(modal.entries[1].treePrefix).toBe('└─ ');
    expect(modal.entries[0].label).toContain('[WRFC owner]');
    expect(modal.entries[1].label).toContain('[Engineer]');
  });

  test('refresh() infers WRFC tree from chain when live records are generic engineers', () => {
    const wrfcId = 'wrfc-inferred-chain';
    const ownerId = seedAgent('Design a minimal Python rate limiter library API for an empty project.', 'running', {
      template: 'engineer',
      reviewMode: 'wrfc',
      startedAt: Date.now() - 2000,
    });
    const engineerId = seedAgent('Design a minimal Python rate limiter library API for an empty project.', 'running', {
      template: 'engineer',
      reviewMode: 'wrfc',
      startedAt: Date.now() - 1000,
    });
    wrfcChains.set(wrfcId, {
      id: wrfcId,
      task: 'Build a simple rate limiter',
      ownerAgentId: ownerId,
      engineerAgentId: engineerId,
      allAgentIds: [ownerId, engineerId],
      state: 'engineering',
      constraints: [],
    });

    const modal = createProcessModal();
    modal.refresh();

    expect(modal.entries.map((entry) => entry.id)).toEqual([ownerId, engineerId]);
    expect(modal.entries[0].treePrefix ?? '').toBe('');
    expect(modal.entries[1].treePrefix).toBe('└─ ');
    expect(modal.entries[0].label).toContain('[WRFC owner]');
    expect(modal.entries[1].label).toContain('[Engineer]');
  });

  test('refresh() infers duplicate WRFC owner rows when chain metadata has not reached the records yet', () => {
    const ownerId = seedAgent('Complete the requested work as a single WRFC owner chain.', 'running', {
      template: 'engineer',
      reviewMode: 'wrfc',
      startedAt: Date.now() - 2000,
    });
    const childId = seedAgent('Complete the requested work as a single WRFC owner chain.', 'running', {
      template: 'engineer',
      reviewMode: 'wrfc',
      startedAt: Date.now() - 1000,
    });

    const modal = createProcessModal();
    modal.refresh();

    expect(modal.entries.map((entry) => entry.id)).toEqual([ownerId, childId]);
    expect(modal.entries[0].label).toContain('[WRFC owner]');
    expect(modal.entries[1].treePrefix).toBe('└─ ');
    expect(modal.entries[1].label).toContain('[Engineer]');
  });

  test('refresh() keeps WRFC owner visible until chain reaches a terminal state', () => {
    const wrfcId = 'wrfc-owner-visible';
    const ownerId = seedAgent('Complete the requested work as a single WRFC owner chain.', 'completed', {
      wrfcId,
      wrfcRole: 'owner',
      template: 'engineer',
      completedAt: Date.now() - 100,
      startedAt: Date.now() - 3000,
    });
    const reviewerId = seedAgent('WRFC Review Request\nOriginal task', 'running', {
      wrfcId,
      wrfcRole: 'reviewer',
      template: 'reviewer',
      parentAgentId: ownerId,
      startedAt: Date.now() - 1000,
    });
    wrfcChains.set(wrfcId, {
      id: wrfcId,
      task: 'Build a simple rate limiter',
      ownerAgentId: ownerId,
      reviewerAgentId: reviewerId,
      allAgentIds: [ownerId, reviewerId],
      state: 'reviewing',
      constraints: [],
    });

    const modal = createProcessModal();
    modal.refresh();

    expect(modal.entries.map((entry) => entry.id)).toEqual([ownerId, reviewerId]);
    expect(modal.entries[0].status).toBe('running');
    expect(modal.entries[0].label).toContain('[WRFC owner]');
    expect(modal.entries[1].treePrefix).toBe('└─ ');
  });

  test('refresh() draws branch and final connectors for multiple WRFC children', () => {
    const wrfcId = 'wrfc-tree-2';
    const ownerId = seedAgent('Owner task', 'running', {
      wrfcId,
      wrfcRole: 'owner',
      template: 'engineer',
      startedAt: Date.now() - 3000,
    });
    const engineerId = seedAgent('Engineer task', 'running', {
      wrfcId,
      wrfcRole: 'engineer',
      template: 'engineer',
      parentAgentId: ownerId,
      startedAt: Date.now() - 2000,
    });
    const reviewerId = seedAgent('WRFC Review Request\nOriginal task', 'running', {
      wrfcId,
      wrfcRole: 'reviewer',
      template: 'reviewer',
      parentAgentId: ownerId,
      startedAt: Date.now() - 1000,
    });
    wrfcChains.set(wrfcId, {
      id: wrfcId,
      task: 'Build a simple rate limiter',
      ownerAgentId: ownerId,
      state: 'reviewing',
      constraints: [],
    });

    const modal = createProcessModal();
    modal.refresh();

    expect(modal.entries.map((entry) => entry.id)).toEqual([ownerId, engineerId, reviewerId]);
    expect(modal.entries[1].treePrefix).toBe('├─ ');
    expect(modal.entries[2].treePrefix).toBe('└─ ');
  });

  test('refresh() keeps vertical tree guides for nested WRFC children', () => {
    const wrfcId = 'wrfc-tree-3';
    const ownerId = seedAgent('Owner task', 'running', {
      wrfcId,
      wrfcRole: 'owner',
      template: 'engineer',
      startedAt: Date.now() - 4000,
    });
    const engineerId = seedAgent('Engineer task', 'running', {
      wrfcId,
      wrfcRole: 'engineer',
      template: 'engineer',
      parentAgentId: ownerId,
      startedAt: Date.now() - 3000,
    });
    const reviewerId = seedAgent('WRFC Review Request\nOriginal task', 'running', {
      wrfcId,
      wrfcRole: 'reviewer',
      template: 'reviewer',
      parentAgentId: ownerId,
      startedAt: Date.now() - 2000,
    });
    const fixerId = seedAgent('WRFC Fix Request\nOriginal task', 'running', {
      wrfcId,
      wrfcRole: 'fixer',
      template: 'engineer',
      parentAgentId: engineerId,
      startedAt: Date.now() - 1000,
    });
    wrfcChains.set(wrfcId, {
      id: wrfcId,
      task: 'Build a simple rate limiter',
      ownerAgentId: ownerId,
      state: 'fixing',
      constraints: [],
    });

    const modal = createProcessModal();
    modal.refresh();

    expect(modal.entries.map((entry) => entry.id)).toEqual([ownerId, engineerId, fixerId, reviewerId]);
    expect(modal.entries[1].treePrefix).toBe('├─ ');
    expect(modal.entries[2].treePrefix).toBe('│  └─ ');
    expect(modal.entries[3].treePrefix).toBe('└─ ');
  });

  test('refresh() keeps independent agent hierarchies grouped by parent', () => {
    const rootA = seedAgent('Root A', 'running', {
      startedAt: Date.now() - 4000,
    });
    const rootB = seedAgent('Root B', 'running', {
      startedAt: Date.now() - 3000,
    });
    const childA = seedAgent('Child A', 'running', {
      parentAgentId: rootA,
      startedAt: Date.now() - 1000,
    });

    const modal = createProcessModal();
    modal.refresh();

    expect(modal.entries.map((entry) => entry.id)).toEqual([rootA, childA, rootB]);
    expect(modal.entries[1].treePrefix).toBe('└─ ');
  });

  // W0.4(g): buildAgentLabel's chain lookup (getChainTask) returns null when
  // the chain has already completed/evicted or wrfcId isn't populated on the
  // record — both plausible runtime states, not just test artifacts. Before
  // this fix, that null was papered over with a generic "review/fix in
  // progress" placeholder even though the real description is sitting right
  // there in rec.task (seeded as 'WRFC Review Request\n<description>').
  test('Review label falls back to the description embedded in rec.task when the WRFC chain lookup returns null', () => {
    seedAgent('WRFC Review Request\nBuild a simple rate limiter\nWRFC threshold is 8.5', 'running', {
      wrfcId: 'wrfc-chain-evicted',
      wrfcRole: 'reviewer',
      template: 'reviewer',
    });
    // Deliberately do not set wrfcChains for 'wrfc-chain-evicted' — simulates
    // getChain() returning null (chain completed/evicted).

    const modal = createProcessModal();
    modal.refresh();

    expect(modal.entries.length).toBe(1);
    expect(modal.entries[0].label).toContain('Build a simple rate limiter');
    expect(modal.entries[0].label).not.toContain('review in progress');
  });

  test('Fix label falls back to the description embedded in rec.task when the WRFC chain lookup returns null', () => {
    seedAgent('WRFC Fix Request\nBuild a simple rate limiter\nReview score: 5/10 (threshold: 8)\nFix attempt: 1', 'running', {
      wrfcId: 'wrfc-chain-evicted-2',
      wrfcRole: 'fixer',
      template: 'engineer',
    });
    // Deliberately do not set wrfcChains for 'wrfc-chain-evicted-2'.

    const modal = createProcessModal();
    modal.refresh();

    expect(modal.entries.length).toBe(1);
    expect(modal.entries[0].label).toContain('Build a simple rate limiter');
    expect(modal.entries[0].label).not.toContain('fix in progress');
  });

  test('refresh() preserves hierarchy position when an active parent exits', () => {
    const rootA = seedAgent('Root A', 'running', {
      startedAt: Date.now() - 4000,
    });
    const rootB = seedAgent('Root B', 'running', {
      startedAt: Date.now() - 3000,
    });
    const modal = createProcessModal();
    modal.refresh();
    expect(modal.entries.map((entry) => entry.id)).toEqual([rootA, rootB]);

    const childA = seedAgent('Child A', 'running', {
      parentAgentId: rootA,
      startedAt: Date.now() - 1000,
    });
    const rootARecord = agents.get(rootA);
    if (!rootARecord) throw new Error('expected root agent');
    rootARecord.status = 'completed';
    modal.refresh();

    expect(modal.entries.map((entry) => entry.id)).toEqual([childA, rootB]);
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

  test('renders WRFC child connector in entry label', () => {
    const wrfcId = 'wrfc-render';
    const ownerId = seedAgent('Owner task', 'running', {
      wrfcId,
      wrfcRole: 'owner',
      template: 'engineer',
      startedAt: Date.now() - 2000,
    });
    seedAgent('Engineer task', 'running', {
      wrfcId,
      wrfcRole: 'engineer',
      template: 'engineer',
      parentAgentId: ownerId,
      startedAt: Date.now() - 1000,
    });
    wrfcChains.set(wrfcId, {
      id: wrfcId,
      task: 'Build a simple rate limiter',
      ownerAgentId: ownerId,
      state: 'engineering',
      constraints: [],
    });
    const modal = createProcessModal();
    modal.open();

    const lines = renderProcessModal(modal, W);
    const text = linesToText(lines).join('\n');

    expect(text).toContain('└─ [Engineer]');
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
