import { buildProviderAccountSnapshot } from '@/runtime/index.ts';
import { enrichProviderAccountsSnapshot } from '../runtime/onboarding/provider-key-capture.ts';
import type { OnboardingWizardMode } from './onboarding/onboarding-wizard.ts';
import { collectOnboardingSnapshot } from '../runtime/onboarding/index.ts';
import { cleanupMarkerRegistry, expandPrompt, findMarkerAtPos, handleBlockCopy, handleBlockSave, handleBlockToggle, handleBookmark, handleClipboardPaste, handleCopy, handleCtrlC, handleDiffApply, registerPaste } from './handler-content-actions.ts';
import { clearModalStack, handleEscape, modalOpened } from './handler-modal-stack.ts';
import { openOnboardingWizardState, type OpenOnboardingWizardOptions } from './handler-ui-state.ts';
import type { InputHandlerLike as InputHandler } from './handler-types.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export function openOnboardingWizardForHandler(
  handler: InputHandler,
    modeOrOptions: OnboardingWizardMode | OpenOnboardingWizardOptions = 'new',
  ): void {
    const options = typeof modeOrOptions === 'string' ? { mode: modeOrOptions } : modeOrOptions;
    if (!handler.modalStack.includes('onboarding')) handler.modalOpened('onboarding');
    handler.clearOnboardingModelPickerCancelState();
    openOnboardingWizardState(handler.onboardingWizard, options);
    const hydrationSerial = ++handler.onboardingHydrationSerial;
    if (options.preload === undefined) {
      handler.onboardingWizard.beginRuntimeHydration();
      void handler.hydrateOnboardingWizardFromRuntime(hydrationSerial);
    }
    handler.requestRender();
  }

export async function hydrateOnboardingWizardFromRuntimeForHandler(handler: InputHandler, hydrationSerial: number): Promise<void> {
    try {
      const snapshot = await collectOnboardingSnapshot({
        config: handler.uiServices.platform.configManager,
        shellPaths: handler.uiServices.environment.shellPaths,
        acknowledgementScope: 'project',
        subscriptions: handler.uiServices.platform.subscriptionManager,
        secrets: handler.uiServices.platform.secretsManager,
        auth: handler.uiServices.platform.localUserAuthManager,
        services: handler.uiServices.platform.serviceRegistry,
        surfaces: {
          list: () => handler.uiServices.platform.surfaceRegistry.syncConfiguredSurfaces(),
        },
        providerAccounts: {
          loadSnapshot: async () => enrichProviderAccountsSnapshot(await buildProviderAccountSnapshot({
            providerRegistry: handler.uiServices.providers.providerRegistry,
            serviceRegistry: handler.uiServices.platform.serviceRegistry,
            subscriptionManager: handler.uiServices.platform.subscriptionManager,
            secretsManager: handler.uiServices.platform.secretsManager,
          }), handler.uiServices.providers.providerRegistry),
        },
      });
      if (!handler.onboardingWizard.active || hydrationSerial !== handler.onboardingHydrationSerial) return;
      handler.onboardingWizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
      handler.requestRender();
    } catch (error) {
      if (!handler.onboardingWizard.active || hydrationSerial !== handler.onboardingHydrationSerial) return;
      const message = summarizeError(error);
      handler.onboardingWizard.failRuntimeHydration(message);
      handler.commandContext?.print?.(`Onboarding runtime snapshot failed: ${message}`);
      handler.requestRender();
    }
  }

/**
 * handlePasteForHandler - Shared paste path for Ctrl+V and middle-click.
 *
 * Tries the clipboard's image first, then its text. The clipboard itself comes
 * from `handler.clipboardSource`, so tests can hand in a clipboard without
 * touching the real one.
 *
 * The prompt is edited on the HANDLER here, not on the shortcut route state
 * that dispatched the key. feedInputTokens snapshots the prompt before
 * dispatching and would write that snapshot back over this edit, erasing the
 * paste, it does not, because it only restores a field the action left
 * untouched (see the promptBefore guard in handler-feed.ts). That guard is the
 * only reason Ctrl+V works, so it is pinned by test.
 */
