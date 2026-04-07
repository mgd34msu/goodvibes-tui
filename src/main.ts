#!/usr/bin/env bun
// Main shell entrypoint. Composition-heavy startup remains here, with
// lower-level session/bootstrap/input helpers extracted into focused modules.
import { Compositor } from './renderer/compositor.ts';
import { type Line } from './types/grid.ts';
import { UIFactory } from './renderer/ui-factory.ts';
import { Orchestrator } from './core/orchestrator.ts';
import { InputHandler } from './input/handler.ts';
import { SelectionManager } from './input/selection.ts';
import { configManager, getWorkingDirectory } from './config/index.ts';
import { providerRegistry } from './providers/registry.ts';
import type { ContentPart } from './providers/interface.ts';
import { ToolRegistry } from './tools/registry.ts';
import { registerAllTools } from './tools/index.ts';
import { FileUndoManager } from './state/file-undo.ts';
import { agentOrchestrator } from './agents/orchestrator.ts';
import { PermissionManager } from './permissions/manager.ts';
import { AcpManager } from './acp/manager.ts';
import { getHookDispatcher } from './hooks/index.ts';
import { PermissionPromptUI } from './permissions/prompt.ts';
import { CommandRegistry } from './input/command-registry.ts';
import type { CommandContext } from './input/command-registry.ts';
import { renderProcessIndicator } from './renderer/process-indicator.ts';
import { AgentManager } from './tools/agent/index.ts';
import { WrfcController } from './agents/wrfc-controller.ts';
import { ProcessManager } from './tools/shared/process-manager.ts';
import { registerBuiltinCommands } from './input/commands.ts';
import { ScheduleManager } from './tools/workflow/index.ts';
import { InputHistory } from './input/input-history.ts';
import { getTierPromptSupplement, getTierForContextWindow } from './providers/tier-prompts.ts';
import { GitStatusProvider } from './renderer/git-status.ts';
import type { GitHeaderInfo } from './renderer/git-status.ts';
import { createShellLayout } from './renderer/layout-engine.ts';
import { buildShellFooter, estimateShellFooterHeight } from './renderer/shell-surface.ts';
import {
  buildConversationViewport,
} from './renderer/conversation-layout.ts';
import { applyConversationOverlays } from './renderer/conversation-overlays.ts';
import { buildPanelCompositeData } from './renderer/panel-composite.ts';
import { logger } from './utils/logger.ts';
import { getPinned } from './providers/favorites.ts';
import { initModelLimits, getContextWindowForModel } from './providers/model-limits.ts';
import { initBenchmarks } from './providers/model-benchmarks.ts';
import { initCatalog, getConfiguredProviderIds } from './providers/model-catalog.ts';
import { getPanelManager } from './panels/panel-manager.ts';
import { registerBuiltinPanels } from './panels/builtin-panels.ts';
import { renderPanelTabBar } from './renderer/panel-tab-bar.ts';
import { mcpRegistry } from './mcp/registry.ts';
import { getKeybindingsManager } from './input/keybindings.ts';
import { sessionMemoryStore } from './core/session-memory.ts';
import { bootstrapRuntime } from './runtime/bootstrap.ts';
import type { BootstrapContext } from './runtime/bootstrap.ts';
import type { ToolEvent, TurnEvent } from './runtime/events/index.ts';
import { selectStreamToolPreview } from './runtime/store/selectors/index.ts';
import { ModeManager } from './state/mode-manager.ts';
import type { HITLMode } from './state/mode-manager.ts';
import type { HookPhase, HookCategory, HookEventPath } from './hooks/types.ts';
import {
  checkRecoveryFile,
  deleteRecoveryFile,
  loadRecoveryConversation,
  persistConversation,
  writeRecoveryFile,
} from './runtime/session-persistence.ts';
import { handleBlockingShellInput, type PendingPermissionState } from './shell/blocking-input.ts';
import { wireShellUiOpeners } from './shell/ui-openers.ts';


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
async function main() {
  const stdout = process.stdout;
  const stdin = process.stdin;

  // ── Bootstrap all runtime subsystems ─────────────────────────────────────
  // bootstrapRuntime initializes all subsystems in dependency order and returns
  // a fully-wired BootstrapContext. main.ts owns terminal setup, the render loop,
  // stdin input, and signal handlers — everything else is in bootstrap.
  const ctx: BootstrapContext = await bootstrapRuntime(stdout);
  const {
    runtimeBus,
    store,
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
    permissionPromptRef,
    loadLastConversation,
    _writeLastSessionPointer: writeLastSessionPointer,
    _getPinned: getPinned,
    _getConfiguredProviderIds: getConfiguredProviderIds,
    systemMessageRouter,
  } = ctx;
  let activeConversationWidth = stdout.columns || 80;
  conversation.setWidthProvider(() => activeConversationWidth);
  if (!runtimeBus) {
    throw new Error('bootstrapRuntime must provide RuntimeEventBus');
  }
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
  let pendingPermission: PendingPermissionState | null = null;

  // --- Streaming speed tracking (B2) ---
  let streamStartTime = 0;
  let streamDeltaCount = 0;
  let streamTokenSpeed = 0;

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

  const getViewportHeight = (): number => {
    const promptLines: number = input.getVisiblePromptLineCount(getPromptContentWidth());
    const currentModel = providerRegistry.getCurrentModel();
    return (stdout.rows || 24) - 2 - estimateShellFooterHeight(promptLines, currentModel.contextWindow);
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

  // main.ts-owned unsub functions for shell-owned typed runtime subscriptions
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

  // main.ts owns terminal teardown, so it binds the shell exit bridge here.
  commandContext.exit = exitApp;

  const submitInput = (text: string, content?: ContentPart[]) => {
    input.clearModalStack();
    scrollLocked = true; // Re-lock on any user input
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
      } catch {
        systemMessageRouter.high(`[Model] Unknown model: ${modelId}`);
      }
      processedText = processedText.replace(atModelMatch[0], '').trim();
    }
    if (processedText.startsWith('!#')) {
      const memoryText = processedText.slice(2).trim();
      if (!memoryText) {
        systemMessageRouter.high('[Memory] Usage: !# <text to pin as session memory>');
        render();
        processedText = '';
      } else {
        const memId = sessionMemoryStore.add(memoryText);
        systemMessageRouter.high(`[Memory] Pinned: "${memoryText}" (${memId})`);
        processedText = memoryText;
      }
    }
    if (processedText || content) {
      orchestrator.handleUserInput(processedText, content).catch((err: unknown) => {
        logger.debug('handleUserInput safety catch (already handled by runTurn)', { error: String(err) });
      });
    } else {
      render();
    }
  };

  const cancelGeneration = () => {
    if (orchestrator.isThinking) {
      orchestrator.abort();
    }
  };

  const jumpToBookmark = (key: string) => {
    conversation.getDisplayBlocks();
    const block = conversation.getBlockRegistry().find((entry) => entry.collapseKey === key);
    if (!block) {
      systemMessageRouter.high(`[Bookmark] Not found: ${key}`);
      render();
      return;
    }
    scrollLocked = false;
    scrollTop = Math.max(0, block.startLine);
    render();
  };

  const scrollToLine = (line: number) => {
    conversation.getDisplayBlocks();
    const maxScroll = Math.max(0, conversation.history.getLineCount() - getViewportHeight());
    scrollLocked = false;
    scrollTop = Math.max(0, Math.min(line, maxScroll));
    render();
  };

  commandContext.submitInput = submitInput;
  commandContext.executeCommand = (name, args) => commandRegistry.execute(name, args, commandContext);
  commandContext.cancelGeneration = cancelGeneration;
  commandContext.jumpToBookmark = jumpToBookmark;
  commandContext.scrollToLine = scrollToLine;
  commandContext.clearScreen = () => {
    compositor.resetDiff();
    stdout.write(CLEAR_SCREEN);
    render();
  };
  permissionPromptRef.requestPermission = (request) =>
    new Promise((resolve) => {
      pendingPermission = {
        ...request,
        resolve: (approved: boolean, remember = false) => resolve({ approved, remember }),
      };
      render();
    });

  // ── InputHandler — created here so getViewportHeight can reference it ──────
  // orchestratorRefs.getViewportHeight and .scrollToEnd are patched immediately after.

  // ── InputHandler ────────────────────────────────────────────────────────
  const input: InputHandler = new InputHandler(
    () => render(),
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
  input.filePicker.setOnUpdate(() => render());
  input.agentDetailModal.setOnRefresh(() => render());
  input.processModal.setOnRefresh(() => render());

  // --- Model picker wiring ---
  // Model picker callback is handled in bootstrap.ts — do not duplicate here

  // inputHistory comes from bootstrap, already set up — wire it to the input handler
  input.setHistory(inputHistory);

  // --- Splash options ---
  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir: getWorkingDirectory(),
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
    const footerLines = buildShellFooter({
      width,
      promptText: promptInfo.visibleLines.join('\n'),
      promptLineCount: promptInfo.visibleLines.length,
      promptCursorPos: promptInfo.visibleCursorLine >= 0
        ? promptInfo.visibleLines
          .slice(0, promptInfo.visibleCursorLine)
          .reduce((sum: number, line: string) => sum + line.length + 1, 0) + promptInfo.visibleCursorCol
        : undefined,
      usage: { up: orchestrator.usage.input, down: orchestrator.usage.output },
      showExitNotice: input.showExitNotice,
      lastCopyTime: input.lastCopyTime,
      model: runtime.model,
      toolCount: toolRegistry.list().length,
      workingDir: getWorkingDirectory(),
      provider: runtime.provider,
      contextWindow: currentModel.contextWindow,
      compactThreshold: configManager.get('behavior.autoCompactThreshold') as number,
      dangerMode: (() => {
        if (configManager.get('behavior.autoApprove')) return true;
        const permMode = configManager.get('permissions.mode');
        if (permMode === 'allow-all') return true;
        if (permMode === 'custom') {
          const tools = configManager.getCategory('permissions').tools;
          if (Object.values(tools).every(v => v === 'allow')) return true;
        }
        return false;
      })(),
      lastInputTokens: orchestrator.lastInputTokens,
      commandArgsHint,
      hitlMode: ModeManager.getInstance().getHITLMode(),
      runningAgentCount,
      runningProcessCount,
      indicatorFocused: input.indicatorFocused,
      runningAgentProgress,
    }).lines;

    const shellLayout = createShellLayout({
      width,
      height,
      headerHeight: headerLines.length,
      footerHeight: footerLines.length,
      panelWidth: panelManager.isVisible() && panelManager.getAllOpen().length > 0
        ? panelManager.getRightWidth(width)
        : 0,
    });
    const vHeight = shellLayout.body.height;
    const conversationWidth = shellLayout.conversation.width;
    activeConversationWidth = conversationWidth;
    const hasPanelWorkspace = panelManager.isVisible() && panelManager.getAllOpen().length > 0;
    conversation.setSplashSuppressed(hasPanelWorkspace);

    // Calculate how many rows are consumed by overlays (thinking, permissions, queue, file picker)
    let overlayRows = 0;
    if (orchestrator.isThinking) overlayRows += 2; // spinner + blank
    if (pendingPermission) overlayRows += PermissionPromptUI.getPromptHeight(pendingPermission);
    overlayRows += orchestrator.messageQueue.length * 3; // queued messages
    // File picker and model picker overlay rows computed from actual rendered line count below
    // Selection modal overlay rows are computed from actual rendered line count below
    if (input.searchManager.active) {
      overlayRows += 1;
    }

    const conversationViewport = buildConversationViewport({
      conversation,
      width: conversationWidth,
      viewportHeight: vHeight,
      scrollTop,
      scrollLocked,
      overlayRows,
    });
    scrollTop = conversationViewport.nextScrollTop;
    let viewport = conversationViewport.viewport;

    if (orchestrator.isThinking) {
      const showSpeed = configManager.get('display.showTokenSpeed') as boolean;
      const showPreview = configManager.get('display.showToolPreview') as boolean;
      const partialToolPreview = showPreview ? selectStreamToolPreview(store.getState()) : undefined;
      const thinking = UIFactory.createThinkingFragment(
        conversationWidth,
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
      viewport.push(...PermissionPromptUI.createPromptLines(conversationWidth, pendingPermission));
    }

    orchestrator.messageQueue.forEach(msg => {
      viewport.push(...UIFactory.createQueuedMessageFragment(conversationWidth, msg.text));
    });

    viewport = applyConversationOverlays(viewport, {
      input,
      conversation,
      commandRegistry,
      conversationWidth,
      viewportHeight: vHeight,
      contextWindow: currentModel.contextWindow,
    });

    // Panel composite data
    const panelComposite = buildPanelCompositeData(
      panelManager,
      input,
      shellLayout.panel?.width ?? 0,
      shellLayout.panel?.height ?? vHeight,
    );

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
      panel: panelComposite.panelData,
      panelWidth: panelComposite.panelWidth,
    });
  };

  orchestratorRefs.requestRender = render;
  commandContext.renderRequest = render;
  wireShellUiOpeners({
    commandContext,
    input,
    panelManager,
    conversation,
    providerRegistry,
    runtime,
    featureFlags: ctx.featureFlags,
    mcpRegistry,
    getConfiguredProviderIds,
    getPinned,
    render,
  });

  // --- Streaming speed + tool preview wiring ---
  // Refresh git status after each turn completes or after tool results arrive
  unsubs.push(runtimeBus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', () => {
    // Auto-save after every LLM turn so kills don't lose the session
    try { persistConversation(runtime.sessionId, conversation.toJSON() as { messages: object[]; timestamp?: number }, runtime.model, runtime.provider, conversation.title || ''); hookDispatcher.fire({ path: 'Lifecycle:session:save' as HookEventPath, phase: 'Lifecycle' as HookPhase, category: 'session' as HookCategory, specific: 'save', sessionId: runtime.sessionId, timestamp: Date.now(), payload: { sessionId: runtime.sessionId } }).catch((err: unknown) => logger.debug('hook fire error', { error: String(err) })); } catch (e) { logger.debug('auto-save on turn:complete failed', { error: String(e) }); }
    gitStatusProvider.refresh().then((info) => {
      lastGitInfoRef.value = info;
      render();
    }).catch(() => { /* non-fatal */ });
  }));
  unsubs.push(runtimeBus.on<Extract<ToolEvent, { type: 'TOOL_SUCCEEDED' }>>('TOOL_SUCCEEDED', () => {
    gitStatusProvider.refresh().then((info) => {
      lastGitInfoRef.value = info;
      render();
    }).catch(() => { /* non-fatal */ });
  }));
  unsubs.push(runtimeBus.on<Extract<ToolEvent, { type: 'TOOL_FAILED' }>>('TOOL_FAILED', () => {
    gitStatusProvider.refresh().then((info) => {
      lastGitInfoRef.value = info;
      render();
    }).catch(() => { /* non-fatal */ });
  }));

  unsubs.push(runtimeBus.on<Extract<TurnEvent, { type: 'STREAM_START' }>>('STREAM_START', () => {
    streamStartTime = Date.now();
    streamDeltaCount = 0;
    streamTokenSpeed = 0;
  }));
  unsubs.push(runtimeBus.on<Extract<TurnEvent, { type: 'STREAM_DELTA' }>>('STREAM_DELTA', ({ payload: data }) => {
    streamDeltaCount++;
    const elapsed = (Date.now() - streamStartTime) / 1000;
    // Note: counts stream deltas, not actual tokens. ~1 delta per token for most providers.
    streamTokenSpeed = elapsed > 0 ? streamDeltaCount / elapsed : 0;
  }));

  // --- Terminal setup ---
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdout.write(ALT_SCREEN_ENTER + CLEAR_SCREEN + CURSOR_HIDE + MOUSE_ENABLE + KEYBOARD_EXT_ENABLE + PASTE_ENABLE);

  stdin.on('data', (data: string) => {
    const blocking = handleBlockingShellInput({
      data,
      pendingPermission,
      recoveryPending,
      abortTurn: () => orchestrator.abort(),
      conversation,
      systemMessageRouter,
      render,
      loadRecoveryConversation,
      deleteRecoveryFile,
    });
    pendingPermission = blocking.pendingPermission;
    recoveryPending = blocking.recoveryPending;
    if (blocking.handled) {
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
    render();
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
    render();
    recoveryPending = true;
  }

  // --- Auto-save to recovery file every 60s ---
  recoveryInterval = setInterval(() => {
    writeRecoveryFile(
      conversation.toJSON() as { messages: Array<Record<string, unknown>> },
      runtime.sessionId,
      conversation.title ?? '',
    );
  }, 60_000);

}

main().catch(err => logger.error('Fatal error', { error: err }));
