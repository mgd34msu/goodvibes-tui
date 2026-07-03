#!/usr/bin/env bun
import { homedir } from 'node:os';
import { Compositor } from './renderer/compositor.ts';
import { type Line } from './types/grid.ts';
import { UIFactory } from './renderer/ui-factory.ts';
import { Orchestrator } from './core/orchestrator';
import { InputHandler } from './input/handler.ts';
import { SelectionManager } from './input/selection.ts';
import type { ContentPart } from '@pellux/goodvibes-sdk/platform/providers';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import { registerAllTools } from '@pellux/goodvibes-sdk/platform/tools';
import { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state';
import { PermissionManager } from '@pellux/goodvibes-sdk/platform/permissions';
import { AcpManager } from '@pellux/goodvibes-sdk/platform/acp';
import { PermissionPromptUI } from './permissions/prompt.ts';
import { CommandRegistry } from './input/command-registry.ts';
import type { CommandContext } from './input/command-registry.ts';
import { renderProcessIndicator } from './renderer/process-indicator.ts';
import { registerBuiltinCommands } from './input/commands.ts';
import { ScheduleManager } from '@pellux/goodvibes-sdk/platform/tools';
import { InputHistory } from './input/input-history.ts';
import { getTierPromptSupplement, getTierForContextWindow } from '@pellux/goodvibes-sdk/platform/providers';
import { GitStatusProvider } from './renderer/git-status.ts';
import type { GitHeaderInfo } from './renderer/git-status.ts';
import { createShellLayout } from './renderer/layout-engine.ts';
import { buildShellFooter, estimateShellFooterHeight } from './renderer/shell-surface.ts';
import { computePromptContentWidth } from './renderer/prompt-content-width.ts';
import { buildConversationViewport } from './renderer/conversation-layout.ts';
import { applyConversationOverlays } from './renderer/conversation-overlays.ts';
import { buildPanelCompositeData } from './renderer/panel-composite.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { registerBuiltinPanels } from './panels/builtin-panels.ts';
import { bootstrapRuntime } from './runtime/bootstrap.ts';
import type { BootstrapContext } from './runtime/bootstrap.ts';
import type { HITLMode } from '@pellux/goodvibes-sdk/platform/state';
import {
  checkRecoveryFile,
  deleteRecoveryFile,
  loadRecoveryConversation,
  readLastSessionPointer,
  writeRecoveryFile,
} from '@/runtime/index.ts';
import { handleBlockingShellInput, type PendingPermissionState } from './shell/blocking-input.ts';
import { createPersistRecoverySnapshot, createReopenRecoveryPanels, handleErrorAffordanceKey } from './shell/recovery-input-helpers.ts';
import { wireShellUiOpeners } from './shell/ui-openers.ts';
import { deriveComposerState } from './core/composer-state.ts';
import { buildPersistedSessionContext, formatReturnContextForDisplay, getReturnContextMode, maybeAssistReturnContextSummary } from '@/runtime/index.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { prepareShellCliRuntime } from './cli/entrypoint.ts';
import { applyInitialTuiCliState } from './cli/tui-startup.ts';
import { applyRuntimeConfigDefault, applyRuntimeConfigValue } from './cli/config-overrides.ts';
import { renderToolCallBlock } from './renderer/tool-call.ts';
import { wireSpokenTurnRuntime } from './audio/spoken-turn-wiring.ts';
import { attachSpokenTurnModelRouting, createSpokenTurnInputOptions } from './audio/spoken-turn-model-routing.ts';
import { allowTerminalWrite, installTuiTerminalOutputGuard } from './runtime/terminal-output-guard.ts';
import { installProcessLifecycle } from './runtime/process-lifecycle.ts';
import { buildCommandArgsHint } from './input/command-args-hint.ts';
import { summarizeRunningAgents } from './renderer/process-summary.ts';
import { formatUserFacingErrorLine } from './core/format-user-error.ts';
import { wireStreamEventMetrics, type StreamMetrics, type WireStreamEventMetricsResult } from './core/stream-event-wiring.ts';
import { wireTurnEventHandlers } from './core/turn-event-wiring.ts';
import { buildContextStatusHint } from './renderer/context-status-hint.ts';
import { evaluateSessionMaintenance } from '@/runtime/index.ts';

const ALT_SCREEN_ENTER = '\x1b[?1049h'; const ALT_SCREEN_EXIT  = '\x1b[?1049l';
const MOUSE_ENABLE     = '\x1b[?1000h\x1b[?1002h\x1b[?1006h'; const MOUSE_DISABLE    = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';
const CURSOR_HIDE      = '\x1b[?25l'; const CURSOR_SHOW = '\x1b[?25h'; const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';
const KEYBOARD_EXT_ENABLE  = '\x1b[>4;2m' + '\x1b[?1u'; const KEYBOARD_EXT_DISABLE = '\x1b[>4;0m' + '\x1b[?1l';
const PASTE_ENABLE = '\x1b[?2004h'; const PASTE_DISABLE = '\x1b[?2004l';

async function main() {
  const stdout = process.stdout;
  const stdin = process.stdin;
  const { cli, configManager, bootstrapWorkingDir, bootstrapHomeDirectory } = await prepareShellCliRuntime(process.argv.slice(2), {
    defaultWorkingDirectory: process.env['GOODVIBES_WORKING_DIR'] ?? process.cwd(),
    homeDirectory: homedir(),
  }, 'goodvibes');

  const ctx: BootstrapContext = await bootstrapRuntime(stdout, {
    configManager,
    workingDir: bootstrapWorkingDir,
    homeDirectory: bootstrapHomeDirectory,
  });
  const {
    conversation,
    orchestrator,
    runtime,
    toolRegistry,
    compositor,
    selection,
    commandContext,
    uiServices,
    commandRegistry,
    inputHistory,
    hookDispatcher,
    gitStatusProvider,
    lastGitInfoRef,
    bootstrapUnsubs,
    agentStatusIntervalRef,
    orchestratorRefs,
    setRenderRequest,
    permissionPromptRef,
    _writeLastSessionPointer: writeLastSessionPointer,
    systemMessageRouter,
    setOpenAgentDetail,
  } = ctx;
  const workingDir = ctx.services.workingDirectory;
  const homeDirectory = ctx.services.homeDirectory;
  const { approvalBroker, agentManager, modeManager, processManager, providerRegistry, secretsManager, subscriptionManager } = ctx.services;
  conversation.setSessionMemoryStore(ctx.services.sessionMemoryStore);
  conversation.setSessionLineageTracker(ctx.services.sessionLineageTracker);
  orchestrator.setCoreServices({
    configManager,
    providerRegistry,
    favoritesStore: ctx.services.favoritesStore,
    planManager: ctx.services.planManager,
    adaptivePlanner: ctx.services.adaptivePlanner,
    sessionMemoryStore: ctx.services.sessionMemoryStore,
    sessionLineageTracker: ctx.services.sessionLineageTracker,
    idempotencyStore: ctx.services.idempotencyStore,
  });
  ctx.services.wrfcController.setPlanManager(ctx.services.planManager);
  let activeConversationWidth = stdout.columns || 80;
  conversation.setWidthProvider(() => activeConversationWidth);
  {
    const hitlMode = configManager.get('behavior.hitlMode') as HITLMode | undefined;
    if (hitlMode && (hitlMode === 'quiet' || hitlMode === 'balanced' || hitlMode === 'operator')) {
      modeManager.setHITLMode(hitlMode);
    }
  }

  // TUI default: show token speed ON. The SDK schema default is false;
  // applyRuntimeConfigDefault reads both the global settings file and the project
  // settings file from disk before deciding whether to apply the default. If the
  // user has explicitly set this key to false in EITHER their global or project
  // persisted config, their value is respected and the default is NOT applied.
  // Only when the key is absent from both files (e.g. a new install) does the
  // TUI default of true take effect in-memory — no disk write occurs either way.
  applyRuntimeConfigDefault(configManager, 'display.showTokenSpeed', true);

  const panelManager = ctx.services.panelManager;
  const buildSessionContinuityHints = () => {
    const sessionSnapshot = uiServices.readModels.session.getSnapshot();
    const tasksSnapshot = uiServices.readModels.tasks.getSnapshot();
    const remoteSnapshot = uiServices.readModels.remote.getSnapshot();
    const worktreeSnapshot = uiServices.readModels.worktrees.getSnapshot();
    return {
      pendingApprovals: sessionSnapshot.pendingApproval ? 1 : 0,
      activeTasks: tasksSnapshot.tasks.filter((task) => task.status === 'running' || task.status === 'queued').length,
      blockedTasks: tasksSnapshot.tasks.filter((task) => task.status === 'blocked').length,
      remoteContracts: remoteSnapshot.contracts.length,
      remoteRunners: remoteSnapshot.contracts.slice(0, 4).map((contract) => contract.runnerId),
      worktreeCount: worktreeSnapshot.records.length,
      worktreePaths: worktreeSnapshot.records.slice(0, 3).map((record) => record.path),
      openPanels: panelManager.getAllOpen().map((panel) => panel.id),
    };
  };

  let pendingPermission: PendingPermissionState | null = null;
  approvalBroker.subscribe((approval) => {
    if (!pendingPermission) return;
    if (pendingPermission.callId !== approval.callId) return;
    if (approval.status === 'pending' || approval.status === 'claimed') return;
    pendingPermission = null;
    render();
  });

  let scrollTop = 0;
  let scrollLocked = true;
  // Cached from the overlay-aware clamp the renderer computes (conversation-layout) each
  // frame so scroll() clamps against exactly what is displayed, not a footer estimate.
  let lastMaxScroll: number | null = null;
  // Stream and tool-timer state; mutated by wireStreamEventMetrics handlers, read during render.
  const streamMetrics: StreamMetrics = {
    startTime: 0,
    deltaCount: 0,
    tokenSpeed: 0,
    ttftMs: undefined,
    ttftRecorded: false,
    activeToolStartedAtMs: undefined,
    activeToolName: undefined,
  };

  const getPromptContentWidth = () => computePromptContentWidth(stdout.columns);

  const getViewportHeight = (): number => {
    if (input.onboardingWizard.active) return stdout.rows || 24;
    const promptLines: number = input.getVisiblePromptLineCount(getPromptContentWidth());
    const currentModel = providerRegistry.getCurrentModel();
    const contextWindow = providerRegistry.getContextWindowForModel(currentModel);
    const rows = stdout.rows || 24;
    // Compact threshold must match buildShellFooter's `compact: height < 30`
    // posture below — otherwise the cached-height fast path in
    // estimateShellFooterHeight can answer a compact-vs-non-compact query
    // with the wrong cached mode and throw the viewport math off by several rows.
    return rows - 2 - estimateShellFooterHeight(promptLines, contextWindow, rows < 30);
  };

  const scroll = (delta: number) => {
    // Prefer the last clamp the renderer computed (overlay- and real-footer-aware).
    // The footer estimate is only a fallback for the pre-first-render frame.
    const maxScroll = lastMaxScroll ?? Math.max(0, conversation.history.getLineCount() - getViewportHeight());
    scrollTop = Math.max(0, Math.min(scrollTop + delta, maxScroll));
    // Re-lock if user scrolled to bottom, otherwise unlock
    scrollLocked = scrollTop >= maxScroll;
  };

  const scrollToEnd = (vHeight: number) => {
    // Respect a manual scroll-up by the user: only auto-follow the tail when parked at the
    // bottom (scrollLocked). submitInput re-locks on new input so turns resume following.
    if (!scrollLocked) return;
    scrollTop = Math.max(0, conversation.history.getLineCount() - vHeight);
  };

  const unsubs: Array<() => void> = [];
  let recoveryInterval: ReturnType<typeof setInterval> | null = null;
  let stopSpokenOutputForExit: (() => void) | null = null;
  let recoveryPending = false;

  const lifecycle = installProcessLifecycle({
    stdin,
    stdout,
    ctx,
    noAltScreen: cli.flags.noAltScreen,
    ansi: { CLEAR_SCREEN, ALT_SCREEN_EXIT, PASTE_DISABLE, KEYBOARD_EXT_DISABLE, MOUSE_DISABLE, CURSOR_SHOW },
    getInput: () => input,
    render: () => render(),
    getPromptContentWidth,
    getTerminalOutputGuard: () => terminalOutputGuard,
    buildSessionContinuityHints,
    unsubs,
    getRecoveryInterval: () => recoveryInterval,
    setRecoveryInterval: (value) => { recoveryInterval = value; },
    getStopSpokenOutputForExit: () => stopSpokenOutputForExit,
  });
  const {
    exitApp,
    resizeHandler,
    sigintHandler,
    unhandledRejectionHandler,
    uncaughtExceptionHandler,
    terminationSignalHandler,
    exitListener,
  } = lifecycle;
  commandContext.exit = exitApp;

  const spokenTurns = wireSpokenTurnRuntime({
    voiceService: ctx.services.voiceService,
    configManager,
    events: uiServices.events,
    notify: (message) => { systemMessageRouter.high(message); render(); },
  });
  stopSpokenOutputForExit = () => spokenTurns.stop();
  unsubs.push(...spokenTurns.unsubs);
  unsubs.push(attachSpokenTurnModelRouting({
    orchestrator,
    providerRegistry,
    configManager,
    notify: (message) => { systemMessageRouter.high(message); render(); },
  }));
  const submitInput = (text: string, content?: ContentPart[], options: { readonly spokenOutput?: boolean } = {}) => {
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
        configManager.set('provider.model', def.registryKey);
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
        const memId = ctx.services.sessionMemoryStore.add(memoryText);
        systemMessageRouter.high(`[Memory] Pinned: "${memoryText}" (${memId})`);
        processedText = memoryText;
      }
    }
    if (processedText || content) {
      void (async () => {
        const inputOptions = options.spokenOutput ? createSpokenTurnInputOptions() : undefined;
        if (options.spokenOutput && processedText) { spokenTurns.submitNextTurn(processedText); }
        // Snapshot pre-submission state for failover retryTurn; also clears visited set.
        retryCtx = { count: conversation.getMessageCount(), text: processedText, content, opts: inputOptions };
        streamResult.clearFailoverVisited();
        orchestrator.handleUserInput(processedText, content, inputOptions).catch((err: unknown) => {
          logger.debug('handleUserInput safety catch (already handled by runTurn)', { error: summarizeError(err) });
        });
      })();
    } else {
      render();
    }
  };

  const cancelGeneration = () => {
    spokenTurns.stop('Spoken output stopped.');
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
  commandContext.submitSpokenInput = (text, content) => submitInput(text, content, { spokenOutput: true });
  commandContext.stopSpokenOutput = () => spokenTurns.stop();
  commandContext.pasteFromClipboard = () => input.handlePaste();
  commandContext.executeCommand = (name, args) => commandRegistry.execute(name, args, commandContext);
  commandContext.cancelGeneration = cancelGeneration;
  commandContext.jumpToBookmark = jumpToBookmark;
  commandContext.scrollToLine = scrollToLine;
  commandContext.clearScreen = () => {
    compositor.resetDiff();
    allowTerminalWrite(() => stdout.write(CLEAR_SCREEN));
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

  const input: InputHandler = new InputHandler(
    () => render(),
    selection,
    () => scrollTop,
    getViewportHeight,
    () => conversation.history,
    scroll,
    exitApp,
    {
      agents: {
        agentManager,
        agentMessageBus: ctx.services.agentMessageBus,
        wrfcController: ctx.services.wrfcController,
      },
      providers: {
        benchmarkStore: ctx.services.benchmarkStore,
        favoritesStore: ctx.services.favoritesStore,
        providerRegistry: ctx.services.providerRegistry,
      },
      platform: {
        configManager: ctx.services.configManager,
        localUserAuthManager: ctx.services.localUserAuthManager,
        mcpRegistry: ctx.services.mcpRegistry,
        serviceRegistry: ctx.services.serviceRegistry,
        surfaceRegistry: ctx.services.surfaceRegistry,
        subscriptionManager: ctx.services.subscriptionManager,
        secretsManager: ctx.services.secretsManager,
        tokenAuditor: ctx.services.tokenAuditor,
        replayEngine: ctx.services.replayEngine,
        webhookNotifier: ctx.services.webhookNotifier,
        policyRuntimeState: ctx.services.policyRuntimeState,
        externalServices: uiServices.platform.externalServices,
      },
      shell: {
        bookmarkManager: ctx.services.bookmarkManager,
        keybindingsManager: ctx.services.keybindingsManager,
        panelManager,
        processManager,
        profileManager: ctx.services.profileManager,
      },
      sessions: {
        sessionManager: ctx.services.sessionManager,
        sessionBroker: ctx.services.sessionBroker,
        sessionOrchestration: ctx.services.sessionOrchestration,
        sessionMemoryStore: ctx.services.sessionMemoryStore,
      },
      environment: {
        workingDirectory: ctx.services.workingDirectory,
        homeDirectory: ctx.services.homeDirectory,
        shellPaths: ctx.services.shellPaths,
      },
    },
  );

  orchestratorRefs.getViewportHeight = getViewportHeight;
  orchestratorRefs.scrollToEnd = scrollToEnd;

  input.setCommandRegistry(commandRegistry, commandContext);
  input.setConversationManager(conversation);
  input.setContentWidth(getPromptContentWidth());
  input.filePicker.setOnUpdate(() => render());
  input.agentDetailModal.setOnRefresh(() => render());
  input.processModal.setOnRefresh(() => render());
  setOpenAgentDetail((id) => input.agentDetailModal.open(id));

  // Model picker callback is handled in bootstrap.ts — do not duplicate here.
  input.setHistory(inputHistory);

  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir,
    model: runtime.model,
    provider: runtime.provider,
    toolCount,
    lastSessionId: readLastSessionPointer({ workingDirectory: workingDir, homeDirectory, surfaceRoot: 'tui' }) ?? undefined,
  };

  const render = () => {
    const width = stdout.columns || 80;
    const height = stdout.rows || 24;

    // Cache the current model for consistent values across the entire render frame
    const currentModel = providerRegistry.getCurrentModel();
    // Resolve the effective context window (provider_api / configured_cap overrides) once,
    // so the footer meter, footer-height, and context inspector agree with the Tokens panel.
    const contextWindow = providerRegistry.getContextWindowForModel(currentModel);
    const sessionSnapshot = uiServices.readModels.session.getSnapshot();
    const agentSnapshot = uiServices.readModels.agents.getSnapshot();

    const headerLines = UIFactory.createHeader(width, currentModel.id, currentModel.provider, conversation.title || undefined, lastGitInfoRef.value);
    const managerAgents = agentManager.list().filter(
      (a) => a.status === 'running' || a.status === 'pending',
    );
    const runtimeAgents = agentSnapshot.active;
    const runningAgentSummary = summarizeRunningAgents(managerAgents, runtimeAgents, ctx.services.wrfcController.listChains());
    const runningAgentCount = runningAgentSummary.count;
    const runningProcessCount = processManager.list().filter((p) => !p.status.startsWith('done')).length;
    const cw = getPromptContentWidth();
    const promptInfo = input.getWrappedPromptInfo(cw);
    const commandArgsHint = buildCommandArgsHint(input.prompt, commandRegistry);
    const composerState = deriveComposerState({
      text: input.prompt,
      commandMode: input.commandMode,
      panelFocused: input.panelFocused,
      pendingApproval: pendingPermission !== null,
      hasAttachments: input.getImageAttachments().size > 0,
      turnState: sessionSnapshot.turnState,
    });
    const maintenanceStatus = evaluateSessionMaintenance({
      configManager,
      currentTokens: orchestrator.lastInputTokens,
      contextWindow,
      sessionMemoryCount: ctx.services.sessionMemoryStore.list().length,
    });
    const contextStatusHint = buildContextStatusHint({
      level: maintenanceStatus.level,
      autoCompactEnabled: maintenanceStatus.autoCompactEnabled,
      usagePct: maintenanceStatus.usagePct,
    });
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
      workingDir,
      provider: runtime.provider,
      contextWindow,
      contextStatusHint,
      // Compact footer posture on short terminals so the shell stays usable.
      compact: height < 30,
      // behavior.autoCompactThreshold is stored as a percent integer (e.g. 80);
      // the meter expects a fraction [0..1]. Clamp to [0,1] to guard nonsense values.
      compactThreshold: Math.min(1, Math.max(0, (configManager.get('behavior.autoCompactThreshold') as number) / 100)),
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
      hitlMode: modeManager.getHITLMode(),
      runningAgentCount,
      runningProcessCount,
      indicatorFocused: input.indicatorFocused,
      runningAgentProgress: runningAgentSummary.progress,
      composerMode: composerState.modeLabel,
      composerStatus: composerState.statusLabel,
      composerFlags: composerState.flags,
      composerPendingRisk: composerState.pendingRisk,
    }).lines;

    const onboardingOwnsScreen = input.onboardingWizard.active;
    const shellHeaderLines = onboardingOwnsScreen ? [] : headerLines;
    const shellFooterLines = onboardingOwnsScreen ? [] : footerLines;
    const panelWidth = !onboardingOwnsScreen && panelManager.isVisible() && panelManager.getAllOpen().length > 0
      ? panelManager.getRightWidth(width)
      : 0;
    const shellLayout = createShellLayout({
      width,
      height,
      headerHeight: shellHeaderLines.length,
      footerHeight: shellFooterLines.length,
      panelWidth,
    });
    input.setPanelMouseLayout(shellLayout.panel
      ? {
          x: shellLayout.panel.x,
          y: shellLayout.panel.y,
          width: shellLayout.panel.width,
          height: shellLayout.panel.height,
          hasBottomPane: panelManager.isBottomPaneVisible() && panelManager.getBottomPane().panels.length > 0,
          verticalSplitRatio: panelManager.getVerticalSplitRatio(),
        }
      : null);
    const vHeight = shellLayout.body.height;
    const conversationWidth = shellLayout.conversation.width;
    activeConversationWidth = conversationWidth;
    const hasPanelWorkspace = !onboardingOwnsScreen && panelManager.isVisible() && panelManager.getAllOpen().length > 0;
    conversation.setSplashSuppressed(hasPanelWorkspace);

    // Flush pending renders after updating the width provider and splash posture
    // so the transcript and splash rebuild against the current shell layout.
    conversation.getDisplayBlocks();

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
    lastMaxScroll = conversationViewport.maxScroll;
    let viewport = conversationViewport.viewport;

    if (orchestrator.isThinking) {
      const showSpeed = configManager.get('display.showTokenSpeed') as boolean;
      const showPreview = configManager.get('display.showToolPreview') as boolean;
      const partialToolPreview = showPreview ? sessionSnapshot.streamToolPreview : undefined;
      // Elapsed from turn start (stream or tool execution), used for the thinking indicator timer.
      const turnElapsedMs = streamMetrics.startTime > 0 ? Date.now() - streamMetrics.startTime : undefined;
      const thinking = UIFactory.createThinkingFragment(
        conversationWidth,
        orchestrator.getSpinner(),
        orchestrator.thinkingFrame,
        showSpeed ? streamMetrics.tokenSpeed : undefined,
        showPreview ? partialToolPreview : undefined,
        orchestrator.streamingInputTokens > 0 ? orchestrator.streamingInputTokens : undefined,
        orchestrator.streamingOutputTokens > 0 ? orchestrator.streamingOutputTokens : undefined,
        turnElapsedMs,
        streamMetrics.ttftMs,
      );
      viewport.push(...thinking);
      // Live tool timer: render the currently executing tool row with ticking elapsed.
      if (streamMetrics.activeToolName !== undefined && streamMetrics.activeToolStartedAtMs !== undefined) {
        const liveToolCall = { id: 'live', name: streamMetrics.activeToolName, arguments: {} };
        viewport.push(...renderToolCallBlock(liveToolCall, 'executing', undefined, conversationWidth, undefined, undefined, undefined, streamMetrics.activeToolStartedAtMs));
      }
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
      keybindingsManager: ctx.services.keybindingsManager,
      conversationWidth,
      viewportHeight: vHeight,
      contextWindow,
    });

    // Panel composite data
    const panelComposite = onboardingOwnsScreen
      ? { panelData: undefined, panelWidth: 0 }
      : buildPanelCompositeData(
        panelManager,
        input,
        shellLayout.panel?.width ?? 0,
        shellLayout.panel?.height ?? vHeight,
      );

    compositor.composite({
      width, height,
      header: shellHeaderLines,
      viewport,
      footer: shellFooterLines,
      selection: onboardingOwnsScreen ? undefined : {
        isCellSelected: (col, row) => selection.isCellSelected(col, row),
        scrollTop,
        lineCount: conversation.history.getLineCount(),
      },
      search: !onboardingOwnsScreen && input.searchManager.active ? {
        manager: input.searchManager,
        scrollTop,
        viewportStartY: shellHeaderLines.length,
      } : undefined,
      panel: panelComposite.panelData,
      panelWidth: panelComposite.panelWidth,
    });
  };
  const terminalOutputGuard = installTuiTerminalOutputGuard({ stdout, stderr: process.stderr, notify: (message) => { systemMessageRouter.low(message); render(); } });

  setRenderRequest(render);
  orchestratorRefs.requestRender = render;
  commandContext.renderRequest = render;
  wireShellUiOpeners({
    commandContext,
    input,
    panelManager,
    conversation,
    configManager,
    providerRegistry,
    runtime,
    featureFlags: ctx.featureFlags,
    mcpRegistry: ctx.services.mcpRegistry,
    subscriptionManager,
    secretsManager,
    serviceRegistry: ctx.services.serviceRegistry,
    workingDirectory: workingDir,
    homeDirectory,
    getConfiguredProviderIds: ctx._getConfiguredProviderIds,
    getPinned: ctx._getPinned,
    render,
  });

  const { refreshGit, unsubs: turnUnsubs } = wireTurnEventHandlers({
    events: uiServices.events,
    conversation,
    runtime,
    orchestrator,
    configManager,
    providerRegistry,
    systemMessageRouter,
    hookDispatcher,
    workingDir,
    homeDirectory,
    sessionManager: ctx.services.sessionManager,
    gitStatusProvider,
    lastGitInfoRef,
    buildSessionContinuityHints,
    render, webhookNotifier: ctx.services.webhookNotifier,
  });
  unsubs.push(...turnUnsubs);

  // Stable turn context for failover retry — set in submitInput, read by retryTurn.
  let retryCtx: { count: number; text: string; content?: ContentPart[]; opts?: Parameters<typeof orchestrator.handleUserInput>[2] } | null = null;
  // One-key retry affordance: active immediately after a user-visible TURN_ERROR.
  // While active, 'r' re-submits on the current provider, 'm' opens the model
  // picker. Any other character clears the affordance and routes normally.
  let errorAffordanceActive = false;
  const retryTurn = (): void => {
    if (!retryCtx) return;
    const { count, text, content: rContent, opts: rOpts } = retryCtx;
    // Roll back to pre-submission count, then re-submit. SDK gap — no retry-in-place (see handoff).
    conversation.removeMessagesAfter(count);
    orchestrator.handleUserInput(text, rContent, rOpts).catch((e: unknown) => logger.debug('retryTurn', { error: summarizeError(e) }));
  };
  const streamResult: WireStreamEventMetricsResult = wireStreamEventMetrics({
    events: uiServices.events, orchestrator, providerRegistry,
    systemMessageRouter, render, metrics: streamMetrics,
    providerOptimizer: ctx.services.providerOptimizer, costLookup: providerRegistry, retryTurn,
  });
  unsubs.push(...streamResult.unsubs);
  // Activate one-key retry affordance when a user-visible error surfaces.
  streamResult.onErrorSurfaced((exhausted) => {
    if (retryCtx) {
      errorAffordanceActive = true;
      systemMessageRouter.low(exhausted ? '[Retry] r retry same provider · m switch model' : '[Retry] r retry · m switch model');
      render();
    }
  });

  // Register terminal-restoring crash/termination handlers BEFORE entering raw mode so a
  // throw during terminal setup or the initial render still restores the terminal; the
  // 'exit' listener is the final safety net for any process.exit path.
  process.on('uncaughtException', uncaughtExceptionHandler);
  process.on('SIGTERM', terminationSignalHandler);
  process.on('SIGHUP', terminationSignalHandler);
  process.on('exit', exitListener);

  // --- Terminal setup ---
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  allowTerminalWrite(() => stdout.write((cli.flags.noAltScreen ? '' : ALT_SCREEN_ENTER) + CLEAR_SCREEN + CURSOR_HIDE + MOUSE_ENABLE + KEYBOARD_EXT_ENABLE + PASTE_ENABLE));

  applyInitialTuiCliState({ cli, input, commandRegistry, commandContext, shellPaths: ctx.services.shellPaths, render });

  stdin.on('data', (data: string) => {
    const blocking = handleBlockingShellInput({
      data, pendingPermission, recoveryPending, conversation, systemMessageRouter, render,
      abortTurn: () => orchestrator.abort(),
      loadRecoveryConversation: () => loadRecoveryConversation({ homeDirectory }),
      deleteRecoveryFile: () => deleteRecoveryFile({ homeDirectory }),
      homeDirectory, sessionId: runtime.sessionId,
      persistSnapshot: createPersistRecoverySnapshot({ sessionManager: ctx.services.sessionManager, runtime, conversation }),
      reopenPanels: createReopenRecoveryPanels({ panelManager, render }),
    });
    pendingPermission = blocking.pendingPermission;
    recoveryPending = blocking.recoveryPending;
    if (blocking.handled) {
      return;
    }

    // One-key retry affordance: armed after a user-visible TURN_ERROR; any key other than r/m dismisses it and routes normally.
    if (errorAffordanceActive) {
      errorAffordanceActive = false;
      if (handleErrorAffordanceKey(data, { retryArmed: retryCtx !== null, retry: retryTurn, openModelPicker: () => commandContext.openModelPicker?.(), render })) return;
    }

    input.feed(data);
  });
  process.on('SIGINT', sigintHandler);
  process.on('unhandledRejection', unhandledRejectionHandler);
  stdout.on('resize', resizeHandler);

  // Initial render
  conversation.rebuildHistory();
  render();

  // --- Crash recovery check ---
  const recoveryInfo = checkRecoveryFile({ workingDirectory: workingDir, homeDirectory });
  if (recoveryInfo) {
    systemMessageRouter.high(`[Recovery] Found unsaved session from ${new Date(recoveryInfo.timestamp).toLocaleString()}. Title: "${recoveryInfo.title}". Press Ctrl+R to restore, Esc to discard, or start typing to ignore it.`);
    for (const line of formatReturnContextForDisplay(recoveryInfo.returnContext)) {
      systemMessageRouter.low(`[Recovery] ${line}`);
    }
    render();
    recoveryPending = true;
  }

  // --- Auto-save to recovery file every 60s ---
  recoveryInterval = setInterval(() => {
    const snapshot = conversation.toJSON() as { messages: Array<import('./core/conversation.ts').ConversationMessageSnapshot> };
    const persisted = buildPersistedSessionContext(snapshot.messages, conversation.getTitleSource(), buildSessionContinuityHints());
    writeRecoveryFile(
      { ...snapshot, ...persisted },
      runtime.sessionId,
      conversation.title ?? '',
      { workingDirectory: workingDir, homeDirectory },
    );
  }, 60_000);

}

main().catch(err => logger.error('Fatal error', { error: err }));
