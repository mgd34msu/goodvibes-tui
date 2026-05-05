import { beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../runtime/ui-events.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { Line } from '../../types/grid.ts';
import { ProviderStatsPanel } from '../../panels/provider-stats-panel.ts';
import { ToolInspectorPanel } from '../../panels/tool-inspector-panel.ts';
import { SessionBrowserPanel } from '../../panels/session-browser-panel.ts';
import { ThinkingPanel } from '../../panels/thinking-panel.ts';
import { ContextVisualizerPanel } from '../../panels/context-visualizer-panel.ts';
import { CostTrackerPanel } from '../../panels/cost-tracker-panel.ts';
import { DebugPanel } from '../../panels/debug-panel.ts';
import { WrfcPanel } from '../../panels/wrfc-panel.ts';
import { SymbolOutlinePanel } from '../../panels/symbol-outline-panel.ts';
import { FileExplorerPanel } from '../../panels/file-explorer-panel.ts';
import { FilePreviewPanel } from '../../panels/file-preview-panel.ts';
import { OpsStrategyPanel } from '../../panels/ops-strategy-panel.ts';
import { AgentLogsPanel } from '../../panels/agent-logs-panel.ts';
import { AgentInspectorPanel } from '../../panels/agent-inspector-panel.ts';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core';
import { createTestProviderRegistry } from '../helpers/test-managers.ts';


// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function linesText(lines: Line[]): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('')).join('\n');
}

function createRuntimeBusStub(): RuntimeEventBus {
  return new RuntimeEventBus();
}

function createWrfcPanel(runtimeBus: RuntimeEventBus): WrfcPanel {
  return new WrfcPanel(createUiRuntimeEvents(runtimeBus).workflows, {
    controller: {
      listChains: () => [],
    },
  });
}

function createAgentLogsPanel(runtimeBus: RuntimeEventBus): AgentLogsPanel {
  return new AgentLogsPanel(createUiRuntimeEvents(runtimeBus).agents, {
    agentManager: {
      list: () => [],
    },
    workingDirectory: '/tmp/goodvibes-test',
  });
}

function createAgentInspectorPanel(): AgentInspectorPanel {
  return new AgentInspectorPanel({
    agentManager: {
      list: () => [],
      getStatus: () => null,
    },
    agentMessageBus: {
      getMessages: () => [],
    },
    workingDirectory: '/tmp/goodvibes-test',
  });
}

