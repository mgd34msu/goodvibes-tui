import type { PanelManager } from '../panel-manager.ts';
import { SessionBrowserPanel } from '../session-browser-panel.ts';
import { QrPanel } from '../qr-panel.ts';
import { DocsPanel } from '../docs-panel.ts';
import { PanelListPanel } from '../panel-list-panel.ts';
import { TokenBudgetPanel } from '../token-budget-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireUiServices } from './shared.ts';
import {
  getOrCreateCompanionToken,
  regenerateCompanionToken,
  buildCompanionConnectionInfo,
} from '@pellux/goodvibes-sdk/platform/pairing/index';
import { copyToClipboard } from '../../utils/clipboard.ts';

export function registerSessionPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  manager.registerType({
    id: 'qr-code',
    name: 'QR Code',
    icon: 'Q',
    category: 'session',
    description: 'QR code for companion app pairing — scan to connect a mobile or desktop companion',
    factory: () => {
      const tokenRecord = getOrCreateCompanionToken('tui');
      const daemonPort = deps.configManager.get('controlPlane.port');
      const daemonHost = String(process.env['GOODVIBES_DAEMON_HOST'] ?? 'localhost');
      const daemonUrl = `http://${daemonHost}:${daemonPort}`;
      const connectionInfo = buildCompanionConnectionInfo({
        daemonUrl,
        token: tokenRecord.token,
        surface: 'tui',
      });
      const regenerate = (): typeof connectionInfo => {
        const newRecord = regenerateCompanionToken('tui');
        return buildCompanionConnectionInfo({
          daemonUrl,
          token: newRecord.token,
          surface: 'tui',
        });
      };
      return new QrPanel(connectionInfo, regenerate, copyToClipboard);
    },
  });

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
