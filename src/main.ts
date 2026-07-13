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
import { PermissionPromptUI, buildPendingPermissionExtras } from './permissions/prompt.ts';
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
import { selfUpdateAtLaunch } from './cli/launch-auto-update.ts';
import { buildSharedOrchestratorCoreServices, refreshMemoryRecallSnapshot } from './runtime/orchestrator-core-services.ts';
import { readLastSessionPointer, writeRecoveryFile } from '@/runtime/index.ts';
import { handleBlockingShellInput, type PendingPermissionState } from './shell/blocking-input.ts';
import { createPersistRecoverySnapshot, createRecoveryFileOps, createReopenRecoveryPanels, handleErrorAffordanceKey, resolveStartupRecoveryInfo } from './shell/recovery-input-helpers.ts';
import { wireShellUiOpeners } from './shell/ui-openers.ts';
import { deriveComposerState } from './core/composer-state.ts';
import { buildPersistedSessionContext, formatReturnContextForDisplay, getReturnContextMode, maybeAssistReturnContextSummary } from '@/runtime/index.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { prepareShellCliRuntime } from './cli/entrypoint.ts';
import { applyInitialTuiCliState } from './cli/tui-startup.ts';
import { applyConfiguredHitlMode, applyRuntimeConfigValue, applyTuiRuntimeConfigDefaults } from './cli/config-overrides.ts';
import { renderToolCallBlock } from './renderer/tool-call.ts';
import { wireSpokenTurnRuntime } from './audio/spoken-turn-wiring.ts';
import { attachSpokenTurnModelRouting, createSpokenTurnInputOptions } from './audio/spoken-turn-model-routing.ts';
import { allowTerminalWrite, installTuiTerminalOutputGuard } from './runtime/terminal-output-guard.ts';
import { installProcessLifecycle } from './runtime/process-lifecycle.ts';
import { createRenderScheduler } from '@pellux/goodvibes-terminal-shell';
import { buildCommandArgsHint } from './input/command-args-hint.ts';
import { summarizeRunningAgents } from './renderer/process-summary.ts';
import { footerFleetCost } from './panels/fleet-read-model.ts';
import { formatUserFacingErrorLine } from './core/format-user-error.ts';
import { wireStreamEventMetrics, type StreamMetrics, type WireStreamEventMetricsResult } from './core/stream-event-wiring.ts';
import { wireTurnEventHandlers } from './core/turn-event-wiring.ts';
import { buildContextStatusHint } from './renderer/context-status-hint.ts';
import { isEffectiveDangerMode } from './config/index.ts';
import { createScriptableStatusline } from './core/scriptable-statusline.ts';
import { applyComposerCapture } from './input/composer-capture.ts';
import { createSessionAutoTitler } from './core/session-auto-titler.ts';
import { makeComposerEditorOpener } from './input/composer-editor.ts';
import { evaluateSessionMaintenance } from '@/runtime/index.ts';
import { createCancelGeneration } from './core/turn-cancellation.ts';
import { wrapRequestPermissionWithAlert } from './core/approval-alert.ts';
import { createTerminalNotifier } from './core/terminal-notifier.ts';
import { setPanelFrameRequester } from './panels/base-panel.ts';

import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT, MOUSE_ENABLE, MOUSE_DISABLE, CURSOR_HIDE, CURSOR_SHOW, CLEAR_SCREEN, KEYBOARD_EXT_ENABLE, KEYBOARD_EXT_DISABLE, PASTE_ENABLE, PASTE_DISABLE, FOCUS_ENABLE, FOCUS_DISABLE } from './renderer/terminal-escapes.ts';
import { installBackgroundThemeProbe } from './renderer/terminal-bg-probe.ts';

