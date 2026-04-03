#!/usr/bin/env bun
// TODO: main() is ~1240 lines and should be refactored into composable modules
// (input handling, rendering, session management, agent lifecycle, etc.).
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, openSync, readSync, closeSync, renameSync } from 'fs';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { join, dirname } from 'path';
import { Compositor } from './renderer/compositor.ts';
import { createEmptyLine, type Line } from './types/grid.ts';
import { UIFactory } from './renderer/ui-factory.ts';
import { EventBus } from './core/event-bus.ts';
import { ConversationManager } from './core/conversation.ts';
import { Orchestrator } from './core/orchestrator.ts';
import { InputHandler } from './input/handler.ts';
import { SelectionManager } from './input/selection.ts';
import { config, configManager } from './config/index.ts';
import { providerRegistry } from './providers/registry.ts';
import { ToolRegistry } from './tools/registry.ts';
import { registerAllTools } from './tools/index.ts';
import { FileUndoManager } from './state/file-undo.ts';
import { agentOrchestrator } from './agents/orchestrator.ts';
import { PermissionManager } from './permissions/manager.ts';
import { AcpManager } from './acp/manager.ts';
import { getHookDispatcher } from './hooks/index.ts';
import { PermissionPromptUI } from './permissions/prompt.ts';
import type { PermissionRequest } from './permissions/prompt.ts';
import { CommandRegistry } from './input/command-registry.ts';
import type { CommandContext } from './input/command-registry.ts';
import { renderFilePickerOverlay } from './renderer/file-picker-overlay.ts';
import { renderModelPickerOverlay, MODEL_PICKER_CHROME_LINES } from './renderer/model-picker-overlay.ts';
import { renderSearchOverlay } from './renderer/search-overlay.ts';
import { renderHistorySearchOverlay } from './renderer/history-search-overlay.ts';
import { renderProcessIndicator } from './renderer/process-indicator.ts';
import { AgentManager } from './tools/agent/index.ts';
import { WrfcController } from './agents/wrfc-controller.ts';
import { ProcessManager } from './tools/shared/process-manager.ts';
import { renderSelectionModalOverlay } from './renderer/selection-modal-overlay.ts';
import { registerBuiltinCommands } from './input/commands.ts';
import { WebhookNotifier, setWebhookNotifier } from './integrations/webhooks.ts';
import { ScheduleManager } from './tools/workflow/index.ts';
import { InputHistory } from './input/input-history.ts';
import { getTierPromptSupplement, getTierForContextWindow } from './providers/tier-prompts.ts';
import { GitStatusProvider } from './renderer/git-status.ts';
import type { GitHeaderInfo } from './renderer/git-status.ts';
import { renderHelpOverlay, renderShortcutsOverlay } from './renderer/help-overlay.ts';
import { renderSettingsModal } from './renderer/settings-modal.ts';
import { renderSessionPickerModal } from './renderer/session-picker-modal.ts';
import { renderProfilePickerModal } from './renderer/profile-picker-modal.ts';
import { renderBookmarkModal } from './renderer/bookmark-modal.ts';
import { renderProcessModal } from './renderer/process-modal.ts';
import { renderAgentDetailModal } from './renderer/agent-detail-modal.ts';
import { renderLiveTailModal } from './renderer/live-tail-modal.ts';
import { renderContextInspector } from './renderer/context-inspector.ts';
import { renderAutocompleteOverlay } from './renderer/autocomplete-overlay.ts';
import { getSessionManager } from './sessions/manager.ts';
import type { SessionMeta } from './sessions/manager.ts';
import { logger } from './utils/logger.ts';
import { getPinned } from './providers/favorites.ts';
import { initModelLimits, getContextWindowForModel } from './providers/model-limits.ts';
import { initBenchmarks } from './providers/model-benchmarks.ts';
import { setSyntheticBus } from './providers/synthetic.ts';
import { initCatalog, getConfiguredProviderIds } from './providers/model-catalog.ts';
import { getPanelManager } from './panels/panel-manager.ts';
import { registerBuiltinPanels } from './panels/builtin-panels.ts';
import { renderPanelTabBar } from './renderer/panel-tab-bar.ts';
import { mcpRegistry } from './mcp/registry.ts';
import { getKeybindingsManager } from './input/keybindings.ts';
import { sessionMemoryStore } from './core/session-memory.ts';
import { bootstrapRuntime } from './runtime/bootstrap.ts';
import type { BootstrapContext } from './runtime/bootstrap.ts';
import { ModeManager } from './state/mode-manager.ts';
import type { HITLMode } from './state/mode-manager.ts';
import type { HookPhase, HookCategory, HookEventPath } from './hooks/types.ts';


const ALT_SCREEN_ENTER = '\x1b[?1049h';
const ALT_SCREEN_EXIT  = '\x1b[?1049l';
const MOUSE_ENABLE     = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_DISABLE    = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';
const CURSOR_HIDE      = '\x1b[?25l';
const CURSOR_SHOW      = '\x1b[?25h';
const CLEAR_SCREEN     = '\x1b[2J\x1b[3J\x1b[H';
const KEYBOARD_EXT_ENABLE  = '\x1b[>4;2m' + '\x1b[?1u';
const KEYBOARD_EXT_DISABLE = '\x1b[>4;0m' + '\x1b[?1l';
const PASTE_ENABLE     = '\x1b[?2004h';
const PASTE_DISABLE    = '\x1b[?2004l';

/** User session persistence — .goodvibes/tui/sessions/ */
const USER_SESSIONS_DIR = join(process.cwd(), '.goodvibes', 'tui', 'sessions');
const LAST_SESSION_POINTER = join(USER_SESSIONS_DIR, 'last-session.json');

