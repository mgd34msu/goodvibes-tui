/**
 * handler-types.ts, Leaf interface for InputHandler.
 *
 * Extracted from handler.ts to break circular import chains between handler.ts
 * and handler-interactions.ts / handler-onboarding.ts / handler-onboarding-cloudflare.ts.
 *
 * The interface is the union of all `handler.*` accesses in those three files.
 * InputHandler declares `implements InputHandlerLike`; no cycle is created
 * because this file imports only from leaf modules (no import from handler.ts).
 */
import { type createOAuthLocalListener } from '@pellux/goodvibes-sdk/platform/config';
import type { OnboardingWizardController, OnboardingWizardAction } from './onboarding/onboarding-wizard.ts';
import type { OnboardingWizardSnapshot, OpenOnboardingWizardOptions } from './handler-ui-state.ts';
import type {
  OnboardingApplyRequest,
  OnboardingVerificationItem,
} from '../runtime/onboarding/index.ts';
import type { UiRuntimeServices } from '../runtime/ui-services.ts';
import type { CommandContext } from './command-registry.ts';
import type { ConversationManager } from '../core/conversation';
import type { ModelPickerModal, ModelPickerTarget } from './model-picker.ts';
import type { ClipboardPasteSource } from './handler-content-actions.ts';
import type { SelectionManager } from '@pellux/goodvibes-terminal-shell';
import type { InfiniteBuffer } from '@pellux/goodvibes-terminal-shell';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { BookmarkModal } from './bookmark-modal.ts';
import type { SettingsModal } from './settings-modal.ts';
import type { McpWorkspace } from './mcp-workspace.ts';
import type { SessionPickerModal } from './session-picker-modal.ts';
import type { ConfigModal } from './config-modal.ts';
import type { ProfilePickerModal } from './profile-picker-modal.ts';
import type { ContextInspectorModal } from '../renderer/context-inspector.ts';
import type { FilePickerModal } from './file-picker.ts';
import type { BlockActionsMenu } from '../renderer/block-actions.ts';
import type { SelectionModal } from './selection-modal.ts';
import type { SelectionResult } from './selection-modal.ts';
export interface OnboardingRuntimePosture {
  readonly serviceEnabled: boolean;
  readonly serviceAutostart: boolean;
  readonly restartOnFailure: boolean;
  readonly expectedDaemon: boolean;
  readonly expectedHttpListener: boolean;
  readonly serverBacked: boolean;
  readonly remoteExposure: boolean;
}

type SelectionModalCallback = (result: SelectionResult | null) => void;

/**
 * Public surface of InputHandler consumed by handler-interactions.ts,
 * handler-onboarding.ts, and handler-onboarding-cloudflare.ts.
 */
export interface InputHandlerLike {
  // ── Core render / lifecycle ──────────────────────────────────────────────
  requestRender: () => void;
  exitApp: () => void;

  // ── Services ─────────────────────────────────────────────────────────────
  readonly uiServices: Pick<UiRuntimeServices,
    | 'agents'
    | 'environment'
    | 'platform'
    | 'providers'
    | 'sessions'
    | 'shell'
  >;
  commandContext: CommandContext | undefined;

  // ── Prompt / cursor state ────────────────────────────────────────────────
  prompt: string;
  cursorPos: number;
  showExitNotice: boolean;

  // ── Selection / history ──────────────────────────────────────────────────
  selection: SelectionManager;
  getHistory: () => InfiniteBuffer;
  getScrollTop: () => number;
  conversationManager: ConversationManager | null;

  // ── Paste / image registries ─────────────────────────────────────────────
  pasteRegistry: Map<string, string>;
  nextPasteId: number;
  imageRegistry: Map<string, { data: string; mediaType: string }>;
  nextImageId: number;
  /**
   * The clipboard this composer pastes from. Swappable so tests can supply a
   * clipboard instead of reaching for the machine's real one.
   */
  clipboardSource: ClipboardPasteSource;

