import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { ConversationManager } from '../core/conversation';
import type { CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import { renderFilePickerOverlay } from './file-picker-overlay.ts';
import { renderModelWorkspace } from './model-workspace.ts';
import { renderSelectionModalOverlay } from './selection-modal-overlay.ts';
import { renderSearchOverlay } from './search-overlay.ts';
import { renderHistorySearchOverlay } from './history-search-overlay.ts';
import { renderContextInspector } from './context-inspector.ts';
import { renderSettingsModal } from './settings-modal.ts';
import { renderConfigModal } from './config-modal.ts';
import { renderMcpWorkspace } from './mcp-workspace.ts';
import { renderSessionPickerModal } from './session-picker-modal.ts';
import { renderProfilePickerModal } from './profile-picker-modal.ts';
import { renderBookmarkModal } from './bookmark-modal.ts';
import { renderHelpOverlay, renderShortcutsOverlay } from './help-overlay.ts';
import { renderBlockActionsMenu } from './block-actions-overlay.ts';
import { renderAutocompleteOverlay } from './autocomplete-overlay.ts';
import { renderOnboardingWizard } from './onboarding/onboarding-wizard.ts';
import { overlayViewportBottom, replaceViewportWithOverlay } from './conversation-layout.ts';
import type { SurfaceLayer } from './surface-kit.ts';
import { layerToLines } from './surface-kit-extra.ts';
import { renderToasts } from './surface-kit-parts.ts';
import { getSharedToastCenter } from './toast-center.ts';

export interface ConversationOverlayContext {
  readonly input: InputHandler;
  readonly conversation: ConversationManager;
  readonly commandRegistry: CommandRegistry;
  readonly keybindingsManager: KeybindingsManager;
  readonly conversationWidth: number;
  readonly viewportHeight: number;
  readonly contextWindow?: number;
}

/** True while a modal covers the screen, so the composer-anchored popups stay hidden. */
function modalOpen(input: InputHandler): boolean {
  return input.modelPicker.active || input.settingsModal.active || input.configModal.active || input.mcpWorkspace.active
    || input.sessionPickerModal.active || input.profilePickerModal.active || input.bookmarkModal.active
    || input.blockActionsMenu.active || input.selectionModal.active || input.contextInspectorModal.active
    || input.helpOverlayActive || input.shortcutsOverlayActive || input.surfaceModals.active;
}

/**
 * The parts of the conversation area that are rows rather than modals:
 * onboarding (which owns the whole viewport), the @ and slash popups anchored
 * to the composer (never dimmed: you are still typing), and the search bars.
 * Every modal is a layer instead, see buildConversationLayers.
 */
export function applyConversationOverlays(
  viewport: Line[],
  context: ConversationOverlayContext,
): Line[] {
  const { input, conversationWidth, viewportHeight } = context;
  let next = viewport;
  const bottomDockInset = 1 + (input.searchManager.active || input.historySearch.active ? 1 : 0);
  const covered = modalOpen(input);

  if (input.onboardingWizard.active) {
    const layer = renderOnboardingWizard(input.onboardingWizard, conversationWidth, viewportHeight);
    next = replaceViewportWithOverlay(layerToLines(layer, conversationWidth, viewportHeight), conversationWidth, viewportHeight);
  }

  if (!input.onboardingWizard.active && !covered && input.filePicker.active) {
    const lines = renderFilePickerOverlay(input.filePicker, conversationWidth, viewportHeight);
    next = overlayViewportBottom(next, lines, conversationWidth, viewportHeight, bottomDockInset);
  }

  if (input.searchManager.active) {
    next.push(...renderSearchOverlay(input.searchManager, conversationWidth));
  }

  if (input.historySearch.active) {
    next.push(...renderHistorySearchOverlay(input.historySearch, conversationWidth));
  }

  if (!input.onboardingWizard.active && !covered && input.commandMode && input.autocomplete?.isActive) {
    const lines = renderAutocompleteOverlay(input.autocomplete, conversationWidth, viewportHeight);
    if (lines.length > 0) {
      next = overlayViewportBottom(next, lines, conversationWidth, viewportHeight, bottomDockInset);
    }
  }

  return next;
}

export interface ConversationLayerContext {
  readonly input: InputHandler;
  readonly conversation: ConversationManager;
  readonly commandRegistry: CommandRegistry;
  readonly keybindingsManager: KeybindingsManager;
  /** Full terminal size: modals are sized against the whole screen. */
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly contextWindow?: number;
  /** The permission dialog, when a request is waiting (drawn above the other modals). */
  readonly permission?: SurfaceLayer | null;
  /** Rows at the top of the screen held by the header (and the session chips row); toasts start below them. */
  readonly headerRows?: number;
  /** Rows at the bottom of the screen held by the composer and status line; toasts stay above them. */
  readonly footerRows?: number;
}

type ModalEntry = readonly [name: string, active: boolean, render: () => SurfaceLayer | null];

/**
 * Modal surfaces drawn with the surface kit, as layers the compositor stamps
 * over the dimmed screen (surface-compose.ts). Normally one modal is open;
 * when one opens another (settings opening the model picker or a theme
 * picker), both are drawn in the order they were opened (the input layer's
 * modal stack), the newer on top, each dimming what is under it. Kit-host
 * modals (command palette, confirm dialog), the permission dialog and toasts
 * sit above all of them.
 */
export function buildConversationLayers(context: ConversationLayerContext): SurfaceLayer[] {
  const { input, screenWidth: w, screenHeight: h } = context;
  // Onboarding owns the screen; only the pickers it launches draw over it.
  const onboarding = input.onboardingWizard.active;
  const entries: ModalEntry[] = [
    ['modelPicker', input.modelPicker.active, () => renderModelWorkspace(input.modelPicker, w, h)],
    ['settings', input.settingsModal.active, () => renderSettingsModal(input.settingsModal, w, h)],
    ['mcpWorkspace', input.mcpWorkspace.active, () => renderMcpWorkspace(input.mcpWorkspace, w, h)],
    ['config', !onboarding && input.configModal.active, () => renderConfigModal(input.configModal, w, h)],
    ['sessionPicker', !onboarding && input.sessionPickerModal.active, () => renderSessionPickerModal(input.sessionPickerModal, w, h)],
    ['profilePicker', !onboarding && input.profilePickerModal.active, () => renderProfilePickerModal(input.profilePickerModal, w, h)],
    ['bookmark', !onboarding && input.bookmarkModal.active, () => renderBookmarkModal(input.bookmarkModal, w, h)],
    ['blockActions', !onboarding && input.blockActionsMenu.active, () => renderBlockActionsMenu(input.blockActionsMenu, w, h)],
    ['contextInspector', !onboarding && input.contextInspectorModal.active,
      () => renderContextInspector(context.conversation, w, h, context.contextWindow, input.contextInspectorModal)],
    ['selection', input.selectionModal.active, () => renderSelectionModalOverlay(input.selectionModal, w, h)],
    ['help', input.helpOverlayActive,
      () => renderHelpOverlay(w, h, context.keybindingsManager, context.commandRegistry.getAll(), input.helpScrollOffset, input.overlayFilters.help)],
    ['shortcuts', input.shortcutsOverlayActive,
      () => renderShortcutsOverlay(w, h, context.keybindingsManager, input.shortcutsScrollOffset, input.overlayFilters.shortcuts)],
  ];
  const active = entries.filter(([, isActive]) => isActive);
  // Opened order first (the modal stack), then any active modal the stack does not name.
  const rank = (name: string): number => {
    const index = input.modalStack.indexOf(name);
    return index >= 0 ? index : input.modalStack.length + entries.findIndex(([n]) => n === name);
  };
  active.sort((a, b) => rank(a[0]) - rank(b[0]));
  const layers: SurfaceLayer[] = [];
  for (const [, , render] of active) {
    const layer = render();
    if (layer) layers.push(layer);
  }
  // Kit modals (command palette, confirm dialog, ...) stack on top of everything.
  layers.push(...input.surfaceModals.render(w, h));
  if (context.permission) layers.push(context.permission);
  // Toasts sit above everything and are never dimmed, between the header and the footer.
  const toasts = renderToasts(w, h, getSharedToastCenter().visible(), { top: context.headerRows ?? 1, bottom: h - (context.footerRows ?? 2) });
  if (toasts) layers.push(toasts);
  return layers;
}
