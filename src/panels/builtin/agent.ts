import type { PanelManager } from '../panel-manager.ts';
import { AgentInspectorPanel } from '../agent-inspector-panel.ts';
import { ThinkingPanel } from '../thinking-panel.ts';
import { ToolInspectorPanel } from '../tool-inspector-panel.ts';
import { WrfcPanel } from '../wrfc-panel.ts';
import { ProjectPlanningPanel } from '../project-planning-panel.ts';
import { WorkPlanPanel } from '../work-plan-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireUiServices } from './shared.ts';

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

  // WO-110: agent-logs merged into inspector — one deep agent console with
  // the correct JSONL parser + cancel, plus agent-logs' follow/pause/filter
  // ergonomics. Registration moved here (category 'agent') from
  // builtin/development.ts. (WO-113 retired the 'context' registration that
  // previously lived here: ContextVisualizerPanel merged into TokenBudgetPanel,
  // aliased in builtin/session.ts.)
  manager.registerType({
    id: 'inspector',
    name: 'Inspector',
    icon: 'I',
    category: 'agent',
    description: 'Live per-agent console: timeline, tool calls, WRFC/cost badges, pause/filter/follow, and cancel',
    preload: true,
    factory: () => {
      const ui = requireUiServices(deps);
      return new AgentInspectorPanel({
        agentManager: ui.agents.agentManager,
        agentMessageBus: ui.agents.agentMessageBus,
        agentEvents: ui.events.agents,
        workingDirectory: ui.environment.workingDirectory,
        cancelAgent: (agentId: string) => ui.agents.agentManager.cancel(agentId),
        requestRender: deps.requestRender,
      });
    },
  });

  // Compat: '/panel open agent-logs' (and any saved layout/muscle memory)
  // still resolves — redirected to the merged inspector console.
  manager.registerAlias('agent-logs', 'inspector');

  manager.registerType({
    id: 'wrfc',
    name: 'WRFC',
    icon: 'W',
    category: 'agent',
    description: 'WRFC chain view: write, review, fix, and confirm cycle status',
    preload: true,
    factory: () => {
      const ui = requireUiServices(deps);
      return new WrfcPanel(ui.events.workflows, {
        controller: ui.agents.wrfcController,
        cancelChain: (agentId: string) => ui.agents.agentManager.cancel(agentId),
      });
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
}
