import { buildProviderAccountSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/provider-accounts/registry';
import type { OnboardingWizardMode } from './onboarding/onboarding-wizard.ts';
import { collectOnboardingSnapshot, readOnboardingCheckMarker, writeOnboardingCheckMarker } from '../runtime/onboarding/index.ts';
import { cleanupMarkerRegistry, expandPrompt, findMarkerAtPos, handleBlockCopy, handleBlockRerun, handleBlockSave, handleBlockToggle, handleBookmark, handleClipboardPaste, handleCopy, handleCtrlC, handleDiffApply, registerPaste } from './handler-content-actions.ts';
import { clearModalStack, handleEscape, modalOpened } from './handler-modal-stack.ts';
import { openOnboardingWizardState, type OpenOnboardingWizardOptions } from './handler-ui-state.ts';
import type { InputHandler } from './handler.ts';

export function openOnboardingWizardForHandler(
  handler: InputHandler,
    modeOrOptions: OnboardingWizardMode | OpenOnboardingWizardOptions = 'new',
  ): void {
    const options = typeof modeOrOptions === 'string' ? { mode: modeOrOptions } : modeOrOptions;
    const userMarker = readOnboardingCheckMarker(handler.uiServices.environment.shellPaths, 'user');
    if (!userMarker.payload) {
      try {
        writeOnboardingCheckMarker(handler.uiServices.environment.shellPaths, {
          scope: 'user',
          source: 'wizard',
          mode: options.mode ?? 'new',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        handler.commandContext?.print?.(`Onboarding check marker could not be written: ${message}`);
      }
    }
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
          loadSnapshot: () => buildProviderAccountSnapshot({
            providerRegistry: handler.uiServices.providers.providerRegistry,
            serviceRegistry: handler.uiServices.platform.serviceRegistry,
            subscriptionManager: handler.uiServices.platform.subscriptionManager,
            secretsManager: handler.uiServices.platform.secretsManager,
          }),
        },
      });
      if (!handler.onboardingWizard.active || hydrationSerial !== handler.onboardingHydrationSerial) return;
      handler.onboardingWizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
      handler.requestRender();
    } catch (error) {
      if (!handler.onboardingWizard.active || hydrationSerial !== handler.onboardingHydrationSerial) return;
      const message = error instanceof Error ? error.message : String(error);
      handler.onboardingWizard.failRuntimeHydration(message);
      handler.commandContext?.print?.(`Onboarding runtime snapshot failed: ${message}`);
      handler.requestRender();
    }
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
   * handleBlockCopy - Ctrl+Y: Copy the content of the nearest code/tool block.
   */
export function handleBlockCopyForHandler(handler: InputHandler): void {
    handleBlockCopy(handler.conversationManager, handler.getScrollTop, handler.requestRender, () => {
      handler.lastBlockCopyTime = Date.now();
    });
  }

  /**
   * handleBookmark - Ctrl+B: Toggle bookmark on the nearest block.
   */
export function handleBookmarkForHandler(handler: InputHandler): void {
    handleBookmark(handler.conversationManager, handler.getScrollTop, handler.requestRender, handler.uiServices.shell.bookmarkManager);
  }

  /**
   * handleBlockSave - Ctrl+S: Save nearest block content to a file.
   */
export function handleBlockSaveForHandler(handler: InputHandler): void {
    handleBlockSave(handler.conversationManager, handler.getScrollTop, handler.requestRender, handler.uiServices.shell.bookmarkManager);
  }

  /**
   * executeBlockAction - Execute a block action ID on the nearest block.
   * Called when the user selects an action from the BlockActionsMenu.
   */
export function executeBlockActionForHandler(handler: InputHandler, actionId: string): void {
    switch (actionId) {
      case 'copy':     handler.handleBlockCopy(); break;
      case 'bookmark': handler.handleBookmark(); break;
      case 'toggle':   handler.handleBlockToggle(); break;
      case 'apply':    handler.handleDiffApply(); break;
      case 'rerun':    handler.handleBlockRerun(); break;
    }
  }

  /**
   * handleBlockRerun - Re-run the tool call for the nearest tool block.
   * Emits a tool-rerun event for the orchestrator to handle.
   */
export function handleBlockRerunForHandler(handler: InputHandler): void {
    handleBlockRerun(handler.conversationManager, handler.getScrollTop, handler.requestRender);
  }

  /**
   * handleBlockToggle - Tab (non-command mode): Toggle collapse of nearest block.
   */
export function handleBlockToggleForHandler(handler: InputHandler): void {
    handleBlockToggle(handler.conversationManager, handler.getScrollTop, handler.requestRender);
  }

  /**
   * handleDiffApply - Ctrl+A when a diff block is nearest: request approval and apply the diff.
   * Returns true if a diff was found and applied (so caller can skip default Ctrl+A).
   */
export function handleDiffApplyForHandler(handler: InputHandler): boolean {
    return handleDiffApply(
      handler.conversationManager,
      handler.getScrollTop,
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
      agentDetailModal: handler.agentDetailModal,
      liveTailModal: handler.liveTailModal,
      settingsModal: handler.settingsModal,
      sessionPickerModal: handler.sessionPickerModal,
      profilePickerModal: handler.profilePickerModal,
      contextInspectorModal: handler.contextInspectorModal,
      processModal: handler.processModal,
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
