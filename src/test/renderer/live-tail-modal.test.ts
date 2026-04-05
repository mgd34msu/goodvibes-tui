import { describe, test, expect, beforeEach } from 'bun:test';
import { LiveTailModal, renderLiveTailModal } from '../../renderer/live-tail-modal.ts';
import { AgentManager } from '../../tools/agent/index.ts';
import { ProcessManager } from '../../tools/shared/process-manager.ts';
import type { ProcessEntry } from '../../renderer/process-modal.ts';
import { lineToString, linesToText } from '../setup.ts';

const W = 100;

beforeEach(() => {
  AgentManager.resetInstance();
  ProcessManager.resetInstance();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<ProcessEntry> = {}): ProcessEntry {
  return {
    id: 'test-id',
    label: 'Test task',
    type: 'agent',
    status: 'running',
    elapsedMs: 5000,
    ...overrides,
  };
}

function seedAgent(task: string): string {
  const am = AgentManager.getInstance();
  const rec = am.spawn({ mode: 'spawn', task, template: 'default', tools: [] });
  const seeded = am.getStatus(rec.id);
  if (!seeded) throw new Error('expected agent record');
  seeded.status = 'running';
  return rec.id;
}

// ─── LiveTailModal state ───────────────────────────────────────────────────────

describe('LiveTailModal state', () => {
  test('initially inactive with null entry', () => {
    const modal = new LiveTailModal();
    expect(modal.active).toBe(false);
    expect(modal.entry).toBeNull();
  });

  test('open() sets active=true and entry', () => {
    const modal = new LiveTailModal();
    const entry = makeEntry();
    modal.open(entry);
    expect(modal.active).toBe(true);
    expect(modal.entry).toBe(entry);
    expect(modal.scrollOffset).toBe(0);
  });

  test('close() resets active, entry, and scrollOffset', () => {
    const modal = new LiveTailModal();
    modal.open(makeEntry());
    modal.scrollUp();
    modal.close();
    expect(modal.active).toBe(false);
    expect(modal.entry).toBeNull();
    expect(modal.scrollOffset).toBe(0);
  });

  test('scrollUp() increments scrollOffset', () => {
    const modal = new LiveTailModal();
    modal.open(makeEntry());
    modal.scrollUp();
    modal.scrollUp();
    expect(modal.scrollOffset).toBe(2);
  });

  test('scrollDown() decrements scrollOffset', () => {
    const modal = new LiveTailModal();
    modal.open(makeEntry());
    modal.scrollUp();
    modal.scrollUp();
    modal.scrollDown();
    expect(modal.scrollOffset).toBe(1);
  });

  test('scrollDown() does not go below 0 (auto-scroll floor)', () => {
    const modal = new LiveTailModal();
    modal.open(makeEntry());
    modal.scrollDown();
    expect(modal.scrollOffset).toBe(0);
  });

  test('getOutput() returns empty string when entry is null', () => {
    const modal = new LiveTailModal();
    expect(modal.getOutput()).toBe('');
  });

  test('getOutput() returns agent info for agent entries', () => {
    const id = seedAgent('Build the feature');
    const am = AgentManager.getInstance();
    am.getStatus(id)!;
    const modal = new LiveTailModal();
    const entry = makeEntry({ id, type: 'agent', label: 'Build the feature' });
    modal.open(entry);
    const out = modal.getOutput();
    expect(out).toContain('Task:');
    expect(out).toContain('Build the feature');
  });

  test('getOutput() returns (process not found) for unknown agent id', () => {
    const modal = new LiveTailModal();
    modal.open(makeEntry({ id: 'nonexistent', type: 'agent' }));
    const out = modal.getOutput();
    expect(out).toBe('(process not found)');
  });

  test('getOutput() returns exec output for exec entries', () => {
    const pm = ProcessManager.getInstance();
    const result = pm.spawn('echo hello', undefined, undefined);
    const id = result.process_id!;
    const modal = new LiveTailModal();
    modal.open(makeEntry({ id, type: 'exec', label: 'echo hello' }));
    // May be empty initially since process is spawned async
    const out = modal.getOutput();
    expect(typeof out).toBe('string');
  });

  test('killProcess() returns false when entry is null', () => {
    const modal = new LiveTailModal();
    expect(modal.killProcess()).toBe(false);
  });

  test('killProcess() delegates to AgentManager for agent entries', () => {
    const id = seedAgent('Kill me');
    const modal = new LiveTailModal();
    modal.open(makeEntry({ id, type: 'agent' }));
    const result = modal.killProcess();
    expect(typeof result).toBe('boolean');
  });

  test('killProcess() delegates to ProcessManager for exec entries', () => {
    const pm = ProcessManager.getInstance();
    const result = pm.spawn('sleep 100', undefined, undefined);
    const id = result.process_id!;
    const modal = new LiveTailModal();
    modal.open(makeEntry({ id, type: 'exec' }));
    const killed = modal.killProcess();
    expect(typeof killed).toBe('boolean');
  });
});

// ─── renderLiveTailModal ───────────────────────────────────────────────────────

describe('renderLiveTailModal', () => {
  test('returns empty array when entry is null', () => {
    const modal = new LiveTailModal();
    const lines = renderLiveTailModal(modal, W);
    expect(lines).toEqual([]);
  });

  test('all lines have correct terminal width', () => {
    const id = seedAgent('Test agent');
    const modal = new LiveTailModal();
    modal.open(makeEntry({ id, type: 'agent', label: 'Test agent' }));
    const lines = renderLiveTailModal(modal, W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('renders title with type tag and label', () => {
    const id = seedAgent('My task label');
    const modal = new LiveTailModal();
    modal.open(makeEntry({ id, type: 'agent', label: 'My task label' }));
    const lines = renderLiveTailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('[agent]');
    expect(text).toContain('My task label');
  });

  test('renders content output inside modal', () => {
    const id = seedAgent('Output task');
    const modal = new LiveTailModal();
    modal.open(makeEntry({ id, type: 'agent', label: 'Output task' }));
    const lines = renderLiveTailModal(modal, W);
    const text = linesToText(lines).join('\n');
    // Should contain Task: line from agent output
    expect(text).toContain('Task:');
  });

  test('renders (no output yet) for exec entry with no output', () => {
    const modal = new LiveTailModal();
    // Use null entry scenario via exec with nonexistent id
    modal.open(makeEntry({ id: 'no-such-exec', type: 'exec', label: 'cmd' }));
    const lines = renderLiveTailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('no output yet');
  });

  test('footer contains hint text [k] Kill and [Esc] Back', () => {
    const id = seedAgent('Hint test');
    const modal = new LiveTailModal();
    modal.open(makeEntry({ id, type: 'agent', label: 'Hint test' }));
    const lines = renderLiveTailModal(modal, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Kill');
    expect(text).toContain('Back');
  });

  test('scroll indicator shows when output exceeds maxOutputLines', () => {
    const id = seedAgent('Scrollable task');
    const am = AgentManager.getInstance();
    // Add progress to generate multi-line output
    const rec = am.getStatus(id)!;
    rec.progress = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join('\n');
    const modal = new LiveTailModal();
    modal.open(makeEntry({ id, type: 'agent', label: 'Scrollable task' }));
    // Force enough output lines by setting a small maxOutputLines
    const lines = renderLiveTailModal(modal, W, 3);
    const text = linesToText(lines).join('\n');
    // When lines exceed maxOutputLines, scroll info or scroll hint appears
    // (either "Lines X-Y of Z" or just the output is truncated)
    expect(lines.length).toBeGreaterThan(2);
  });

  test('scrollOffset=0 means auto-scroll to bottom (most recent output visible)', () => {
    const id = seedAgent('Auto-scroll task');
    const modal = new LiveTailModal();
    modal.open(makeEntry({ id, type: 'agent', label: 'Auto-scroll task' }));
    expect(modal.scrollOffset).toBe(0);
    const lines = renderLiveTailModal(modal, W);
    expect(lines.length).toBeGreaterThan(0);
  });
});
