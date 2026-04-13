import { describe, test, expect, beforeEach } from 'bun:test';
import { AgentDetailModal, renderAgentDetailModal } from '../../renderer/agent-detail-modal.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { linesToText } from '../setup.ts';
import { getTestAgentManager, getTestAgentMessageBus, resetTestRuntimeServices } from '../helpers/runtime-services.ts';

const W = 100;

beforeEach(() => {
  resetTestRuntimeServices();
  resetTestRuntimeServices();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedAgent(task = 'Do something', status: 'running' | 'pending' = 'running'): string {
  const am = getTestAgentManager();
  const rec = am.spawn({ mode: 'spawn', task, template: 'general', tools: [] });
  const seeded = am.getStatus(rec.id);
  if (!seeded) throw new Error('expected agent record');
  seeded.status = status;
  return rec.id;
}

function createAgentDetailModal(): AgentDetailModal {
  const ui = createDefaultUiRuntimeServices();
  return new AgentDetailModal({
    agentManager: ui.agents.agentManager,
    agentMessageBus: ui.agents.agentMessageBus,
    sessionLogPathResolver: (agentId) => ui.environment.shellPaths.resolveProjectTuiPath('sessions', `${agentId}.jsonl`),
  });
}

// ─── AgentDetailModal state ────────────────────────────────────────────────────

describe('AgentDetailModal state', () => {
  test('initially inactive with null agentId', () => {
    const modal = createAgentDetailModal();
    expect(modal.active).toBe(false);
    expect(modal.agentId).toBeNull();
  });

  test('open() sets active=true and agentId', () => {
    const modal = createAgentDetailModal();
    modal.open('agent-123');
    expect(modal.active).toBe(true);
    expect(modal.agentId).toBe('agent-123');
  });

  test('close() resets active and agentId', () => {
    const modal = createAgentDetailModal();
    modal.open('agent-123');
    modal.close();
    expect(modal.active).toBe(false);
    expect(modal.agentId).toBeNull();
  });
});

// ─── renderAgentDetailModal ───────────────────────────────────────────────────

describe('renderAgentDetailModal', () => {
  test('returns empty array when agentId is null', () => {
    const modal = createAgentDetailModal();
    const lines = renderAgentDetailModal(modal, W);
    expect(lines).toEqual([]);
  });

  test('renders (agent not found) for unknown agentId', () => {
    const modal = createAgentDetailModal();
    modal.open('nonexistent-id');
    const lines = renderAgentDetailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('agent not found');
  });

  test('all lines have correct terminal width', () => {
    const id = seedAgent('Test task');
    const modal = createAgentDetailModal();
    modal.open(id);
    const lines = renderAgentDetailModal(modal, W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('renders title with agent id', () => {
    const id = seedAgent('My task');
    const modal = createAgentDetailModal();
    modal.open(id);
    const lines = renderAgentDetailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Agent:');
  });

  test('renders task description', () => {
    const id = seedAgent('Build the feature');
    const modal = createAgentDetailModal();
    modal.open(id);
    const lines = renderAgentDetailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Build the feature');
  });

  test('renders template name', () => {
    const id = seedAgent('Task A');
    const modal = createAgentDetailModal();
    modal.open(id);
    const lines = renderAgentDetailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Template');
    expect(text).toContain('general');
  });

  test('renders status', () => {
    const id = seedAgent('Task B', 'running');
    const modal = createAgentDetailModal();
    modal.open(id);
    const lines = renderAgentDetailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Status');
    expect(text).toContain('running');
  });

  test('renders duration', () => {
    const id = seedAgent('Timed task');
    const modal = createAgentDetailModal();
    modal.open(id);
    const lines = renderAgentDetailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Duration');
  });

  test('renders tool call count', () => {
    const id = seedAgent('Tool task');
    const am = getTestAgentManager();
    const rec = am.getStatus(id);
    if (!rec) throw new Error('expected agent record');
    rec.toolCallCount = 5;
    const modal = createAgentDetailModal();
    modal.open(id);
    const lines = renderAgentDetailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Tool calls');
    expect(text).toContain('5');
  });

  test('renders estimated token usage', () => {
    const id = seedAgent('Token task');
    const am = getTestAgentManager();
    const rec = am.getStatus(id);
    if (!rec) throw new Error('expected agent record');
    rec.toolCallCount = 3;
    const modal = createAgentDetailModal();
    modal.open(id);
    const lines = renderAgentDetailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Est tokens');
    expect(text).toContain('1,200'); // 3 * 400
  });

  test('renders progress text when present', () => {
    const id = seedAgent('Progress task');
    const am = getTestAgentManager();
    const rec = am.getStatus(id);
    if (!rec) throw new Error('expected agent record');
    rec.progress = 'Step 2 of 5';
    const modal = createAgentDetailModal();
    modal.open(id);
    const lines = renderAgentDetailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Progress:');
    expect(text).toContain('Step 2 of 5');
  });

  test('renders error when present', () => {
    const id = seedAgent('Error task');
    const am = getTestAgentManager();
    const rec = am.getStatus(id);
    if (!rec) throw new Error('expected agent record');
    rec.error = 'Something went wrong';
    const modal = createAgentDetailModal();
    modal.open(id);
    const lines = renderAgentDetailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Error:');
    expect(text).toContain('Something went wrong');
  });

  test('renders recent bus messages when present', () => {
    const id = seedAgent('Bus task');
    const bus = getTestAgentMessageBus();
    bus.send('sender-agent', id, 'Hello from sender');
    const modal = createAgentDetailModal();
    modal.open(id);
    const lines = renderAgentDetailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Recent messages');
    expect(text).toContain('Hello from sender');
  });

  test('footer contains [Esc] Close hint', () => {
    const id = seedAgent('Hint task');
    const modal = createAgentDetailModal();
    modal.open(id);
    const lines = renderAgentDetailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Esc');
  });
});