export function handlePasteForHandler(handler: InputHandler): ReturnType<typeof handleClipboardPaste> {
  const result = handleClipboardPaste({
    prompt: handler.prompt,
    cursorPos: handler.cursorPos,
    pasteRegistry: handler.pasteRegistry,
    nextPasteId: handler.nextPasteId,
    imageRegistry: handler.imageRegistry,
    nextImageId: handler.nextImageId,
    saveUndoState: () => handler.saveUndoState(),
    ensureInputCursorVisible: () => handler.ensureInputCursorVisible(),
    requestRender: handler.requestRender,
  }, handler.uiServices.environment.shellPaths.workingDirectory, handler.clipboardSource);

  handler.prompt = result.prompt;
  handler.cursorPos = result.cursorPos;
  handler.nextImageId = result.nextImageId;
  handler.nextPasteId = result.nextPasteId;

  if (!result.pasted) {
    handler.conversationManager?.log('[Paste: clipboard does not contain supported text or image data]', { fg: '240' });
    handler.requestRender();
  }
  return result;
}

export function registerPasteForHandler(handler: InputHandler, content: string): string {
    const result = registerPaste({
      pasteRegistry: handler.pasteRegistry,
      nextPasteId: handler.nextPasteId,
      imageRegistry: handler.imageRegistry,
      nextImageId: handler.nextImageId,
    }, content, handler.uiServices.environment.shellPaths.workingDirectory);
    handler.nextPasteId = result.nextPasteId;
    handler.nextImageId = result.nextImageId;
    return result.marker;
  }

  /**
   * expandPrompt - Replaces paste markers with actual content.
   * If image markers are present, returns ContentPart[] for multimodal delivery.
   * Otherwise returns a plain string.
   */
export function expandPromptForHandler(handler: InputHandler, text: string) {
    return expandPrompt(handler.pasteRegistry, handler.imageRegistry, text, handler.uiServices.environment.shellPaths.workingDirectory);
  }

  /**
   * getImageAttachments - Returns a copy of the current image registry.
   * Callers can use this to attach images when building LLM messages.
   */
export function getImageAttachmentsForHandler(handler: InputHandler): Map<string, { data: string; mediaType: string }> {
    return new Map(handler.imageRegistry);
  }

  /**
   * findMarkerAtPos - Returns the start/end of an atomic marker if pos is inside one.
   * Used to make backspace/delete/arrow treat markers as single units.
   */
  /**
   * cleanupMarkerRegistry - If the given marker text is an IMAGE marker,
   * parses its ID and removes it from imageRegistry.
   */
export function cleanupMarkerRegistryForHandler(handler: InputHandler, markerText: string): void {
    cleanupMarkerRegistry(handler.imageRegistry, markerText);
  }

export function findMarkerAtPosForHandler(handler: InputHandler, pos: number): { start: number; end: number } | null {
    return findMarkerAtPos(handler.prompt, pos);
  }

export function handleCopyForHandler(handler: InputHandler): void {
    handleCopy(handler.selection, handler.getHistory, handler.requestRender, () => {
      handler.lastCopyTime = Date.now();
    });
  }

  /**
   * handleBlockCopy - Ctrl+Y: Copy the content of the block the user is
   * looking at (the viewport's bottom-most visible block, see
   * InputHandler.getBlockAnchorLine).
   */
export function handleBlockCopyForHandler(handler: InputHandler): void {
    handleBlockCopy(handler.conversationManager, () => handler.getBlockAnchorLine(), handler.requestRender, () => {
      handler.lastBlockCopyTime = Date.now();
    });
  }

  /**
   * handleBookmark - Ctrl+B: Toggle bookmark on the block the user is looking at.
   */
export function handleBookmarkForHandler(handler: InputHandler): void {
    handleBookmark(handler.conversationManager, () => handler.getBlockAnchorLine(), handler.requestRender, handler.uiServices.shell.bookmarkManager);
  }

  /**
   * handleBlockSave - Ctrl+S: Save the block the user is looking at to a file.
   */
export function handleBlockSaveForHandler(handler: InputHandler): void {
    handleBlockSave(handler.conversationManager, () => handler.getBlockAnchorLine(), handler.requestRender, handler.uiServices.shell.bookmarkManager);
  }

  /**
   * executeBlockAction - Execute a block action ID on the block the
   * BlockActionsMenu was opened for. Called when the user selects an action
   * from the menu.
   */
export function executeBlockActionForHandler(handler: InputHandler, actionId: string): void {
    switch (actionId) {
      case 'copy':     handler.handleBlockCopy(); break;
      case 'bookmark': handler.handleBookmark(); break;
      case 'toggle':   handler.handleBlockToggle(); break;
      case 'apply':    handler.handleDiffApply(); break;
    }
  }

  /**
   * handleBlockToggle - Tab (non-command mode): Toggle collapse of the block
   * the user is looking at.
   */
