/**
 * feed-context-factory.ts — Construction and mutable-field sync for InputFeedContext.
 *
 * Extracted from handler.ts (review follow-up, 0.18.23) to keep handler.ts under the
 * 800-line architecture cap.
 *
 * Two exported functions:
 *   - `buildInitialFeedContext` — assembles the long-lived InputFeedContext from
 *     pre-built field groups. Called once at InputHandler construction time.
 *   - `syncFeedContextMutableFields` — copies mutable scalar fields into the
 *     already-allocated context before each feed() dispatch.
 */
import type { InputFeedContext } from './handler-feed.ts';
import type { SelectionManager } from './selection.ts';
import type { InfiniteBuffer } from '../core/history.ts';
import type { CommandRegistry, CommandContext } from './command-registry.ts';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { FilePickerModal } from './file-picker.ts';
import type { ModelPickerModal } from './model-picker.ts';
import type { SelectionModal } from './selection-modal.ts';
import type { SelectionResult } from './selection-modal.ts';
import type { SearchManager } from './search.ts';
import type { InputHistory, HistorySearch } from './input-history.ts';
import type { ConversationManager } from '../core/conversation';
import type { BlockActionsMenu } from '../renderer/block-actions.ts';
import type { ContextInspectorModal } from '../renderer/context-inspector.ts';
import type { BookmarkModal } from './bookmark-modal.ts';
import type { SettingsModal } from './settings-modal.ts';
import type { McpWorkspace } from './mcp-workspace.ts';
import type { SessionPickerModal } from './session-picker-modal.ts';
import type { ConfigModal } from './config-modal.ts';
import type { ProfilePickerModal } from './profile-picker-modal.ts';
import type { OnboardingWizardController } from './onboarding/onboarding-wizard.ts';
import type { WrappedPromptInfo } from './handler-prompt-buffer.ts';
import type { Panel } from '../panels/types.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { KeybindingsManager } from './keybindings.ts';
import type { ModelPickerTarget } from './model-picker.ts';
import type { KillRing } from './kill-ring.ts';
import type { PanelMouseLayout } from './handler-feed-routes.ts';
import type { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { PanelBurstGuardState } from './panel-paste-flood-guard.ts';

/**
 * Initial mutable scalar values for InputFeedContext.
 *
 * **Mutable fields** (synced per-feed via syncFeedContextMutableFields or inside
 * action closures that call syncFeedContextMutableFields):
 *   - `prompt`, `cursorPos` — current text buffer state
 *   - `commandMode`, `panelFocused`, `indicatorFocused` — focus-mode flags
 *   - `helpOverlayActive`, `helpScrollOffset` — help overlay state
 *   - `shortcutsOverlayActive`, `shortcutsScrollOffset` — shortcuts overlay state
 *   - `nextPasteId`, `nextImageId` — monotonically increasing ID counters
 *   - `mouseDownRow`, `mouseDownCol` — drag-tracking coordinates
 *   - `contentWidth` — reflow width, updated by setContentWidth()
 *   - `selectionCallback` — current selection modal callback (nullable)
 */
export interface FeedContextMutableInit {
  prompt: string;
  cursorPos: number;
  inputScrollTop: number;
  commandMode: boolean;
  panelFocused: boolean;
  indicatorFocused: boolean;
  helpOverlayActive: boolean;
  helpScrollOffset: number;
  shortcutsOverlayActive: boolean;
  shortcutsScrollOffset: number;
  nextPasteId: number;
  nextImageId: number;
  mouseDownRow: number;
  mouseDownCol: number;
  contentWidth: number;
  panelMouseLayout: PanelMouseLayout | null;
  selectionCallback: ((result: SelectionResult | null) => void) | null;
}

/**
 * Stable (readonly) service references for InputFeedContext.
 *
 * **Stable references** (set once at construction, never reallocated):
 *   - `pasteRegistry`, `imageRegistry` — owned Maps, never replaced
 *   - `selectionModal`, `bookmarkModal`, `settingsModal`, `sessionPickerModal`,
 *     `profilePickerModal` — modal objects constructed once
 *   - `filePicker`, `modelPicker`, `contextInspectorModal`, `blockActionsMenu`,
 *     `searchManager`, `historySearch`, `onboardingWizard` — service objects constructed once
 *   - `panelManager`, `keybindingsManager` — from uiServices, stable
 *   - `modalStack` — reference to the handler's shared array
 *   - `getHistory`, `getViewportHeight`, `getScrollTop`, `scroll`, `exitApp` — callbacks
 *   - `commandRegistry`, `commandContext`, `autocomplete`, `inputHistory`,
 *     `conversationManager` — wired after construction; synced at feed() entry only
 *     (not per-action) since no in-feed action changes them
 *   - `focusTracker` — shared instance from uiServices.platform, mutated
 *     directly by feedInputTokens() on 'focus' tokens; never reallocated
 *
 * **Rationale:** per-feed mutation on a single object avoids per-keystroke GC pressure
 * from ~80-field object allocation. Stable references are service handles that never
 * need to change after construction.
 */
export interface FeedContextStableRefs {
  selection: SelectionManager;
  pasteRegistry: Map<string, string>;
  imageRegistry: Map<string, { data: string; mediaType: string }>;
  projectRoot: string;
  selectionModal: SelectionModal;
  bookmarkModal: BookmarkModal;
  settingsModal: SettingsModal;
  mcpWorkspace: McpWorkspace;
  sessionPickerModal: SessionPickerModal;
  profilePickerModal: ProfilePickerModal;
  configModal: ConfigModal;
  historySearch: HistorySearch;
  commandRegistry: CommandRegistry | null;
  commandContext: CommandContext | undefined;
  autocomplete: AutocompleteEngine | null;
  filePicker: FilePickerModal;
  modelPicker: ModelPickerModal;
  onboardingWizard: OnboardingWizardController;
  contextInspectorModal: ContextInspectorModal;
  blockActionsMenu: BlockActionsMenu;
  searchManager: SearchManager;
  modalStack: string[];
  inputHistory: InputHistory | null;
  conversationManager: ConversationManager | null;
  panelManager: PanelManager;
  keybindingsManager: KeybindingsManager;
  killRing: KillRing;
  focusTracker: FocusTracker;
  /** item 5 — paste-flood guard state, mutated in place (never reallocated). */
  panelBurstGuard: PanelBurstGuardState;
  getHistory: () => InfiniteBuffer;
  getViewportHeight: () => number;
  getScrollTop: () => number;
  scroll: (delta: number) => void;
  exitApp: () => void;
}

/** Bound method closures for InputFeedContext. Built in handler.ts where private members are accessible. */
export interface FeedContextClosures {
  modalOpened: (name: string) => void;
  handleEscape: () => void;
  /** Deliver a concealed submission; returns true when concealed mode consumed it. */
  submitConcealedInput: (value: string) => boolean;
  handleCopy: () => void;
  handleCtrlC: () => void;
  handleBlockCopy: () => void;
  handleBookmark: () => void;
  handleBlockSave: () => void;
  handleDiffApply: () => boolean;
  handleUndo: () => void;
  handleRedo: () => void;
  handlePaste: () => void;
  saveUndoState: () => void;
  /** Save undo state with text-insertion coalescing (burst typing merges into one group). */
  saveUndoStateForText: () => void;
  /** Break the current coalescing group (call on cursor moves). */
  breakUndoCoalesce: () => void;
  ensureInputCursorVisible: (contentWidth?: number) => void;
  registerPaste: (content: string) => string;
  executeBlockAction: (id: string) => void;
  cyclePanelTab: (direction: 'next' | 'prev') => void;
  onPanelInputConsumed: (activePanel: Panel | null, key: string) => void;
  getWrappedPromptInfo: (contentWidth: number) => WrappedPromptInfo;
  moveCursorVertical: (direction: -1 | 1) => boolean;
  handlePathCompletion: () => boolean;
  handleBlockToggle: () => void;
  findMarkerAtPos: (pos: number) => { start: number; end: number } | null;
  cleanupMarkerRegistry: (text: string) => void;
  expandPrompt: (text: string) => string | import('@pellux/goodvibes-sdk/platform/providers').ContentPart[];
  openModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings' | 'onboarding') => boolean;
  openProviderModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings' | 'onboarding') => boolean;
  onModelPickerCommit: () => boolean;
  onOnboardingAction: (action: import('./onboarding/onboarding-wizard.ts').OnboardingWizardAction) => void;
  /** Called after any wizard step navigation so the handler can persist progress. */
  onStepChange?: () => void;
}

/**
 * buildInitialFeedContext — Allocate the single InputFeedContext that lives for the
 * lifetime of the InputHandler.
 *
 * Accepts pre-built field groups from handler.ts where private access is available.
 * The resulting context object is mutated in place on every feed() call via
 * syncFeedContextMutableFields — no re-allocation occurs per keystroke.
 *
 * @param mutable  Initial mutable scalar values (synced per-feed).
 * @param stable   Stable service references (set once, never replaced).
 * @param closures Pre-built bound method closures (built in handler.ts).
 */
export function buildInitialFeedContext(
  mutable: FeedContextMutableInit,
  stable: FeedContextStableRefs,
  closures: FeedContextClosures,
): InputFeedContext {
  const noop = (): void => {};
  return {
    // --- mutable scalars ---
    ...mutable,
    // --- requestRender: placeholder, swapped per-feed to buffered version ---
    requestRender: noop,
    // --- stable refs ---
    ...stable,
    // --- closures ---
    ...closures,
  };
}

/**
 * syncFeedContextMutableFields — Copy mutable scalar fields into the reused
 * InputFeedContext object.
 *
 * **Fields synced (updated on every call):**
 *   - `prompt` — current prompt text buffer
 *   - `cursorPos` — caret position within prompt
 *   - `commandMode` — whether command-mode prefix is active
 *   - `panelFocused` — whether the active panel owns keyboard focus
 *   - `indicatorFocused` — whether the status indicator owns focus
 *   - `helpOverlayActive` / `helpScrollOffset` — help overlay visibility and scroll
 *   - `shortcutsOverlayActive` / `shortcutsScrollOffset` — shortcuts overlay state
 *   - `selectionCallback` — the current in-flight selection modal callback
 *   - `nextPasteId` / `nextImageId` — monotonically increasing allocation counters
 *   - `mouseDownRow` / `mouseDownCol` — drag-start coordinates
 *
 * **Fields intentionally excluded (synced only at feed() entry, not here):**
 *   - `contentWidth` — semi-stable; only changes on terminal resize via setContentWidth().
 *     Synced at feed() entry because it is only relevant for layout, not action-reaction
 *     sequences within a single feed.
 *   - `commandRegistry`, `commandContext` — wired after construction via
 *     setCommandRegistry(); synced at feed() entry since no in-feed action changes them.
 *   - `autocomplete` — wired after construction; synced at feed() entry.
 *   - `inputHistory`, `conversationManager` — late-wired service handles; stable within
 *     a feed. Synced at feed() entry only.
 *   - `requestRender` — swapped to a buffered version at feed() entry and restored in
 *     the finally block; not managed by this function.
 *
 * Called from within action closures (`handleEscape`, `handleCtrlC`, `handleUndo`,
 * `handleRedo`, `handlePaste`) that mutate handler state mid-feed, so subsequent
 * route handlers see updated values without re-reading handler fields.
 *
 * @param fields  Current mutable field values from the handler.
 * @param ctx     The InputFeedContext to update in place.
 */
export function syncFeedContextMutableFields(
  fields: FeedContextMutableInit,
  ctx: InputFeedContext,
): void {
  ctx.prompt = fields.prompt;
  ctx.cursorPos = fields.cursorPos;
  ctx.inputScrollTop = fields.inputScrollTop;
  ctx.commandMode = fields.commandMode;
  ctx.panelFocused = fields.panelFocused;
  ctx.indicatorFocused = fields.indicatorFocused;
  ctx.helpOverlayActive = fields.helpOverlayActive;
  ctx.helpScrollOffset = fields.helpScrollOffset;
  ctx.shortcutsOverlayActive = fields.shortcutsOverlayActive;
  ctx.shortcutsScrollOffset = fields.shortcutsScrollOffset;
  ctx.selectionCallback = fields.selectionCallback;
  ctx.nextPasteId = fields.nextPasteId;
  ctx.nextImageId = fields.nextImageId;
  ctx.mouseDownRow = fields.mouseDownRow;
  ctx.mouseDownCol = fields.mouseDownCol;
  ctx.contentWidth = fields.contentWidth;
  ctx.panelMouseLayout = fields.panelMouseLayout;
}
