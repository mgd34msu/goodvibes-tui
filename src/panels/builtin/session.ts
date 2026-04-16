import type { PanelManager } from '../panel-manager.ts';
import { SessionBrowserPanel } from '../session-browser-panel.ts';
import { DocsPanel } from '../docs-panel.ts';
import { PanelListPanel } from '../panel-list-panel.ts';
import { TokenBudgetPanel } from '../token-budget-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireUiServices } from './shared.ts';

export function registerSessionPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  manager.registerType({
    id: 'sessions',
    name: 'Sessions',
    icon: 'H',
    category: 'session',
    description: 'Browse, search, and resume past conversation sessions',
    factory: () => new SessionBrowserPanel(deps.sessionManager, deps.resumeSession),
  });

  manager.registerType({
    id: 'docs',
    name: 'Docs',
    icon: '?',
    category: 'session',
    description: 'Tool list, model capabilities, and keyboard shortcut reference',
    factory: () => new DocsPanel(deps.toolRegistry, deps.providerRegistry),
  });

  manager.registerType({
    id: 'panel-list',
    name: 'Panel List',
    icon: 'L',
    category: 'session',
    description: 'Browse all registered panels grouped by category, with open/closed status and Enter-to-open',
    factory: () => new PanelListPanel(manager, deps.componentHealthMonitor),
  });

  manager.registerType({
    id: 'system-messages',
    name: 'System Messages',
    icon: 'J',
    category: 'monitoring',
    description: 'Operational system messages routed away from the main conversation (scans, discovery, plugin events, tool status)',
    preload: true,
    factory: () => deps.systemMessagesPanel,
  });

  manager.registerType({
    id: 'tokens',
    name: 'Tokens',
    icon: 'K',
    category: 'monitoring',
    description: 'Token budget tracker: per-turn and cumulative usage with context window gauge',
    factory: () => {
      const panel = new TokenBudgetPanel(deps.sessionMemoryStore, deps.configManager);
      if (deps.orchestrator && deps.getCtxWindow) {
        panel.wire(deps.orchestrator, deps.getCtxWindow, requireUiServices(deps).readModels.session);
      }
      return panel;
    },
  });
}
