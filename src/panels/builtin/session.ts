import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
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
} from '@pellux/goodvibes-sdk/platform/pairing';
import { copyToClipboard } from '../../utils/clipboard.ts';

function getLocalNetworkIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

function readBootstrapPassword(credentialPath: string): string | undefined {
  try {
    const content = readFileSync(credentialPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('password=')) {
        return line.slice('password='.length).trim();
      }
    }
  } catch {
    // credential file may not exist yet
  }
  return undefined;
}

export function registerSessionPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  const ui = requireUiServices(deps);
  manager.registerType({
    id: 'qr-code',
    name: 'QR Code',
    icon: 'Q',
    category: 'session',
    description: 'QR code for companion app pairing — scan to connect a mobile or desktop companion',
    factory: () => {
      if (!deps.daemonHomeDir) throw new Error('daemonHomeDir must be provided to the session panel factory via BuiltinPanelDeps');
      const daemonHomeDir = deps.daemonHomeDir;
      const tokenRecord = getOrCreateCompanionToken('tui', { daemonHomeDir });
      const daemonPort = deps.configManager.get('controlPlane.port');
      const daemonHost = String(process.env['GOODVIBES_DAEMON_HOST'] ?? getLocalNetworkIp());
      const daemonUrl = `http://${daemonHost}:${daemonPort}`;
      const bootstrapPassword = readBootstrapPassword(deps.localUserAuthManager.getBootstrapCredentialPath());
      const connectionInfo = buildCompanionConnectionInfo({
        daemonUrl,
        token: tokenRecord.token,
        password: bootstrapPassword,
        surface: 'tui',
      });
      const regenerate = (): typeof connectionInfo => {
        const newRecord = regenerateCompanionToken({ daemonHomeDir });
        return buildCompanionConnectionInfo({
          daemonUrl,
          token: newRecord.token,
          password: bootstrapPassword,
          surface: 'tui',
        });
      };
      return new QrPanel(connectionInfo, regenerate, copyToClipboard, ui.readModels.controlPlane, deps.localUserAuthManager);
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
    factory: () => new DocsPanel(deps.toolRegistry, deps.providerRegistry, requireUiServices(deps).shell.keybindingsManager),
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
    description: 'Token + context console: gauge, true composition, per-turn history, inline cost, and one-key compact',
    // Preloaded (absorbed from the retired ContextVisualizerPanel) so turn
    // history and pressure accumulate in the background even before the user
    // opens the tab.
    preload: true,
    factory: () => {
      const panel = new TokenBudgetPanel(
        deps.sessionMemoryStore,
        deps.configManager,
        deps.requestRender,
        requireUiServices(deps).events.turns,
      );
      if (deps.orchestrator && deps.getCtxWindow) {
        panel.wire(
          deps.orchestrator,
          deps.getCtxWindow,
          requireUiServices(deps).readModels.session,
          () => deps.providerRegistry.getCurrentModel().id,
        );
      }
      return panel;
    },
  });

  // WO-113 compat: the retired 'context' panel id still resolves — redirected
  // to the merged tokens console ('/panel open context', saved layouts).
  manager.registerAlias('context', 'tokens');
}