/** Crash recovery file — written periodically and deleted on clean exit. */
const RECOVERY_FILE = join(homedir(), '.goodvibes', 'tui', 'recovery.jsonl');

/** Generate an 8-character lowercase hex ID (matches agent session pattern). */
function generateUserSessionId(): string {
  return randomBytes(4).toString('hex');
}

/** Write the last-session pointer so the next startup knows which session to resume. */
function writeLastSessionPointer(sessionId: string): void {
  try {
    mkdirSync(USER_SESSIONS_DIR, { recursive: true });
    writeFileSync(LAST_SESSION_POINTER, JSON.stringify({ sessionId, timestamp: new Date().toISOString() }) + '\n', 'utf-8');
  } catch (e) { logger.debug('writeLastSessionPointer failed', { error: String(e) }); }
}

/** Read the last-session pointer. Returns null if none exists or on error. */
function readLastSessionPointer(): string | null {
  try {
    if (existsSync(LAST_SESSION_POINTER)) {
      const data = JSON.parse(readFileSync(LAST_SESSION_POINTER, 'utf-8')) as { sessionId?: unknown };
      if (typeof data.sessionId === 'string' && data.sessionId.trim()) return data.sessionId;
    }
  } catch (e) { logger.debug('readLastSessionPointer failed', { error: String(e) }); }
  return null;
}

/**
 * Save the current conversation as a JSONL session file.
 * Uses the SessionManager to write meta + messages.
 */
function saveConversation(
  data: { messages: object[]; timestamp?: number },
  sessionId: string,
  model: string,
  provider: string,
  title = '',
): void {
  try {
    const sm = getSessionManager();
    const meta: SessionMeta = {
      title,
      model,
      provider,
      timestamp: data.timestamp ?? Date.now(),
    };
    sm.save(sessionId, data.messages, meta);
    writeLastSessionPointer(sessionId);
  } catch (e) { logger.debug('saveConversation failed', { error: String(e) }); }
}

/**
 * Load the last user session from the pointer file.
 * Returns the messages array (compatible with ConversationManager.fromJSON),
 * or null if no session exists.
 */
function loadLastConversation(): { messages: Array<Record<string, unknown>> } | null {
  try {
    const lastId = readLastSessionPointer();
    if (!lastId) {
      // Migration: check old format
      const oldPath = join(homedir(), '.goodvibes', 'conversations', 'last.json');
      if (existsSync(oldPath)) {
        try {
          const raw = readFileSync(oldPath, 'utf-8');
          const data = JSON.parse(raw) as { messages?: unknown };
          if (data.messages && Array.isArray(data.messages)) {
            const migrationId = `user-${generateUserSessionId()}`;
            const sm = getSessionManager();
            const meta: import('./sessions/manager.ts').SessionMeta = {
              title: '',
              model: '',
              provider: '',
              timestamp: Date.now(),
            };
            sm.save(migrationId, data.messages as Array<Record<string, unknown>>, meta);
            writeLastSessionPointer(migrationId);
            logger.debug('Migrated old conversation from conversations/last.json', { newSessionId: migrationId });
            return { messages: data.messages as Array<Record<string, unknown>> };
          }
        } catch (e) { logger.debug('Old session migration failed', { error: String(e) }); }
      }
      return null;
    }
    const sm = getSessionManager();
    const { messages } = sm.load(lastId);
    return { messages: messages as Array<Record<string, unknown>> };
  } catch (e) { logger.debug('loadLastConversation failed', { error: String(e) }); }
  return null;
}

function writeRecoveryFile(conversation: ConversationManager, sessionId: string): void {
  try {
    const data = conversation.toJSON() as { messages: Array<Record<string, unknown>> };
    if (!data.messages || data.messages.length === 0) return;
    const lines: string[] = [];
    lines.push(JSON.stringify({ type: 'meta', sessionId, title: conversation.title ?? '', timestamp: Date.now() }));
    for (const msg of data.messages) {
      lines.push(JSON.stringify({ type: 'message', ...msg }));
    }
    const tmpPath = RECOVERY_FILE + '.tmp';
    mkdirSync(dirname(RECOVERY_FILE), { recursive: true });
    writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf-8');
    renameSync(tmpPath, RECOVERY_FILE);
  } catch (err) {
    logger.debug('[Recovery] Write failed', { error: String(err) });
  }
}

function deleteRecoveryFile(): void {
  try { unlinkSync(RECOVERY_FILE); } catch { /* missing file is fine */ }
}

function checkRecoveryFile(): { title: string; timestamp: number; sessionId: string } | null {
  try {
    if (!existsSync(RECOVERY_FILE)) return null;
    // Check if recovery file is newer than last clean exit
    const recoveryMtime = statSync(RECOVERY_FILE).mtimeMs;
    const pointerPath = LAST_SESSION_POINTER;
    if (existsSync(pointerPath)) {
      const lastCleanMtime = statSync(pointerPath).mtimeMs;
      if (recoveryMtime <= lastCleanMtime) return null; // clean exit happened after recovery write
    }
    // Read only first 4KB for the meta line
    const fd = openSync(RECOVERY_FILE, 'r');
    const buf = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
    const meta = JSON.parse(firstLine) as { title?: string; timestamp?: number; sessionId?: string };
    return { title: meta.title ?? '', timestamp: meta.timestamp ?? 0, sessionId: meta.sessionId ?? '' };
  } catch (err) {
    logger.debug('[Recovery] Check failed', { error: String(err) });
    return null;
  }
}