  // ── Timing ───────────────────────────────────────────────────────────────
  lastCopyTime: number;
  lastBlockCopyTime: number;
  lastCtrlCTime: number;
  lastCtrlCTimeoutId: ReturnType<typeof setTimeout> | null;

  // ── Modal state ───────────────────────────────────────────────────────────
  commandMode: boolean;
  modalStack: string[];
  modalReturnFocus: 'prompt' | 'panel' | 'indicator';
  panelFocused: boolean;
  indicatorFocused: boolean;
  helpOverlayActive: boolean;
  helpScrollOffset: number;
  shortcutsOverlayActive: boolean;
  shortcutsScrollOffset: number;
  selectionCallback: SelectionModalCallback | null;
  autocomplete: AutocompleteEngine | null;

  // ── Modal objects ─────────────────────────────────────────────────────────
  bookmarkModal: BookmarkModal;
  settingsModal: SettingsModal;
  mcpWorkspace: McpWorkspace;
  sessionPickerModal: SessionPickerModal;
  profilePickerModal: ProfilePickerModal;
  configModal: ConfigModal;
  contextInspectorModal: ContextInspectorModal;
  modelPicker: ModelPickerModal;
  filePicker: FilePickerModal;
  blockActionsMenu: BlockActionsMenu;
  selectionModal: SelectionModal;

  // ── Onboarding ────────────────────────────────────────────────────────────
  onboardingWizard: OnboardingWizardController;
  onboardingModelPickerCancelSnapshot: OnboardingWizardSnapshot | null;
  onboardingHydrationSerial: number;
  onboardingApplyPending: boolean;
  onboardingOpenAiListenerSerial: number;

  // ── Methods: modal lifecycle ──────────────────────────────────────────────
  modalOpened(name: string): void;
  saveUndoState(): void;
  ensureInputCursorVisible(contentWidth?: number): void;

  // ── Methods: block actions (dispatched in executeBlockAction) ────────────
  handleBlockCopy(): void;
  handleBookmark(): void;
  handleBlockToggle(): void;
  handleDiffApply(): boolean;
  /** The absolute history line of the bottom-most visible block, the block
   *  the user is actually looking at, used to anchor every one of the
   *  actions above instead of the (possibly off-screen-above) raw scrollTop. */
  getBlockAnchorLine(): number;

  // ── Methods: onboarding ───────────────────────────────────────────────────
  hydrateOnboardingWizardFromRuntime(hydrationSerial: number): Promise<void>;
  clearOnboardingModelPickerCancelState(): void;
  restoreOnboardingModelPickerCancelState(): void;
  clearOnboardingPendingModelPickerTarget(): void;
  refreshOnboardingHydration(options?: { readonly preserveValues?: boolean; readonly targetStepId?: string }): Promise<void>;
  handleOpenAiSubscriptionStart(): Promise<void>;
  handleOpenAiSubscriptionFinish(): Promise<void>;
  syncRuntimeFromOnboardingRequest(request: ReturnType<OnboardingWizardController['buildApplyRequest']>): void;
  getOnboardingConfigValue(request: OnboardingApplyRequest, key: string): unknown;
  getOnboardingRuntimePosture(request: OnboardingApplyRequest): OnboardingRuntimePosture;
  restartOnboardingExternalServicesIfNeeded(request: OnboardingApplyRequest): Promise<OnboardingVerificationItem[]>;
  verifyOnboardingRuntimePosture(request: OnboardingApplyRequest): OnboardingVerificationItem[];

  // ── Method: model picker ──────────────────────────────────────────────────
  openModelPickerWithTarget(target: ModelPickerTarget, source?: 'settings' | 'onboarding'): boolean;
  openProviderModelPickerWithTarget(target: ModelPickerTarget, source?: 'settings' | 'onboarding'): boolean;

  // ── Method: onboarding action ─────────────────────────────────────────────
  completeOpenAiSubscriptionFromListener(
    listener: Awaited<ReturnType<typeof createOAuthLocalListener>>,
    verifier: string,
    serial: number,
  ): Promise<void>;
  handleOnboardingAction(action: OnboardingWizardAction): Promise<void>;
}
