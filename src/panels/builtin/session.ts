import type { PanelManager } from '../panel-manager.ts';
import { TokenBudgetPanel } from '../token-budget-panel.ts';
import { HostedSessionPanel } from '../hosted-session-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireUiServices } from './shared.ts';

// (the purge): panel-list and system-messages were registered here
// before the purge — both DELETE-disposition. panel-list was a picker over a
// handful of panels (dead weight now that the registry is much smaller —
// the picker itself is replaced by a live-registry selection modal on
// Ctrl+P, see shell/ui-openers.ts). system-messages' buffered notices are
// rerouted to the transcript's system channel instead of vanishing: with no
// panel attached, SystemMessageRouter's delivery resolution
// (resolveSystemMessageDelivery, SDK) already falls back to
// conversation.addTypedSystemMessage for every kind/target combination — see
// bootstrap-shell.ts and core/system-message-router.ts.
//
// (the purge) — group B: 'qr-code', 'sessions', and 'docs' also
// migrated. 'qr-code' → the 'pairing-modal' surface; 'docs' → the
// 'keybindings-modal' surface (merged with the shortcuts-overlay content);
// 'sessions' folds into the existing session-picker modal ('sessions' redirects
// to 'sessionPicker'). Their surfaces AND panel→modal redirects are registered
// centrally in registerBuiltinModals (builtin-modals.ts). Only 'tokens' (KEEP)
// is still registered here.
export function registerSessionPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  manager.registerType({
    id: 'tokens',
    name: 'Tokens',
    // registry previously said 'K' while the live panel's own
    // super() call used 'T' — a pre-existing registry/instance mismatch as
    // well as a collision ('K' with knowledge/skills, 'T' with thinking).
    // Unified to a single unique glyph in both places.
    icon: '▢',
    category: 'providers',
    description: 'Token + context console: gauge, true composition, per-turn history, inline cost, and one-key compact',
    // Preloaded (absorbed from the retired ContextVisualizerPanel) so turn
    // history and pressure accumulate in the background even before the user
    // opens the tab. The only builtin panel that still preloads post-purge
    // — see registerBuiltinPanels callers for the others' preload
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

  // Hosted Session — a conversation whose loop runs INSIDE the daemon rather
  // than in this process, rendered from the same `turn`/`tools` event domains a
  // local turn emits (see panels/hosted-session-feed.ts). Not preloaded: a
  // terminal that never opts into hosting should not carry an empty tab for it,
  // and `/hosted new`/`/hosted attach` open it on the way in.
  manager.registerType({
    id: 'hosted',
    name: 'Hosted Session',
    // '◈' verified free against the registered builtin panel icons.
    icon: '◈',
    category: 'session',
    description: 'A daemon-hosted conversation: its live transcript, the tool calls it is running, and what detaching would do to it',
    retainOnClose: true,
    factory: () => new HostedSessionPanel(),
  });

  // compat: the retired 'context' panel id still resolves — redirected
  // to the merged tokens console ('/panel open context', saved layouts).
  manager.registerAlias('context', 'tokens');
}
