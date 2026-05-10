import type { PanelManager } from '../panel-manager.ts';
import { AgentLogsPanel } from '../agent-logs-panel.ts';
import { ContextVisualizerPanel } from '../context-visualizer-panel.ts';
import { ThinkingPanel } from '../thinking-panel.ts';
import { ToolInspectorPanel } from '../tool-inspector-panel.ts';
import { WrfcPanel } from '../wrfc-panel.ts';
import { SchedulePanel } from '../schedule-panel.ts';
import { ProjectPlanningPanel } from '../project-planning-panel.ts';
import { WorkPlanPanel } from '../work-plan-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireAutomationManager, requireUiServices } from './shared.ts';

export function registerAgentPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  manager.registerType({
    id: 'thinking',
    name: 'Thinking',
    icon: 'T',
    category: 'ai',
    description: 'Stream model reasoning tokens in real-time with collapsible blocks per turn',
    preload: true,
    factory: () => new ThinkingPanel(requireUiServices(deps).events.turns),
  });

  manager.registerType({
    id: 'tools',
    name: 'Tools',
    icon: 'X',
    category: 'ai',
    description: 'Chronological tool call inspector with expandable args/results and filtering',
    preload: true,
    factory: () => {
      const ui = requireUiServices(deps);
      return new ToolInspectorPanel(ui.events.tools, ui.events.turns);
    },
  });

  manager.registerType({
    id: 'context',
    name: 'Context',
    icon: 'C',
    category: 'ai',
    description: 'Context window visualizer: stacked bar showing token usage per section',
    preload: true,
    factory: () => new ContextVisualizerPanel(
      requireUiServices(deps).events.turns,
      deps.sessionMemoryStore,
      deps.configManager,
      deps.getOrchestratorUsage,
      deps.contextWindow,
      requireUiServices(deps).readModels.session,
    ),
  });

  manager.registerType({
    id: 'agent-logs',
    name: 'Agents',
    icon: 'A',
    category: 'agent',
    description: 'View-only live session stream from running agents with per-agent switching',
    preload: true,
    factory: () => {
      const ui = requireUiServices(deps);
      return new AgentLogsPanel(ui.events.agents, {
        agentManager: ui.agents.agentManager,
        workingDirectory: ui.environment.workingDirectory,
      });
    },
  });

  manager.registerType({
    id: 'wrfc',
    name: 'WRFC',
    icon: 'W',
    category: 'agent',
    description: 'WRFC chain view: write, review, fix, and confirm cycle status',
    preload: true,
    factory: () => {
      const ui = requireUiServices(deps);
      return new WrfcPanel(ui.events.workflows, { controller: ui.agents.wrfcController });
    },
  });

  manager.registerType({
    id: 'work-plan',
    name: 'Work Plan',
    icon: 'L',
    category: 'agent',
    description: 'Persistent workspace checklist for multi-step work and cross-session task tracking',
    preload: true,
    factory: () => new WorkPlanPanel(deps.workPlanStore),
  });

  manager.registerType({
    id: 'project-planning',
    name: 'Planning',
    icon: 'P',
    category: 'agent',
    description: 'Passive project planning artifacts: readiness, questions, decisions, language, task graph, and agent handoff metadata',
    preload: true,
    factory: () => new ProjectPlanningPanel({
      service: deps.projectPlanningService,
      projectId: deps.projectPlanningProjectId,
      requestRender: deps.requestRender,
      submitAnswer: deps.submitPlanningAnswer,
      dismissPlanning: deps.dismissPlanning,
    }),
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
