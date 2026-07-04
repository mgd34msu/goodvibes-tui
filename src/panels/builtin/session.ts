import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
import type { PanelManager } from '../panel-manager.ts';
import { SessionBrowserPanel } from '../session-browser-panel.ts';
import { QrPanel } from '../qr-panel.ts';
import { DocsPanel } from '../docs-panel.ts';
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

// W6.1 (the purge): panel-list and system-messages were registered here
// before the purge — both DELETE-disposition. panel-list was a picker over a
// handful of panels (dead weight now that the registry is much smaller —
// the picker itself is replaced by a live-registry selection modal on
// Ctrl+P, see shell/ui-openers.ts). system-messages' buffered notices are
// rerouted to the transcript's system channel instead of vanishing: with no
// panel attached, SystemMessageRouter's delivery resolution
// (resolveSystemMessageDelivery, SDK) already falls back to
// conversation.addTypedSystemMessage for every kind/target combination — see
// bootstrap-shell.ts and core/system-message-router.ts.
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
    id: 'tokens',
    name: 'Tokens',
    // WO-152: registry previously said 'K' while the live panel's own
    // super() call used 'T' — a pre-existing registry/instance mismatch as
    // well as a collision ('K' with knowledge/skills, 'T' with thinking).
    // Unified to a single unique glyph in both places.
    icon: '▢',
    category: 'providers',
    description: 'Token + context console: gauge, true composition, per-turn history, inline cost, and one-key compact',
    // Preloaded (absorbed from the retired ContextVisualizerPanel) so turn
    // history and pressure accumulate in the background even before the user
    // opens the tab. The only builtin panel that still preloads post-purge
    // (W6.1) — see registerBuiltinPanels callers for the others' preload
    // removal.
    preload: true,
    retainOnClose: true,
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