describe('workspace panel migrations', () => {
  let runtimeBus: RuntimeEventBus;

  beforeEach(async () => {
    runtimeBus = createRuntimeBusStub();
  });

  test('ProviderStatsPanel renders shared workspace empty state cleanly', async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const providerRegistry = createTestProviderRegistry();
    const panel = new ProviderStatsPanel(events.turns, events.providers, undefined, {
      getSnapshot: () => ({
        providerIds: [...new Set(providerRegistry.listModels().map((model) => model.provider))].sort(),
      }),
      subscribe: () => () => {},
    });
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Provider Stats');
    expect(linesText(lines)).toContain('No providers registered');
  });

  test('ToolInspectorPanel renders shared workspace empty state cleanly', async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new ToolInspectorPanel(events.tools, events.turns);
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Tools');
    expect(linesText(lines)).toContain('No tool calls yet');
  });

  test('SessionBrowserPanel renders shared workspace empty state cleanly', async () => {
    const panel = new SessionBrowserPanel(new SessionManager(join(tmpdir(), 'gv-workspace-migration'), { surfaceRoot: 'tui' }));
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Sessions');
    expect(linesText(lines)).toContain('No sessions found');
  });

  test('SessionBrowserPanel supports explicit search focus from top navigation', async () => {
    const panel = new SessionBrowserPanel(new SessionManager(join(tmpdir(), 'gv-workspace-migration'), { surfaceRoot: 'tui' }));
    panel.handleInput('up');
    panel.handleInput('r');
    const text = linesText(panel.render(80, 20));
    expect(text).toContain('Search: r█');
    expect(text).not.toContain('refresh');
  });

  test('ThinkingPanel renders shared workspace empty state cleanly', async () => {
    const panel = new ThinkingPanel(createUiRuntimeEvents(runtimeBus).turns);
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Thinking');
    expect(linesText(lines)).toContain('No reasoning content yet');
  });

  test('ContextVisualizerPanel renders shared workspace empty state cleanly', async () => {
    const panel = new ContextVisualizerPanel(
      createUiRuntimeEvents(runtimeBus).turns,
      new SessionMemoryStore(),
      new ConfigManager({ surfaceRoot: 'tui', homeDir: '/tmp', workingDir: '/tmp' }),
    );
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Context Usage');
    expect(linesText(lines)).toContain('Context limit unavailable');
  });

  test('CostTrackerPanel renders shared workspace empty state cleanly', async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new CostTrackerPanel(events.turns, events.agents, () => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      model: 'unknown',
    }));
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Cost Tracker');
    expect(linesText(lines)).toContain('No agents spawned this session');
  });

  test('DebugPanel renders shared workspace empty state cleanly', async () => {
    const panel = new DebugPanel(createUiRuntimeEvents(runtimeBus).turns);
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('API Debug');
    expect(linesText(lines)).toContain('No calls yet');
  });

  test('WrfcPanel renders shared workspace empty state cleanly', async () => {
    const panel = createWrfcPanel(runtimeBus);
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('WRFC Chain Monitor');
    expect(linesText(lines)).toContain('No WRFC chains yet');
  });

  test('SymbolOutlinePanel renders shared workspace empty state cleanly', async () => {
    const panel = new SymbolOutlinePanel();
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Symbols');
    expect(linesText(lines)).toContain('No file loaded');
  });

  test('FileExplorerPanel renders shared workspace surface cleanly', async () => {
    const panel = new FileExplorerPanel('/definitely/not/a/real/path', '/tmp/goodvibes-test');
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Explorer');
  });

  test('FileExplorerPanel supports explicit search focus from top navigation', async () => {
    const panel = new FileExplorerPanel('/definitely/not/a/real/path', '/tmp/goodvibes-test');
    panel.handleInput('up');
    panel.handleInput('r');
    const text = linesText(panel.render(80, 20));
    expect(text).toContain('/ r█');
  });

  test('FilePreviewPanel renders shared workspace empty state cleanly', async () => {
    const panel = new FilePreviewPanel();
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Preview');
    expect(linesText(lines)).toContain('No file open');
  });

  test('OpsStrategyPanel renders shared workspace empty state cleanly', async () => {
    const panel = new OpsStrategyPanel(createUiRuntimeEvents(runtimeBus).planner, new AdaptivePlanner());
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Ops Strategy');
    expect(linesText(lines)).toContain('No decisions recorded yet');
  });

  test('AgentLogsPanel renders shared workspace empty state cleanly', async () => {
    const panel = createAgentLogsPanel(runtimeBus);
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Agents');
    expect(linesText(lines)).toContain('No agents running');
  });

  test('AgentInspectorPanel renders shared workspace empty state cleanly', async () => {
    const panel = createAgentInspectorPanel();
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Inspector');
    expect(linesText(lines)).toContain('No agents running');
  });

  test('ThinkingPanel keeps ingesting stream events while deactivated', async () => {
    const panel = new ThinkingPanel(createUiRuntimeEvents(runtimeBus).turns);
    panel.onActivate();
    panel.onDeactivate();
    runtimeBus.emit(
      'turn',
      createEventEnvelope('STREAM_START', { type: 'STREAM_START', turnId: 'turn-1' }, {
        sessionId: 'sess-1',
        source: 'test',
        turnId: 'turn-1',
      }),
    );
    runtimeBus.emit(
      'turn',
      createEventEnvelope(
        'STREAM_DELTA',
        { type: 'STREAM_DELTA', turnId: 'turn-1', content: '', accumulated: '', reasoning: 'reasoning after blur' },
        {
          sessionId: 'sess-1',
          source: 'test',
          turnId: 'turn-1',
        },
      ),
    );
    await flushMicrotasks();
    const text = linesText(panel.render(80, 20));
    expect(text).toContain('reasoning after blur');
  });

  test('ToolInspectorPanel keeps ingesting tool events while deactivated', async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new ToolInspectorPanel(events.tools, events.turns);
    panel.onActivate();
    panel.onDeactivate();
    runtimeBus.emit(
      'tools',
      createEventEnvelope(
        'TOOL_RECEIVED',
        { type: 'TOOL_RECEIVED', callId: 'call-1', turnId: 'turn-1', tool: 'write', args: { path: 'x.ts' } },
        {
          sessionId: 'sess-1',
          source: 'test',
          turnId: 'turn-1',
        },
      ),
    );
    await flushMicrotasks();
    const text = linesText(panel.render(80, 20));
    expect(text).toContain('write');
  });
});