async function main() {
  const stdout = process.stdout;
  const stdin = process.stdin;
  const { cli, configManager, bootstrapWorkingDir, bootstrapHomeDirectory } = await prepareShellCliRuntime(process.argv.slice(2), {
    defaultWorkingDirectory: process.env['GOODVIBES_WORKING_DIR'] ?? process.cwd(),
    homeDirectory: homedir(),
  }, 'goodvibes');

  // Launch-time self-update, before any bootstrap or terminal mode change; on
  // an installed update this restarts onto the swapped binary and never returns.
  const launchUpdateLines = await selfUpdateAtLaunch({ configManager, stdout });

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
    permissionPromptRef, trustPromptRef,
    _writeLastSessionPointer: writeLastSessionPointer,
    systemMessageRouter,
  } = ctx;
  const workingDir = ctx.services.workingDirectory;
  const homeDirectory = ctx.services.homeDirectory;
  const { approvalBroker, agentManager, modeManager, processManager, providerRegistry, secretsManager, subscriptionManager } = ctx.services;
  conversation.setSessionMemoryStore(ctx.services.sessionMemoryStore);
  conversation.setSessionLineageTracker(ctx.services.sessionLineageTracker);
  // Shared payload (single source of truth, includes the memoryRegistry —
  // see orchestrator-core-services.ts) plus this site's favoritesStore.
  orchestrator.setCoreServices({
    ...buildSharedOrchestratorCoreServices({ services: ctx.services, configManager, providerRegistry }),
    favoritesStore: ctx.services.favoritesStore,
  });
  ctx.services.wrfcController.setPlanManager(ctx.services.planManager);
  let activeConversationWidth = stdout.columns || 80;
  conversation.setWidthProvider(() => activeConversationWidth);
  // Persisted HITL mode + TUI-side config defaults (doc'd at their definitions).
  applyConfiguredHitlMode(configManager, modeManager);
  applyTuiRuntimeConfigDefaults(configManager);

  // Re-surface pre-TUI launch-update lines in-session (the alt screen wipes stdout).
  for (const line of launchUpdateLines) systemMessageRouter.high(`[Update] ${line}`);

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
    lastDeltaAtMs: undefined, stallEpisode: 0,
    reconnectAttempt: undefined, reconnectMaxAttempts: undefined,
  };

  const getPromptContentWidth = () => computePromptContentWidth(stdout.columns);

  const getViewportHeight = (): number => {
    if (input.onboardingWizard.active) return stdout.rows || 24;
    const promptLines: number = input.getVisiblePromptLineCount(getPromptContentWidth());
    const currentModel = providerRegistry.getCurrentModel();
    const contextWindow = providerRegistry.getContextWindowForModel(currentModel);
    const rows = stdout.rows || 24;
    // Compact threshold must match buildShellFooter's `compact: height < 30` posture below,
    // else estimateShellFooterHeight's cached-height fast path answers with the wrong mode.
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
  let stopSpokenOutputForExit: (() => Promise<void>) | null = null;
  let recoveryPending = false;
  // Which file the current recovery prompt should load/delete from (see recovery-input-helpers.ts).
  let recoverySource: 'live' | 'preserved' = 'live';

  const lifecycle = installProcessLifecycle({
    stdin,
    stdout,
    ctx,
    noAltScreen: cli.flags.noAltScreen,
    ansi: { CLEAR_SCREEN, ALT_SCREEN_EXIT, PASTE_DISABLE, KEYBOARD_EXT_DISABLE, MOUSE_DISABLE, CURSOR_SHOW, FOCUS_DISABLE },
    getInput: () => input,
    render: () => renderScheduler.flushNow(), // resize: synchronous immediate path
    getPromptContentWidth,
    getTerminalOutputGuard: () => terminalOutputGuard,
    buildSessionContinuityHints,
    unsubs,
    getRecoveryInterval: () => recoveryInterval,
    setRecoveryInterval: (value) => { recoveryInterval = value; },
    getStopSpokenOutputForExit: () => stopSpokenOutputForExit,
  });
  const { exitApp, resizeHandler, sigintHandler, unhandledRejectionHandler, uncaughtExceptionHandler, terminationSignalHandler, exitListener } = lifecycle;
  commandContext.exit = exitApp;

  // In-terminal (OSC 9) notifier (approval-wait/turn-end/agent-blocked); writes
  // are restore-gated so no escape sequence lands after the shell resumes.
  const terminalNotifier = createTerminalNotifier({
    stdout, focusTracker: ctx.services.focusTracker, isReleased: () => lifecycle.isTerminalRestored(),
    configGet: (k: string) => configManager.get(k as Parameters<typeof configManager.get>[0]),
  });

  const spokenTurns = wireSpokenTurnRuntime({
    voiceService: ctx.services.voiceService,
    configManager,
    events: uiServices.events,
    notify: (message) => { systemMessageRouter.high(message); render(); },
  });
  // Exit-path stop: bounded drain of the audio already playing (see stopForExit).
  stopSpokenOutputForExit = () => spokenTurns.stopForExit();
  unsubs.push(...spokenTurns.unsubs);
  // Scriptable status line: runs the user's `statusline.command` at turn boundaries.
  const scriptableStatusline = createScriptableStatusline({ configManager, cwd: workingDir, turns: uiServices.events.turns, onChange: () => render() });
  unsubs.push(...scriptableStatusline.unsubs);
  // Auto-title an untitled session via the weak/fast tool model (session.autoTitle, off by default).
  const sessionAutoTitler = createSessionAutoTitler({
    conversation, model: ctx.services.toolLLM, configManager, turns: uiServices.events.turns,
    onTitled: (title) => { systemMessageRouter.high(`[Session] Auto-titled: "${title}"`); render(); },
  });
  unsubs.push(...sessionAutoTitler.unsubs);
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
    // Composer capture markers: `!#` pins + sends; `#` saves a note without sending.
    processedText = applyComposerCapture(processedText, {
      sessionMemoryStore: ctx.services.sessionMemoryStore,
      notify: (message) => systemMessageRouter.high(message),
    }).text;
    if (processedText || content) {
      void (async () => {
        const inputOptions = options.spokenOutput ? createSpokenTurnInputOptions() : undefined;
        if (options.spokenOutput && processedText) { spokenTurns.submitNextTurn(processedText); }
        // Snapshot pre-submission state for failover retryTurn; also clears visited set.
        retryCtx = { count: conversation.getMessageCount(), text: processedText, content, opts: inputOptions };
        streamResult.clearFailoverVisited();
        await refreshMemoryRecallSnapshot(ctx.services); // pre-turn recall-snapshot refresh (SDK 1.2.0 full detach)
        orchestrator.handleUserInput(processedText, content, inputOptions).catch((err: unknown) => {
          logger.debug('handleUserInput safety catch (already handled by runTurn)', { error: summarizeError(err) });
        });
      })();
    } else {
      render();
    }
  };

  const cancelGeneration = createCancelGeneration(orchestrator, spokenTurns);

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
  commandContext.stopSpokenOutput = () => spokenTurns.stop(); commandContext.pasteFromClipboard = () => input.handlePaste();
  commandContext.executeCommand = (name, args) => commandRegistry.execute(name, args, commandContext);
  // Late-patched: bootstrap.ts populates uiServices.platform.externalServices AFTER commandContext is built.
  commandContext.platform.externalServices = uiServices.platform.externalServices;
  commandContext.cancelGeneration = cancelGeneration;
  commandContext.isGenerating = () => orchestrator.isThinking;
  commandContext.jumpToBookmark = jumpToBookmark; commandContext.scrollToLine = scrollToLine;
  commandContext.clearScreen = () => {
    compositor.resetDiff();
    allowTerminalWrite(() => stdout.write(CLEAR_SCREEN));
    render();
  };
  commandContext.requestFullRepaint = () => { compositor.resetDiff(); render(); }; commandContext.beginConcealedInput = (req) => input.beginConcealedInput(req);
  permissionPromptRef.requestPermission = wrapRequestPermissionWithAlert((request) =>
    new Promise((resolve) => {
      pendingPermission = {
        ...request,
        ...buildPendingPermissionExtras(request, resolve, approvalBroker),
      };
      render();
    }), { focusTracker: ctx.services.focusTracker, configGet: (k: string) => configManager.get(k as Parameters<typeof configManager.get>[0]), webhookNotifier: ctx.services.webhookNotifier, terminalNotifier });

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
        externalServices: uiServices.platform.externalServices, focusTracker: ctx.services.focusTracker,
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
        sessionBroker: uiServices.sessions.sessionBroker,
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
  commandContext.openComposerEditor = makeComposerEditorOpener({ buffer: input, stdin, stdout, writeGuard: allowTerminalWrite, repaint: () => { compositor.resetDiff(); render(); }, cwd: workingDir, env: process.env, notify: (m) => systemMessageRouter.high(m) });
  input.setConversationManager(conversation);
  input.setContentWidth(getPromptContentWidth());
  input.filePicker.setOnUpdate(() => render());
  // retirement: agentDetailModal/processModal setOnRefresh wiring removed —
  // those modals were deleted (Fleet subsumes the live process tree via F2).

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

  const renderNow = () => {
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
      usage: { up: orchestrator.usage.input, down: orchestrator.usage.output, fleetCostUsd: footerFleetCost(() => ctx.services.processRegistry.query().nodes, runningAgentCount > 0) },
      showExitNotice: input.showExitNotice,
      lastCopyTime: input.lastCopyTime,
      model: runtime.model,
      toolCount: toolRegistry.list().length,
      workingDir,
      provider: runtime.provider,
      contextWindow,
      contextStatusHint,
      scriptableStatusLine: scriptableStatusline.current(),
      // Compact footer posture on short terminals so the shell stays usable.
      compact: height < 30,
      // behavior.autoCompactThreshold is stored as a percent integer (e.g. 80);
      // the meter expects a fraction [0..1]. Clamp to [0,1] to guard nonsense values.
      compactThreshold: Math.min(1, Math.max(0, (configManager.get('behavior.autoCompactThreshold') as number) / 100)),
      dangerMode: isEffectiveDangerMode(configManager),
      lastInputTokens: orchestrator.lastInputTokens,
      commandArgsHint,
      hitlMode: modeManager.getHITLMode(),
      // Cross-surface spine posture segment (adopted-daemon mode only).
      sessionSpineStatus: (() => { const s = uiServices.platform.externalServices?.inspect(); return s?.sessionSpineActive && s.sessionSpineStatus && s.sessionSpineStatus !== 'unknown' ? s.sessionSpineStatus : undefined; })(), runningAgentCount, runningProcessCount,
      // Composer must not read as focused while the panel/process indicator owns keyboard focus.
      promptFocused: !input.panelFocused && !input.indicatorFocused,
      indicatorFocused: input.indicatorFocused,
      runningAgentProgress: runningAgentSummary.progress,
      composerMode: composerState.modeLabel,
      composerStatus: composerState.statusLabel,
      composerFlags: composerState.flags,
      composerPendingRisk: composerState.pendingRisk, permissionMode: configManager.get('permissions.mode') as string,
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
    if (pendingPermission) overlayRows += PermissionPromptUI.getPromptHeight(pendingPermission, pendingPermission.hunkState, pendingPermission.detailsExpanded, pendingPermission.requestedBy, PermissionPromptUI.promptViewState(pendingPermission, conversationWidth, approvalBroker));
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
      // Suppressed while a tool executes — its ticking timer is the honest indicator then.
      const stallInfo = UIFactory.computeRenderStallInfo(streamMetrics, Date.now());
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
        stallInfo,
        pendingPermission !== null,
      );
      viewport.push(...thinking);
      // Live tool timer: render the currently executing tool row with ticking elapsed.
      if (streamMetrics.activeToolName !== undefined && streamMetrics.activeToolStartedAtMs !== undefined) {
        const liveToolCall = { id: 'live', name: streamMetrics.activeToolName, arguments: {} };
        viewport.push(...renderToolCallBlock(liveToolCall, 'executing', undefined, conversationWidth, undefined, undefined, undefined, streamMetrics.activeToolStartedAtMs));
      }
    }

    if (pendingPermission) {
      viewport.push(...PermissionPromptUI.createPromptLines(conversationWidth, pendingPermission, pendingPermission.hunkState, pendingPermission.detailsExpanded, pendingPermission.requestedBy, PermissionPromptUI.promptViewState(pendingPermission, conversationWidth, approvalBroker)));
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
  const renderScheduler = createRenderScheduler(renderNow, undefined, () => lifecycle.isTerminalRestored()); // coalescer; no frames after terminal restore
  const render = (): void => renderScheduler.schedule(); // captured direct writes → activity log + quiet /debug counter, not repeated transcript lines (1a)
  const terminalOutputGuard = installTuiTerminalOutputGuard({ stdout, stderr: process.stderr, onCapture: (total) => { commandContext.session.runtime.terminalWritesIntercepted = total; render(); } });

  setRenderRequest(() => renderScheduler.flushNow()); // bootstrap's 16ms coalescer composites via the (restore-gated) scheduler
  setPanelFrameRequester(render); // live panels repaint when idle (a replay finding: fleet sat stale until keypress)
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
    memoryEmbeddingRegistry: ctx.services.memoryEmbeddingRegistry,
    workingDirectory: workingDir,
    homeDirectory,
    getConfiguredProviderIds: ctx._getConfiguredProviderIds,
    getPinned: ctx._getPinned,
    render, trustPromptRef,
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
    render, webhookNotifier: ctx.services.webhookNotifier, focusTracker: ctx.services.focusTracker, terminalNotifier, runtimeBus: uiServices.runtime.runtimeBus,
  });
  unsubs.push(...turnUnsubs);

  // Stable turn context for failover retry — set in submitInput, read by retryTurn.
  let retryCtx: { count: number; text: string; content?: ContentPart[]; opts?: Parameters<typeof orchestrator.handleUserInput>[2] } | null = null;
  // One-key retry affordance, active right after a user-visible TURN_ERROR: 'r' re-submits on the
  // current provider, 'm' opens the model picker, any other character clears it and routes normally.
  let errorAffordanceActive = false;
  const retryTurn = (): void => {
    if (!retryCtx) return;
    const { count, text, content: rContent, opts: rOpts } = retryCtx;
    // Roll back to pre-submission count, then re-submit. SDK gap — no retry-in-place (see handoff).
    conversation.removeMessagesAfter(count);
    void refreshMemoryRecallSnapshot(ctx.services).then(() => orchestrator.handleUserInput(text, rContent, rOpts)).catch((e: unknown) => logger.debug('retryTurn', { error: summarizeError(e) }));
  };
  const streamResult: WireStreamEventMetricsResult = wireStreamEventMetrics({
    events: uiServices.events, orchestrator, providerRegistry,
    systemMessageRouter, render, metrics: streamMetrics,
    providerOptimizer: ctx.services.providerOptimizer, costLookup: providerRegistry, retryTurn,
    isApprovalPending: () => pendingPermission !== null,
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

  // Register terminal-restoring crash/termination handlers BEFORE entering raw mode so a throw
  // during setup or the initial render still restores the terminal; 'exit' is the final safety net.
  process.on('uncaughtException', uncaughtExceptionHandler);
  process.on('SIGTERM', terminationSignalHandler);
  process.on('SIGHUP', terminationSignalHandler);
  process.on('exit', exitListener);

  // --- Terminal setup ---
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  allowTerminalWrite(() => stdout.write((cli.flags.noAltScreen ? '' : ALT_SCREEN_ENTER) + CLEAR_SCREEN + CURSOR_HIDE + MOUSE_ENABLE + KEYBOARD_EXT_ENABLE + PASTE_ENABLE + FOCUS_ENABLE));
  // forced dark/light applies before first paint; auto (TTY only) fires the
  // OSC 11 probe and repaints once if light wins. filterInput strips the reply from stdin.
  const themeProbe = installBackgroundThemeProbe({ configManager, isTTY: Boolean(stdout.isTTY), env: process.env, writeQuery: (b) => allowTerminalWrite(() => stdout.write(b)), requestRepaint: () => { compositor.resetDiff(); render(); } });

  applyInitialTuiCliState({ cli, input, commandRegistry, commandContext, shellPaths: ctx.services.shellPaths, render });

  stdin.on('data', (raw: string) => {
    const data = themeProbe.filterInput(raw); if (data.length === 0) return;
    const blocking = handleBlockingShellInput({
      data, pendingPermission, recoveryPending, conversation, systemMessageRouter, render,
      abortTurn: () => orchestrator.abort(),
      ...createRecoveryFileOps(() => recoverySource, { homeDirectory }),
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

  // --- Crash recovery check (also checks the preserve-on-dismiss sibling; see recovery-input-helpers.ts) ---
  const recoveryInfo = resolveStartupRecoveryInfo({ workingDirectory: workingDir, homeDirectory });
  if (recoveryInfo) {
    recoverySource = recoveryInfo.source;
    systemMessageRouter.high(`[Recovery] Found unsaved session from ${new Date(recoveryInfo.timestamp).toLocaleString()}. Title: "${recoveryInfo.title}". Press Ctrl+R to restore, Esc to discard, or start typing to ignore it.`);
    for (const line of formatReturnContextForDisplay(recoveryInfo.returnContext)) {
      systemMessageRouter.low(`[Recovery] ${line}`);
    }
    render();
    recoveryPending = true;
  }

  // --- Auto-save to recovery file every 60s ---
  recoveryInterval = setInterval(() => {
    // Skip while an earlier recovery prompt is unresolved (avoids racing preserve-on-dismiss).
    if (recoveryPending) return;
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