export function handleBlockToggleForHandler(handler: InputHandler): void {
    handleBlockToggle(handler.conversationManager, () => handler.getBlockAnchorLine(), handler.requestRender);
  }

  /**
   * handleDiffApply - Ctrl+A when a diff block is the one the user is
   * looking at: request approval and apply the diff. Returns true if a diff
   * was found and applied (so caller can skip default Ctrl+A).
   */
export function handleDiffApplyForHandler(handler: InputHandler): boolean {
    return handleDiffApply(
      handler.conversationManager,
      () => handler.getBlockAnchorLine(),
      handler.commandContext,
      handler.requestRender,
      () => `diff-apply-${Date.now()}`,
      'write',
    );
  }

  /**
   * Handle Ctrl+C:
   * - If prompt has text: clear it
   * - If prompt is empty and LLM is thinking: cancel generation
   * - If prompt is empty and idle: show exit notice (double = exit)
   */
export function handleCtrlCForHandler(handler: InputHandler): void {
    handleCtrlC(
      handler.prompt,
      () => handler.saveUndoState(),
      (value) => { handler.prompt = value; },
      (value) => { handler.cursorPos = value; },
      handler.commandContext?.cancelGeneration,
      handler.exitApp,
      handler.requestRender,
      handler.lastCtrlCTime,
      (value) => { handler.lastCtrlCTime = value; },
      (value) => { handler.showExitNotice = value; },
      handler.lastCtrlCTimeoutId,
      (value) => { handler.lastCtrlCTimeoutId = value; },
    );
  }

  /**
   * Handle Escape:
   * - If prompt has text: clear it
   * - If prompt is empty: cancel generation (double-tap not needed)
   */
  /**
   * Record that a modal has been opened and push it onto the navigation stack.
   * Call this EVERY time a modal opens (except inside openModal()).
   *
   * @param name - The modal identifier (e.g. 'settings', 'help', 'process').
   */
export function modalOpenedForHandler(handler: InputHandler, name: string): void {
    modalOpened(handler, name);
  }

  /**
   * Clear the modal navigation stack on non-modal user input (e.g. submit).
   */
export function clearModalStackForHandler(handler: InputHandler): void {
    clearModalStack(handler.modalStack);
  }

export function handleEscapeForHandler(handler: InputHandler): void {
    const result = handleEscape({
      helpOverlayActive: handler.helpOverlayActive,
      shortcutsOverlayActive: handler.shortcutsOverlayActive,
      bookmarkModal: handler.bookmarkModal,
      settingsModal: handler.settingsModal,
      mcpWorkspace: handler.mcpWorkspace,
      sessionPickerModal: handler.sessionPickerModal,
      profilePickerModal: handler.profilePickerModal,
      configModal: handler.configModal,
      contextInspectorModal: handler.contextInspectorModal,
      modelPicker: handler.modelPicker,
      filePicker: handler.filePicker,
      blockActionsMenu: handler.blockActionsMenu,
      selectionModal: handler.selectionModal,
      onboardingWizard: handler.onboardingWizard,
      commandMode: handler.commandMode,
      modalStack: handler.modalStack,
      modalReturnFocus: handler.modalReturnFocus,
      panelFocused: handler.panelFocused,
      indicatorFocused: handler.indicatorFocused,
      prompt: handler.prompt,
      cursorPos: handler.cursorPos,
      requestRender: handler.requestRender,
      saveUndoState: () => handler.saveUndoState(),
      cancelGeneration: handler.commandContext?.cancelGeneration,
      selectionCallback: handler.selectionCallback,
      autocompleteReset: () => handler.autocomplete?.reset(),
      autocompleteUpdate: (query: string) => handler.autocomplete?.update(query),
      helpScrollOffset: handler.helpScrollOffset,
      shortcutsScrollOffset: handler.shortcutsScrollOffset,
      clearOnboardingModelPickerCancelState: () => handler.clearOnboardingModelPickerCancelState(),
      restoreOnboardingModelPickerCancelState: () => handler.restoreOnboardingModelPickerCancelState(),
    });
    handler.prompt = result.prompt;
    handler.cursorPos = result.cursorPos;
    handler.commandMode = result.commandMode;
    handler.helpOverlayActive = result.helpOverlayActive;
    handler.helpScrollOffset = result.helpScrollOffset;
    handler.shortcutsOverlayActive = result.shortcutsOverlayActive;
    handler.shortcutsScrollOffset = result.shortcutsScrollOffset;
    handler.selectionCallback = result.selectionCallback;
    handler.panelFocused = result.panelFocused;
    handler.indicatorFocused = result.indicatorFocused;
    handler.modalReturnFocus = result.modalReturnFocus;
}