async function main() {
  const stdout = process.stdout;
  const stdin = process.stdin;

  // ── Bootstrap all runtime subsystems ─────────────────────────────────────
  // bootstrapRuntime initializes all subsystems in dependency order and returns
  // a fully-wired BootstrapContext. main.ts owns terminal setup, the render loop,
  // stdin input, and signal handlers — everything else is in bootstrap.
  const ctx: BootstrapContext = await bootstrapRuntime(stdout);
  const {
    bus,
    conversation,
    orchestrator,
    runtime,
    toolRegistry,
    compositor,
    selection,
    commandContext,
    commandRegistry,
    inputHistory,
    hookDispatcher,
    gitStatusProvider,
    lastGitInfoRef,
    bootstrapUnsubs,
    agentStatusIntervalRef,
    orchestratorRefs,
    loadLastConversation,
    _writeLastSessionPointer: writeLastSessionPointer,
    _getPinned: getPinned,
    _getConfiguredProviderIds: getConfiguredProviderIds,
    systemMessageRouter,
  } = ctx;
  // ── HITL UX mode — read from config and apply at startup ─────────────────
  {
    const hitlMode = configManager.get('behavior.hitlMode') as HITLMode | undefined;
    if (hitlMode && (hitlMode === 'quiet' || hitlMode === 'balanced' || hitlMode === 'operator')) {
      ModeManager.getInstance().setHITLMode(hitlMode);
    }
  }

  // Use the singleton panel manager (already initialized in bootstrap)
  const panelManager = getPanelManager();

  // Permission state — set while a permission prompt is blocking the orchestrator
  let pendingPermission: PermissionRequest | null = null;

  // --- Streaming speed tracking (B2) ---
  let streamStartTime = 0;
  let streamDeltaCount = 0;
  let streamTokenSpeed = 0;

  // --- Partial tool call preview tracking (B3) ---
  let partialToolPreview: string | undefined = undefined;

  let scrollTop = 0;
  /** When true, view auto-scrolls to bottom on every render.
   *  False when user manually scrolls up. Reset on user input. */
  let scrollLocked = true;

  // lastGitInfo is a mutable ref provided by bootstrap (updated asynchronously)
  // Use lastGitInfoRef.value inside render to get the current value.

  /** Content width inside the prompt box (box width minus padding). */
  const getPromptContentWidth = () => {
    const w = stdout.columns || 80;
    const boxMargin = 2;
    const boxWidth = w - (boxMargin * 2);
    return boxWidth - 4 - 3; // minus padding (4) minus prefix width (3: ' > ')
  };

  /** Base footer row count: separator + prompt box (top+content+bottom) + blank +
   *  token line + ctx bar + compact bar + context line (blank+info+blank) + help/exit line + trailing blank.
   *  Process indicator (1 row, always shown) is accounted for separately in getViewportHeight.
   */
  const FOOTER_BASE_ROWS = 9;

  const getViewportHeight = () => {
    const promptLines = input.getVisiblePromptLineCount(getPromptContentWidth());
    // FOOTER_BASE_ROWS base footer rows + 2 progress bars (always shown when model has contextWindow) + prompt lines
    // + 1 process indicator row (always shown: idle, focused, or active states)
    const currentModel = providerRegistry.getCurrentModel();
    const hasProgressBars = currentModel.contextWindow > 0 ? 2 : 0;
    const processIndicatorRows = 1; // always shown (idle, focused, or active)
    return (stdout.rows || 24) - 2 - (FOOTER_BASE_ROWS + promptLines + hasProgressBars + processIndicatorRows);
  };

  const scroll = (delta: number) => {
    const vHeight = getViewportHeight();
    const maxScroll = Math.max(0, conversation.history.getLineCount() - vHeight);
    scrollTop = Math.max(0, Math.min(scrollTop + delta, maxScroll));
    // Re-lock if user scrolled to bottom, otherwise unlock
    scrollLocked = scrollTop >= maxScroll;
  };

  const scrollToEnd = (vHeight: number) => {
    scrollTop = Math.max(0, conversation.history.getLineCount() - vHeight);
  };

  // main.ts-owned unsub functions (render:request, input:submit, cancel:generation, etc.)
  // Bootstrap-owned unsubs are in ctx.bootstrapUnsubs and cleared by ctx.shutdown().
  const unsubs: Array<() => void> = [];

  // Crash recovery interval handle — cleared on exit
  let recoveryInterval: ReturnType<typeof setInterval> | null = null;

  // Recovery flow state
  let recoveryPending = false;

  /**
   * Full application teardown.
   * Clears main.ts-owned listeners, calls ctx.shutdown() for logical teardown,
   * then tears down the terminal and exits the process.
   */
  const exitApp = (): void => {
    // Clear main.ts-owned event subscriptions
    unsubs.forEach(fn => fn());
    // Clear bootstrap-owned unsubs + interval via ctx.shutdown()
    ctx.shutdown(conversation.toJSON() as { messages: object[]; timestamp?: number }).catch((err) => {
      logger.debug('ctx.shutdown error during exitApp (non-fatal)', { error: String(err) });
    });
    // Clear recovery interval
    if (recoveryInterval !== null) { clearInterval(recoveryInterval); recoveryInterval = null; }
    deleteRecoveryFile();
    // Terminal teardown — main.ts exclusively owns these
    stdin.removeAllListeners('data');
    stdout.removeAllListeners('resize');
    stdout.write(PASTE_DISABLE + KEYBOARD_EXT_DISABLE + MOUSE_DISABLE + CURSOR_SHOW + ALT_SCREEN_EXIT);
    stdin.setRawMode(false);
    process.exit(0);
  };

  // Patch the placeholder exit in commandContext with the real exitApp
  commandContext.exit = exitApp;

  // ── InputHandler — created here so getViewportHeight can reference it ──────
  // orchestratorRefs.getViewportHeight and .scrollToEnd are patched immediately after.

  // ── InputHandler ────────────────────────────────────────────────────────
  const input = new InputHandler(
    bus,
    selection,
    () => scrollTop,
    getViewportHeight,
    () => conversation.history,
    scroll,
    exitApp,
  );

  // Wire orchestratorRefs now that InputHandler is created
  orchestratorRefs.getViewportHeight = getViewportHeight;
  orchestratorRefs.scrollToEnd = scrollToEnd;

  input.setCommandRegistry(commandRegistry, commandContext);
  input.setConversationManager(conversation);
  input.setContentWidth(getPromptContentWidth());
  input.filePicker.setOnUpdate(() => bus.emit('render:request'));
  input.agentDetailModal.setOnRefresh(() => bus.emit('render:request'));
  input.processModal.setOnRefresh(() => bus.emit('render:request'));

  // --- Model picker wiring ---
  commandContext.openModelPicker = () => {
    const models = providerRegistry.getSelectableModels();
    input.modelPicker.configuredProviders = new Set(getConfiguredProviderIds());
    void getPinned().then((pinned) => {
      input.modelPicker.pinnedIds = new Set(pinned);
    });
    void input.modelPicker.loadRecentModels().catch(() => {}); // non-blocking, fire-and-forget
    input.modalOpened('modelPicker');
    input.modelPicker.open(models, runtime.model);
    bus.emit('render:request');
  };

  commandContext.openProviderPicker = () => {
    const providers = [...new Set(providerRegistry.listModels().map(m => m.provider))];
    input.modelPicker.configuredProviders = new Set(getConfiguredProviderIds());
    input.modalOpened('modelPicker');
    input.modelPicker.openProviders(providers, runtime.provider);
    bus.emit('render:request');
  };

  commandContext.openSelection = (title, items, opts, callback) => {
    input.openSelection(title, items, opts, callback);
  };

  commandContext.openContextInspector = () => {
    input.modalOpened('contextInspector');
    input.contextInspectorModal.open();
    bus.emit('render:request');
  };

  commandContext.openBookmarkModal = () => {
    input.modalOpened('bookmark');
    input.bookmarkModal.open();
    bus.emit('render:request');
  };

  commandContext.openHelpOverlay = () => {
    if (!input.helpOverlayActive) input.modalOpened('help');
    input.helpOverlayActive = !input.helpOverlayActive;
    input.helpScrollOffset = 0;
  };
  commandContext.openShortcutsOverlay = () => {
    if (!input.shortcutsOverlayActive) input.modalOpened('shortcuts');
    input.shortcutsOverlayActive = !input.shortcutsOverlayActive;
    input.shortcutsScrollOffset = 0;
    bus.emit('render:request');
  };

  commandContext.openProfilePicker = () => {
    input.modalOpened('profilePicker');
    input.profilePickerModal.open();
    bus.emit('render:request');
  };

  commandContext.openSettingsModal = () => {
    input.modalOpened('settings');
    input.settingsModal.open(configManager, ctx.featureFlags);
    bus.emit('render:request');
  };

  commandContext.openSessionPicker = () => {
    input.modalOpened('sessionPicker');
    input.sessionPickerModal.open();
    bus.emit('render:request');
  };

  commandContext.openPanelPicker = () => {
    if (!panelManager.isVisible()) {
      // Show panels — open docs if nothing is open yet
      if (panelManager.getAllOpen().length === 0) {
        try { panelManager.open('docs'); } catch { /* non-fatal */ }
      }
      panelManager.show();
      conversation.suppressSplash = true;
      conversation.rebuildHistory();
    } else {
      panelManager.hide();
      conversation.suppressSplash = false;
      conversation.rebuildHistory();
    }
    bus.emit('render:request');
  };

  // Model picker callback is handled in bootstrap.ts — do not duplicate here

  // inputHistory comes from bootstrap, already set up — wire it to the input handler
  input.setHistory(inputHistory);

  // --- Splash options ---
  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir: config.workingDir,
    model: runtime.model,
    provider: runtime.provider,
    toolCount,
  };

  // Sessions start fresh — use /session resume to load a previous session

  // --- Render function ---
  const render = () => {
    const width = stdout.columns || 80;
    const height = stdout.rows || 24;
    // Flush any pending message renders before taking snapshot
    conversation.getDisplayBlocks();

    // Cache the current model for consistent values across the entire render frame
    const currentModel = providerRegistry.getCurrentModel();


    // Build header and footer FIRST so we know the exact viewport height
    const headerLines = UIFactory.createHeader(width, currentModel.id, currentModel.provider, conversation.title || undefined, lastGitInfoRef.value);
    const runningAgents = AgentManager.getInstance().list().filter((a) => a.status === 'running' || a.status === 'pending');
    const runningAgentCount = runningAgents.length;
    // Show first running agent's progress (detail modal shows all)
    const runningAgentProgress = runningAgents[0]?.progress;
    const runningProcessCount = ProcessManager.getInstance().list().filter((p) => !p.status.startsWith('done')).length;
    const processIndicatorLines = renderProcessIndicator(width, runningAgentCount, runningProcessCount, input.indicatorFocused, runningAgentProgress);
    const cw = getPromptContentWidth();
    const promptInfo = input.getWrappedPromptInfo(cw);
    // Compute args hint for slash commands — shown in dim grey after cursor
    const commandArgsHint = (() => {
      const p = input.prompt;
      if (!p.startsWith('/')) return undefined;
      // Extract the command name (everything up to first space)
      const spaceIdx = p.indexOf(' ');
      if (spaceIdx !== -1) {
        // User has already typed args — check for subcommand hints
        const cmdName = p.slice(1, spaceIdx);
        const cmd = commandRegistry.get(cmdName);
        if (!cmd) return undefined;
        // Sub-command awareness: check if there's a matching sub-hint pattern
        const afterCmd = p.slice(spaceIdx + 1);
        const subSpaceIdx = afterCmd.indexOf(' ');
        if (subSpaceIdx !== -1) return undefined; // deeper args, no hint
        // User typed one subcommand word, check for known subcommand hints
        const subHints: Record<string, Record<string, string>> = {
          session: { rename: '<name>', resume: '<id|name>', info: '<id>', export: '<id> [format]', search: '<query>', delete: '<id>' },
          template: { save: '<name>', use: '<name> [args]', edit: '<name>', delete: '<name>' },
          secrets: { set: '<KEY> <value>', get: '<KEY>', delete: '<KEY>' },
          permissions: { tool: '<name> allow|prompt|deny' },
          config: { reset: '<key>' },
          danger: {},
          plugin: { enable: '<name>', disable: '<name>', reload: '' },
        };
        const subMap = subHints[cmdName];
        if (subMap && afterCmd in subMap) return subMap[afterCmd];
        return undefined;
      }
      // No space yet — user is still typing the command name
      const cmdName = p.slice(1);
      const cmd = commandRegistry.get(cmdName);
      if (!cmd) return undefined;
      return cmd.argsHint ?? cmd.usage;
    })();
    const footerContentLines = UIFactory.createFooter(
      width,
      promptInfo.visibleLines.join('\n'),
      { up: orchestrator.usage.input, down: orchestrator.usage.output },
      input.showExitNotice,
      input.lastCopyTime,
      runtime.model, toolRegistry.list().length,
      promptInfo.visibleCursorLine >= 0
        ? promptInfo.visibleLines.slice(0, promptInfo.visibleCursorLine).reduce((s, l) => s + l.length + 1, 0) + promptInfo.visibleCursorCol
        : undefined,
      config.workingDir,
      runtime.provider,
      currentModel.contextWindow,
      configManager.get('behavior.autoCompactThreshold') as number,
      (() => {
        if (configManager.get('behavior.autoApprove')) return true;
        const permMode = configManager.get('permissions.mode');
        if (permMode === 'allow-all') return true;
        if (permMode === 'custom') {
          const tools = configManager.getCategory('permissions').tools;
          if (Object.values(tools).every(v => v === 'allow')) return true;
        }
        return false;
      })(),
      orchestrator.lastInputTokens,
      commandArgsHint,
      ModeManager.getInstance().getHITLMode(),
    );
    // Insert process indicator directly after the input box (top border + content rows + bottom border)
    const inputBoxRows = promptInfo.visibleLines.length + 2;
    footerContentLines.splice(inputBoxRows, 0, ...processIndicatorLines);
    const footerLines = footerContentLines;

    // Exact viewport height from actual header/footer sizes
    const vHeight = Math.max(0, height - headerLines.length - footerLines.length);

    // Calculate how many rows are consumed by overlays (thinking, permissions, queue, file picker)
    let overlayRows = 0;
    if (orchestrator.isThinking) overlayRows += 2; // spinner + blank
    if (pendingPermission) overlayRows += 8; // permission prompt
    overlayRows += orchestrator.messageQueue.length * 3; // queued messages
    // File picker and model picker overlay rows computed from actual rendered line count below
    // Selection modal overlay rows are computed from actual rendered line count below
    if (input.searchManager.active) {
      overlayRows += 1;
    }

    // Shrink viewport to make room for overlays
    const effectiveVHeight = Math.max(0, vHeight - overlayRows);

    // Auto-scroll to bottom when orchestrator is active or user was near bottom
    const maxScroll = Math.max(0, conversation.history.getLineCount() - effectiveVHeight);
    if (scrollLocked) {
      scrollTop = maxScroll;
    }

    const viewport = conversation.history.getSnapshot(scrollTop, effectiveVHeight, width);

    if (orchestrator.isThinking) {
      const showSpeed = configManager.get('display.showTokenSpeed') as boolean;
      const showPreview = configManager.get('display.showToolPreview') as boolean;
      const thinking = UIFactory.createThinkingFragment(
        width,
        orchestrator.getSpinner(),
        orchestrator.thinkingFrame,
        showSpeed ? streamTokenSpeed : undefined,
        showPreview ? partialToolPreview : undefined,
        orchestrator.streamingInputTokens > 0 ? orchestrator.streamingInputTokens : undefined,
        orchestrator.streamingOutputTokens > 0 ? orchestrator.streamingOutputTokens : undefined,
      );
      viewport.push(...thinking);
    }

    if (pendingPermission) {
      viewport.push(...PermissionPromptUI.createPromptLines(width, pendingPermission));
    }

    orchestrator.messageQueue.forEach(msg => {
      viewport.push(...UIFactory.createQueuedMessageFragment(width, msg.text));
    });

    if (input.filePicker.active) {
      const fpLines = renderFilePickerOverlay(input.filePicker, width);
      const fpStart = Math.max(0, vHeight - fpLines.length);
      viewport.length = Math.min(viewport.length, fpStart);
      while (viewport.length < fpStart) viewport.push(createEmptyLine(width));
      viewport.push(...fpLines);
    }

    if (input.modelPicker.active) {
      // Reserve 4 extra lines for scroll indicators (up to 2) and visible group headers (up to 2).
      // MODEL_PICKER_CHROME_LINES only counts fixed chrome; dynamic rows push total height higher.
      const mpMaxVisible = Math.max(5, vHeight - MODEL_PICKER_CHROME_LINES - 4);
      const mpLines = renderModelPickerOverlay(input.modelPicker, width, mpMaxVisible);
      const mpStart = Math.max(0, vHeight - mpLines.length);
      viewport.length = Math.min(viewport.length, mpStart);
      while (viewport.length < mpStart) viewport.push(createEmptyLine(width));
      viewport.push(...mpLines);
    }

    if (input.selectionModal.active) {
      const selLines = renderSelectionModalOverlay(input.selectionModal, width);
      // Replace the bottom of the viewport with the modal, keeping conversation above
      const targetStart = Math.max(0, vHeight - selLines.length);
      viewport.length = Math.min(viewport.length, targetStart);
      // Pad if viewport is shorter than targetStart
      while (viewport.length < targetStart) viewport.push(createEmptyLine(width));
      viewport.push(...selLines);
    }

    if (input.searchManager.active) {
      viewport.push(...renderSearchOverlay(input.searchManager, width));
    }

    if (input.historySearch.active) {
      viewport.push(...renderHistorySearchOverlay(input.historySearch, width));
    }


    if (input.processModal.active) {
      const pmLines = renderProcessModal(input.processModal, width);
      const pmStart = Math.max(0, vHeight - pmLines.length);
      viewport.length = Math.min(viewport.length, pmStart);
      while (viewport.length < pmStart) viewport.push(createEmptyLine(width));
      viewport.push(...pmLines);
    }

    if (input.agentDetailModal.active) {
      const adLines = renderAgentDetailModal(input.agentDetailModal, width);
      const adStart = Math.max(0, vHeight - adLines.length);
      viewport.length = Math.min(viewport.length, adStart);
      while (viewport.length < adStart) viewport.push(createEmptyLine(width));
      viewport.push(...adLines);
    }

    if (input.liveTailModal.active) {
      const ltLines = renderLiveTailModal(input.liveTailModal, width);
      const ltStart = Math.max(0, vHeight - ltLines.length);
      viewport.length = Math.min(viewport.length, ltStart);
      while (viewport.length < ltStart) viewport.push(createEmptyLine(width));
      viewport.push(...ltLines);
    }

    if (input.contextInspectorModal.active) {
      const ciLines = renderContextInspector(conversation, width, undefined, currentModel.contextWindow);
      const ciStart = Math.max(0, vHeight - ciLines.length);
      viewport.length = Math.min(viewport.length, ciStart);
      while (viewport.length < ciStart) viewport.push(createEmptyLine(width));
      viewport.push(...ciLines);
    }
    if (input.settingsModal.active) {
      const smLines = renderSettingsModal(input.settingsModal, width);
      const smStart = Math.max(0, vHeight - smLines.length);
      viewport.length = Math.min(viewport.length, smStart);
      while (viewport.length < smStart) viewport.push(createEmptyLine(width));
      viewport.push(...smLines);
    }

    if (input.sessionPickerModal.active) {
      viewport.push(...renderSessionPickerModal(input.sessionPickerModal, width));
    }

    if (input.profilePickerModal.active) {
      viewport.push(...renderProfilePickerModal(input.profilePickerModal, width));
    }

    if (input.bookmarkModal.active) {
      const bmLines = renderBookmarkModal(input.bookmarkModal, width);
      const bmStart = Math.max(0, vHeight - bmLines.length);
      viewport.length = Math.min(viewport.length, bmStart);
      while (viewport.length < bmStart) viewport.push(createEmptyLine(width));
      viewport.push(...bmLines);
    }

    if (input.helpOverlayActive) {
      viewport.length = 0;
      const helpLines = renderHelpOverlay(width, commandRegistry.getAll(), input.helpScrollOffset);
      const helpPad = Math.max(0, vHeight - helpLines.length);

      for (let i = 0; i < helpPad; i++) viewport.push(createEmptyLine(width));
      viewport.push(...helpLines);
    }

    if (input.shortcutsOverlayActive) {
      viewport.length = 0;
      const shortcutLines = renderShortcutsOverlay(width, input.shortcutsScrollOffset);
      const scPad = Math.max(0, vHeight - shortcutLines.length);
      for (let i = 0; i < scPad; i++) viewport.push(createEmptyLine(width));
      viewport.push(...shortcutLines);
    }

    // Autocomplete dropdown: shown when command mode is active and there are matches
    if (input.commandMode && input.autocomplete?.isActive) {
      const acLines = renderAutocompleteOverlay(input.autocomplete, width);
      if (acLines.length > 0) {
        const acStart = Math.max(0, vHeight - acLines.length);
        viewport.length = Math.min(viewport.length, acStart);
        while (viewport.length < acStart) viewport.push(createEmptyLine(width));
        viewport.push(...acLines);
      }
    }

    // Panel composite data
    let panelData: import('./renderer/compositor.ts').PanelCompositeData | undefined;
    let panelWidth: number | undefined;
    if (panelManager.isVisible() && panelManager.getAllOpen().length > 0) {
      const pWidth = panelManager.getRightWidth(width);
      if (pWidth > 0) {
        const topPane = panelManager.getTopPane();
        const bottomPane = panelManager.getBottomPane();
        const focusedPane = panelManager.getFocusedPane();
        const verticalSplitRatio = panelManager.getVerticalSplitRatio(); // used in panelData below

        // Compute actual pane heights based on whether bottom pane is visible
        const hasBottom = panelManager.isBottomPaneVisible() && bottomPane.panels.length > 0;
        let topContent: Line[];
        let bottomTabBar: Line | undefined;
        let bottomContent: Line[] | undefined;

        // Top pane
        const topActivePanel = topPane.panels[topPane.activeIndex] ?? null;
        const topTabBar = renderPanelTabBar(
          topPane.panels,
          topPane.activeIndex,
          pWidth,
          input.panelFocused && focusedPane === 'top',
        );

        if (hasBottom) {
          const ratio = panelManager.getVerticalSplitRatio();
          const contentRows = Math.max(0, vHeight - 3); // 2 tab bars + 1 separator
          const topH = Math.max(1, Math.floor(contentRows * ratio));
          const bottomH = Math.max(1, contentRows - topH);
          topContent = topActivePanel ? topActivePanel.render(pWidth, topH) : [];

          // Bottom pane
          const bottomActivePanel = bottomPane.panels[bottomPane.activeIndex] ?? null;
          bottomTabBar = renderPanelTabBar(
            bottomPane.panels,
            bottomPane.activeIndex,
            pWidth,
            input.panelFocused && focusedPane === 'bottom',
          );
          bottomContent = bottomActivePanel ? bottomActivePanel.render(pWidth, bottomH) : [];
        } else {
          const topH = Math.max(0, vHeight - 1); // 1 tab bar
          topContent = topActivePanel ? topActivePanel.render(pWidth, topH) : [];
        }

        panelData = {
          topTabBar,
          topContent,
          topFocused: input.panelFocused && focusedPane === 'top',
          bottomTabBar,
          bottomContent,
          bottomFocused: input.panelFocused && focusedPane === 'bottom',
          separator: true,
          verticalSplitRatio,
        };
        panelWidth = pWidth;
      }
    }

    compositor.composite({
      width, height,
      header: headerLines,
      viewport,
      footer: footerLines,
      selection: {
        isCellSelected: (col, row) => selection.isCellSelected(col, row),
        scrollTop,
        lineCount: conversation.history.getLineCount(),
      },
      search: input.searchManager.active ? {
        manager: input.searchManager,
        scrollTop,
        viewportStartY: 2,
      } : undefined,
      panel: panelData,
      panelWidth,
    });
  };

  // --- Streaming speed + tool preview wiring ---
  // Refresh git status after each turn completes or after tool results arrive
  unsubs.push(bus.on('turn:complete', () => {
    // Auto-save after every LLM turn so kills don't lose the session
    try { saveConversation(conversation.toJSON() as { messages: object[]; timestamp?: number }, runtime.sessionId, runtime.model, runtime.provider, conversation.title || ''); hookDispatcher.fire({ path: 'Lifecycle:session:save' as HookEventPath, phase: 'Lifecycle' as HookPhase, category: 'session' as HookCategory, specific: 'save', sessionId: runtime.sessionId, timestamp: Date.now(), payload: { sessionId: runtime.sessionId } }).catch((err: unknown) => logger.debug('hook fire error', { error: String(err) })); } catch (e) { logger.debug('auto-save on turn:complete failed', { error: String(e) }); }
    gitStatusProvider.refresh().then((info) => {
      lastGitInfoRef.value = info;
      bus.emit('render:request');
    }).catch(() => { /* non-fatal */ });
  }));
  unsubs.push(bus.on('turn:tool-result', () => {
    gitStatusProvider.refresh().then((info) => {
      lastGitInfoRef.value = info;
      bus.emit('render:request');
    }).catch(() => { /* non-fatal */ });
  }));

  unsubs.push(bus.on('turn:stream-start', () => {
    streamStartTime = Date.now();
    streamDeltaCount = 0;
    streamTokenSpeed = 0;
    partialToolPreview = undefined;
  }));
  unsubs.push(bus.on('turn:stream-delta', (data) => {
    streamDeltaCount++;
    const elapsed = (Date.now() - streamStartTime) / 1000;
    // Note: counts stream deltas, not actual tokens. ~1 delta per token for most providers.
    streamTokenSpeed = elapsed > 0 ? streamDeltaCount / elapsed : 0;
    // Extract most recent partial tool call for preview
    if (data.toolCalls && data.toolCalls.length > 0) {
      const last = data.toolCalls[data.toolCalls.length - 1];
      const name = last.name ?? '';
      const args = last.arguments ?? '';
      // Show first 60 chars of args to keep preview compact
      const preview = args.length > 60 ? args.slice(0, 57) + '...' : args;
      partialToolPreview = name ? `${name}(${preview})` : undefined;
    }
  }));
  unsubs.push(bus.on('turn:stream-end', () => {
    partialToolPreview = undefined;
  }));

  // --- Event wiring ---
  unsubs.push(bus.on('render:request', render));
  unsubs.push(bus.on('clear:screen', () => {
    compositor.resetDiff();
    stdout.write(CLEAR_SCREEN);
    render();
  }));
  unsubs.push(bus.on('input:submit', ({ text, content }) => {
    input.clearModalStack();
    scrollLocked = true; // Re-lock on any user input
    // Inline model switching: @model:<model-id> anywhere in input
    // Strips the @model: token and switches the active model before submitting.
    const AT_MODEL_RE = /@model:([^\s]+)/g;
    let processedText = text;
    let atModelMatch: RegExpExecArray | null;
    while ((atModelMatch = AT_MODEL_RE.exec(text)) !== null) {
      const modelId = atModelMatch[1];
      try {
        providerRegistry.setCurrentModel(modelId);
        const def = providerRegistry.getCurrentModel();
        runtime.model = def.id;
        runtime.provider = def.provider;
        configManager.set('provider.model', def.id);
        configManager.set('provider.provider', def.provider);
        systemMessageRouter.high(`[Model] Switched to ${def.displayName} (${def.provider}) via @model:`);
        bus.emit('command:model-changed', { provider: def.provider, model: def.id });
      } catch {
        systemMessageRouter.high(`[Model] Unknown model: ${modelId}`);
      }
      processedText = processedText.replace(atModelMatch[0], '').trim();
    }
    // !# prefix: pin text as a session memory, then send stripped text to orchestrator
    if (processedText.startsWith('!#')) {
      const memoryText = processedText.slice(2).trim();
      if (!memoryText) {
        systemMessageRouter.high('[Memory] Usage: !# <text to pin as session memory>');
        bus.emit('render:request');
        processedText = '';
      } else {
        const memId = sessionMemoryStore.add(memoryText);
        systemMessageRouter.high(`[Memory] Pinned: "${memoryText}" (${memId})`);
        processedText = memoryText;
      }
    }
    if (processedText || content) {
      orchestrator.handleUserInput(processedText, content).catch((err: unknown) => {
        // Safety net only — runTurn's catch already handles display.
        // Only log at debug level to avoid double error display.
        logger.debug('handleUserInput safety catch (already handled by runTurn)', { error: String(err) });
      });
    } else {
      bus.emit('render:request');
    }
  }));

  // Cancel generation when requested by input handler
  unsubs.push(bus.on('cancel:generation', () => {
    if (orchestrator.isThinking) {
      orchestrator.abort();
    }
  }));

  // Permission prompt wiring — store the pending request and trigger a render.
  // The orchestrator's Promise is blocked until resolve() is called.
  unsubs.push(bus.on('permission:request', (req) => {
    pendingPermission = req;
    bus.emit('render:request');
  }));

  // --- Terminal setup ---
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdout.write(ALT_SCREEN_ENTER + CLEAR_SCREEN + CURSOR_HIDE + MOUSE_ENABLE + KEYBOARD_EXT_ENABLE + PASTE_ENABLE);

  stdin.on('data', (data: string) => {
    // When a permission prompt is active, intercept all input and handle Y/A/N/Escape.
    // Normal input handling is fully paused during this state.
    if (pendingPermission) {
      const req = pendingPermission;
      const key = data.toLowerCase().trim();

      if (key === 'y') {
        pendingPermission = null;
        req.resolve(true, false);
      } else if (key === 'a') {
        pendingPermission = null;
        req.resolve(true, true);
      } else if (key === 'n' || data === '\x1b' || data === '\x03') {
        // n, Escape, or Ctrl+C all deny and abort the current turn
        pendingPermission = null;
        req.resolve(false, false);
        orchestrator.abort();
      }
      // Any other key: ignore, keep showing the prompt
      bus.emit('render:request');
      return;
    }

    if (recoveryPending) {
      recoveryPending = false;
      const key = data.toString();
      if (key.toLowerCase() === 'r') {
        try {
          const raw = readFileSync(RECOVERY_FILE, 'utf-8');
          const lines = raw.split('\n').filter(Boolean);
          const messages = lines.slice(1).map(l => { const { type: _, ...rest } = JSON.parse(l) as { type: string } & Record<string, unknown>; return rest; });
          conversation.fromJSON({ messages: messages as Parameters<typeof conversation.fromJSON>[0]['messages'] });
          systemMessageRouter.high('[Recovery] Session restored.');
        } catch (err) {
          systemMessageRouter.high(`[Recovery] Failed to restore: ${(err as Error).message}`);
        }
      } else {
        systemMessageRouter.high('[Recovery] Discarded recovery data.');
      }
      deleteRecoveryFile();
      bus.emit('render:request');
      return;
    }

    input.feed(data);
  });
  process.on('SIGINT', () => input.feed('\x03'));
  // Track unhandled rejections to detect cascading failures
  let _unhandledRejectionCount = 0;
  let _unhandledRejectionWindowStart = Date.now();
  process.on('unhandledRejection', (reason: unknown) => {
    const now = Date.now();
    if (now - _unhandledRejectionWindowStart > 10000) {
      _unhandledRejectionCount = 0;
      _unhandledRejectionWindowStart = now;
    }
    _unhandledRejectionCount++;
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (_unhandledRejectionCount > 3) {
      logger.error('CRITICAL: cascading unhandled rejections — consider restarting', {
        count: _unhandledRejectionCount,
        windowMs: now - _unhandledRejectionWindowStart,
        error: String(reason),
      });
      systemMessageRouter.high(
        `[Critical] Multiple errors detected (${_unhandledRejectionCount} in 10s). If the issue persists, please restart. Latest: ${msg}`
      );
    } else {
      systemMessageRouter.high(`[Error] ${msg}`);
      logger.error('unhandledRejection', { error: String(reason) });
    }
    bus.emit('render:request');
  });
  stdout.on('resize', () => {
    input.setContentWidth(getPromptContentWidth());
    compositor.resetDiff();
    render();
  });

  // Initial render
  conversation.rebuildHistory();
  render();

  // --- Crash recovery check ---
  const recoveryInfo = checkRecoveryFile();
  if (recoveryInfo) {
    systemMessageRouter.high(`[Recovery] Found unsaved session from ${new Date(recoveryInfo.timestamp).toLocaleString()}. Title: "${recoveryInfo.title}". Press R to restore, any other key to discard.`);
    bus.emit('render:request');
    recoveryPending = true;
  }

  // --- Auto-save to recovery file every 60s ---
  recoveryInterval = setInterval(() => {
    writeRecoveryFile(conversation, runtime.sessionId);
  }, 60_000);

}

main().catch(err => logger.error('Fatal error', { error: err }));
