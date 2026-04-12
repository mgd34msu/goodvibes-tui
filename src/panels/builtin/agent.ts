import type { PanelManager } from '../panel-manager.ts';
import { AgentLogsPanel } from '../agent-logs-panel.ts';
import { ContextVisualizerPanel } from '../context-visualizer-panel.ts';
import { ThinkingPanel } from '../thinking-panel.ts';
import { ToolInspectorPanel } from '../tool-inspector-panel.ts';
import { WrfcPanel } from '../wrfc-panel.ts';
import { SchedulePanel } from '../schedule-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireAutomationManager, requireUiServices } from './shared.ts';

export function registerAgentPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  manager.registerType({
    id: 'thinking',
    name: 'Thinking',
    icon: 'T',
    category: 'ai',
    description: 'Stream model reasoning tokens in real-time with collapsible blocks per turn',
    factory: () => new ThinkingPanel(deps.runtimeBus),
  });

  manager.registerType({
    id: 'tools',
    name: 'Tools',
    icon: 'X',
    category: 'ai',
    description: 'Chronological tool call inspector with expandable args/results and filtering',
    factory: () => new ToolInspectorPanel(deps.runtimeBus),
  });

  manager.registerType({
    id: 'context',
    name: 'Context',
    icon: 'C',
    category: 'ai',
    description: 'Context window visualizer: stacked bar showing token usage per section',
    factory: () => new ContextVisualizerPanel(
      deps.runtimeBus,
      deps.sessionMemoryStore,
      deps.getOrchestratorUsage,
      deps.contextWindow,
      deps.runtimeStore,
    ),
  });

  manager.registerType({
    id: 'agent-logs',
    name: 'Agents',
    icon: 'A',
    category: 'agent',
    description: 'View-only live session stream from running agents with per-agent switching',
    factory: () => {
      const ui = requireUiServices(deps);
      return new AgentLogsPanel(deps.runtimeBus, { agentManager: ui.agentManager });
    },
  });

  manager.registerType({
    id: 'wrfc',
    name: 'WRFC',
    icon: 'W',
    category: 'agent',
    description: 'WRFC chain view: write, review, fix, and confirm cycle status',
    factory: () => {
      const ui = requireUiServices(deps);
      return new WrfcPanel(deps.runtimeBus, { controller: ui.wrfcController });
    },
  });

  manager.registerType({
    id: 'schedule',
    name: 'Schedule',
    icon: 'Z',
    category: 'agent',
    description: 'Scheduled agent tasks: cron expressions, next run time, enable/disable, run history',
    factory: () => new SchedulePanel(requireAutomationManager(deps)),
  });
}
