#!/usr/bin/env bun
import { resolveGoodVibesDaemonHome, resolveGoodVibesHome } from '@pellux/goodvibes-sdk/platform/config';
import { Compositor } from './renderer/compositor.ts';
import { type Line } from '@pellux/goodvibes-sdk/platform/types';
import { UIFactory } from './renderer/ui-factory.ts';
import { Orchestrator } from '@pellux/goodvibes-sdk/platform/core';
import { InputHandler } from './input/handler.ts';
import { SelectionManager } from './input/selection.ts';
import type { ContentPart } from '@pellux/goodvibes-sdk/platform/providers';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import { registerAllTools } from '@pellux/goodvibes-sdk/platform/tools';
import { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state';
import { PermissionManager } from '@pellux/goodvibes-sdk/platform/permissions';
import { AcpManager } from '@pellux/goodvibes-sdk/platform/acp';
import { PermissionPromptUI, buildPendingPermissionExtras } from './permissions/prompt.ts';
import { handleBrokerApprovalChange, buildFixSessionAffordance, buildFixSessionErrorNotice, handleFixSessionAttachKey, refreshFixSessionsFromApprovals } from './permissions/broker-approval-card.ts';
import { CommandRegistry } from './input/command-registry.ts';
import type { CommandContext } from './input/command-registry.ts';
import { requestedEffortLevel } from './providers/reasoning-effort-surface.ts';
import { renderProcessIndicator } from './renderer/process-indicator.ts';
import { registerBuiltinCommands } from './input/commands.ts';
import { ScheduleManager } from '@pellux/goodvibes-sdk/platform/tools';
import { InputHistory } from './input/input-history.ts';
import { getTierPromptSupplement, getTierForContextWindow } from '@pellux/goodvibes-sdk/platform/providers';
import { GitStatusProvider } from './renderer/git-status.ts';
import type { GitHeaderInfo } from './renderer/git-status.ts';
import { createShellLayout } from './renderer/layout-engine.ts';
import { buildShellFooter, estimateShellFooterHeight, promptCursorOffset } from './renderer/shell-surface.ts';
import { createFailoverTurnState, resolveActiveModelDisplay } from './core/active-model-identity.ts';
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
import { createSessionContinuityHintsBuilder } from './runtime/session-continuity-hints.ts';
import { resolveWebSurfaceUrl } from '@pellux/goodvibes-sdk/platform/runtime/feature-announcements';
import { readLastSessionPointer } from '@/runtime/index.ts';
import { startRecoveryAutosave } from './runtime/recovery-autosave.ts';
import { scheduleRecoveryOffer } from './runtime/recovery-prompt.ts';
import { buildRecoveryOfferWiring } from './runtime/recovery-offer-wiring.ts';
import { handleBlockingShellInput, type PendingPermissionState } from './shell/blocking-input.ts';
import { handleErrorAffordanceKey } from './shell/recovery-input-helpers.ts';
import { createRetryAffordanceState, disarmRetryAffordance, retryAffordanceHint, wireRetryAffordanceOnError } from './shell/retry-affordance.ts';
import { wireShellUiOpeners } from './shell/ui-openers.ts';
import { deriveComposerState } from './core/composer-state.ts';
import { resolveFoldedBookmarkLine } from './core/bookmark-navigation.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { prepareShellCliRuntime } from './cli/entrypoint.ts';
import { applyInitialTuiCliState, reportFatalStartupError } from './cli/tui-startup.ts';
import { applyConfiguredHitlMode, applyRuntimeConfigValue, applyTerminalRuntimeConfigDefaults } from '@pellux/goodvibes-terminal-shell';
import { renderToolCallBlock } from './renderer/tool-call.ts';
import { wireSpokenTurnRuntime } from './audio/spoken-turn-wiring.ts';
import { installVoiceCapture } from './shell/voice-capture-shell.ts';
import { attachSpokenTurnModelRouting, createSpokenTurnInputOptions } from './audio/spoken-turn-model-routing.ts';
import { allowTerminalWrite, installFullScreenTerminalOutputGuard } from '@pellux/goodvibes-terminal-shell/terminal-output-guard';
import { installProcessLifecycle } from './runtime/process-lifecycle.ts';
import { createRenderScheduler } from '@pellux/goodvibes-terminal-shell';
import { buildCommandArgsHint } from './input/command-args-hint.ts';
import { summarizeRunningAgents } from './renderer/process-summary.ts';
import { footerFleetCost } from './panels/fleet-read-model.ts';
import { formatUserFacingErrorLine } from './core/format-user-error.ts';
import { wireStreamEventMetrics, createStreamMetrics, type StreamMetrics, type WireStreamEventMetricsResult } from './core/stream-event-wiring.ts';
import { wireTurnEventHandlers } from './core/turn-event-wiring.ts';
import { resolveContextStatusHint } from './renderer/context-status-hint.ts';
import { isEffectiveDangerMode } from '@pellux/goodvibes-sdk/platform/config';
import { createScriptableStatusline } from './core/scriptable-statusline.ts';
import { applyComposerCapture, applyAtModelDirective } from './input/composer-capture.ts';
import { createSessionAutoTitler } from './core/session-auto-titler.ts';
import { makeComposerEditorOpener } from './input/composer-editor.ts';
import { evaluateSessionMaintenance } from '@/runtime/index.ts';
import { createCancelGeneration } from './core/turn-cancellation.ts';
import { wireInteractionSeams, createMemoryProvenanceUi } from './runtime/interaction-seams.ts';
import { createPowerChipSource } from './core/power-chip-source.ts';
import { fetchDaemonPowerState, installKeepAwakeRemoteForward } from './runtime/power-keepawake-remote.ts';
import { wrapRequestPermissionWithAlert } from './core/approval-alert.ts';
import { createTerminalNotifier } from './core/terminal-notifier.ts';
import { setPanelFrameRequester } from './panels/base-panel.ts';

import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT, MOUSE_ENABLE, MOUSE_DISABLE, CURSOR_HIDE, CURSOR_SHOW, CLEAR_SCREEN, KEYBOARD_EXT_ENABLE, KEYBOARD_EXT_DISABLE, PASTE_ENABLE, PASTE_DISABLE, FOCUS_ENABLE, FOCUS_DISABLE } from './renderer/terminal-escapes.ts';
import { installBackgroundThemeProbe } from './renderer/terminal-bg-probe.ts';
import { VERSION } from './version.ts';

async function main() {
  const stdout = process.stdout;
  const stdin = process.stdin;
  // Both roots come from the one resolver the daemon CLI also uses. This line
  // called homedir() unconditionally, so a harness that redirected the tree got
  // a client that wrote the real one — secret store included.
  const { cli, configManager, bootstrapWorkingDir, bootstrapHomeDirectory } = await prepareShellCliRuntime(process.argv.slice(2), {
    defaultWorkingDirectory: process.env['GOODVIBES_WORKING_DIR'] ?? process.cwd(),
    homeDirectory: resolveGoodVibesHome(),
  }, 'goodvibes');

  // Between binary start and the first frame, boot used to be silent (config
  // load, trust manager, memory init, hooks). One honest pre-alt-screen line,
  // placed after the help/version/completion early-exits above so those stay
  // byte-clean.
  stdout.write(`goodvibes v${VERSION} starting…\n`);

  // Launch-time self-update, before any bootstrap or terminal mode change; on
  // an installed update this restarts onto the swapped binary and never returns.
  const launchUpdateLines = await selfUpdateAtLaunch({ configManager, stdout });

  const ctx: BootstrapContext = await bootstrapRuntime(stdout, {
    configManager,
    workingDir: bootstrapWorkingDir,
    homeDirectory: bootstrapHomeDirectory,
    // Named, so GOODVIBES_DAEMON_HOME on its own moves the client's daemon tier.
    daemonHomeDirectory: resolveGoodVibesDaemonHome(bootstrapHomeDirectory),
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
  applyTerminalRuntimeConfigDefaults(configManager);

  // Re-surface pre-TUI launch-update lines in-session (the alt screen wipes
  // stdout). Launch-time update mechanics are routine, not urgent — low
  // priority, not high (a skipped/deferred check is not the kind of thing
  // that should compete with real session alerts for attention).
  for (const line of launchUpdateLines) systemMessageRouter.low(`[Update] ${line}`);

  const panelManager = ctx.services.panelManager;
  const buildSessionContinuityHints = createSessionContinuityHintsBuilder({ readModels: uiServices.readModels, panelManager });

  let pendingPermission: PendingPermissionState | null = null;
  // One-key jump/attach to a spawned CI fix-session: the affordance ARMS the id; the next 'j' runs the resume so the user never retypes it.
  let fixSessionAttachArmed: string | null = null;
  const attachToFixSession = (fixSessionId: string) => { void commandContext.executeCommand?.('session', ['resume', fixSessionId]); };
  const onFixSessionStarted = buildFixSessionAffordance({
    notify: (message) => { systemMessageRouter.high(message); render(); },
    arm: (fixSessionId) => { fixSessionAttachArmed = fixSessionId; },
  });
  // A failed fix-session spawn stamps an error instead of a dead id: render it honestly, no jump armed.
  const onFixSessionError = buildFixSessionErrorNotice((message) => { systemMessageRouter.high(message); render(); });
  commandContext.armFixSessionAttach = onFixSessionStarted;
  approvalBroker.subscribe((approval) => handleBrokerApprovalChange({
    approval, broker: approvalBroker, render, onFixSessionStarted, onFixSessionError,
    getPending: () => pendingPermission,
    setPending: (next) => { pendingPermission = next; },
  }));
  refreshFixSessionsFromApprovals(() => approvalBroker.listApprovals(), onFixSessionStarted, onFixSessionError); // catch pre-subscription stamps

  let scrollTop = 0;
  let scrollLocked = true;
  // Cached from the overlay-aware clamp the renderer computes (conversation-layout) each frame so scroll() clamps against exactly what is displayed, not a footer estimate.
  let lastMaxScroll: number | null = null;
  // Stream and tool-timer state; mutated by wireStreamEventMetrics handlers, read during render.
  const streamMetrics: StreamMetrics = createStreamMetrics();
  // Live failover record — written by the failover path, read every frame so the header and footer agree.
  const failoverState = createFailoverTurnState();

  const getPromptContentWidth = () => computePromptContentWidth(stdout.columns);
  // Live-microphone footer row (push-to-talk or the wake detector); assigned once voice capture is wired below, null until then so pre-wiring frames size correctly.
  let voiceCaptureStatus: () => import('./core/voice-capture-status.ts').VoiceCaptureIndicatorState | null = () => null;

  const getViewportHeight = (): number => {
    if (input.onboardingWizard.active) return stdout.rows || 24;
    const promptLines: number = input.getVisiblePromptLineCount(getPromptContentWidth());
    const currentModel = providerRegistry.getCurrentModel();
    const contextWindow = providerRegistry.getContextWindowForModel(currentModel);
    const rows = stdout.rows || 24;
    // Compact threshold must match buildShellFooter's `compact: height < 30` posture below, else estimateShellFooterHeight's cached-height fast path answers with the wrong mode.
    return rows - 2 - estimateShellFooterHeight(promptLines, contextWindow, rows < 30, voiceCaptureStatus());
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
  // The optional "used N memories" provenance chip (default OFF) — see interaction-seams.ts.
  const memoryProvenanceUi = createMemoryProvenanceUi({ render: () => render(), memorySpine: ctx.services.memorySpine });
  // Topology-aware keep-awake: the chip renders the DAEMON's state in adopted-external mode (power-chip-source.ts) and every toggle is forwarded to that daemon (power-keepawake-remote.ts) so keep-awake survives the TUI closing in BOTH topologies.
  const isExternalDaemon = () => uiServices.platform.externalServices?.inspect()?.daemonStatus?.mode === 'external';
  const powerChipSource = createPowerChipSource({ powerManager: ctx.services.powerManager, render: () => render(), isExternalDaemon,
    onPowerEvent: (cb) => uiServices.events.ops.on('OPS_POWER_STATE_CHANGED', cb as never), fetchDaemonPowerState: () => fetchDaemonPowerState({ configManager, homeDirectory, isExternalDaemon }) });
  unsubs.push(powerChipSource.stop, installKeepAwakeRemoteForward({ configManager, homeDirectory, isExternalDaemon }));
  // The interactive process composes a full runtime graph too, and that graph
  // starts pollers. Drained with the rest of the teardown registry on exit.
  unsubs.push(() => { ctx.services.dispose(); });

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
    conversation.dismissSplash(); // owner rule: any submission retires the splash for the run
    let processedText = applyAtModelDirective(text, {
      providerRegistry, runtime, configManager, notify: (m) => systemMessageRouter.high(m),
    });
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
    const line = block?.startLine ?? resolveFoldedBookmarkLine(conversation, key);
    if (line === null) {
      systemMessageRouter.high(`[Bookmark] Not found: ${key}`);
      render();
      return;
    }
    scrollLocked = false;
    scrollTop = Math.max(0, line);
    render();
  };

  const scrollToLine = (line: number) => {
    conversation.getDisplayBlocks();
    const maxScroll = Math.max(0, conversation.history.getLineCount() - getViewportHeight());
    scrollLocked = false;
    scrollTop = Math.max(0, Math.min(line, maxScroll));
    render();
  };

  commandContext.submitInput = submitInput; commandContext.submitSpokenInput = (text, content) => submitInput(text, content, { spokenOutput: true });
  commandContext.stopSpokenOutput = () => spokenTurns.stop(); commandContext.pasteFromClipboard = () => input.handlePaste();
  // Read-only view of pending [TEXT: pN, M lines] fold markers, so /pastes
  // can preview a folded paste's actual content before the user submits it.
  commandContext.getPendingPastes = () => input.pasteRegistry;
  commandContext.executeCommand = (name, args) => commandRegistry.execute(name, args, commandContext);
  // Late-patched: bootstrap.ts populates uiServices.platform.externalServices AFTER commandContext is built.
  commandContext.platform.externalServices = uiServices.platform.externalServices;
  commandContext.cancelGeneration = cancelGeneration;
  wireInteractionSeams(commandContext, {
    orchestrator, powerManager: ctx.services.powerManager, readPowerSurface: () => powerChipSource.get(), render: () => render(), notify: (m) => systemMessageRouter.high(m),
    getActiveToolCallId: () => streamMetrics.activeToolCallId, toggleMemoryProvenance: () => memoryProvenanceUi.toggle(),
  });
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
        pairingTokens: ctx.services.pairingTokens, tokenAuditor: ctx.services.tokenAuditor,
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

  orchestratorRefs.getViewportHeight = getViewportHeight; orchestratorRefs.scrollToEnd = scrollToEnd;

  input.setCommandRegistry(commandRegistry, commandContext);
  commandContext.openComposerEditor = makeComposerEditorOpener({ buffer: input, stdin, stdout, writeGuard: allowTerminalWrite, repaint: () => { compositor.resetDiff(); render(); }, cwd: workingDir, env: process.env, notify: (m) => systemMessageRouter.high(m) });
  input.setConversationManager(conversation);
  input.setContentWidth(getPromptContentWidth()); input.filePicker.setOnUpdate(() => render());
  // retirement: agentDetailModal/processModal setOnRefresh wiring removed —
  // those modals were deleted (Fleet subsumes the live process tree via F2).

  // Model picker callback is handled in bootstrap.ts — do not duplicate here.
  input.setHistory(inputHistory);
  // ONE microphone path, shared by push-to-talk voice input (Alt+V) and wake-word detection; opens no device by itself (shell/voice-capture-shell.ts).
  voiceCaptureStatus = installVoiceCapture({ configManager, shellPaths: ctx.services.shellPaths, homeDirectory, sessionId: ctx.runtime.sessionId, commandContext, unsubs, buffer: input, submitInput, notify: (m) => { systemMessageRouter.high(m); render(); }, render: () => render() });

  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir,
    model: runtime.model,
    provider: runtime.provider,
    toolCount,
    lastSessionId: readLastSessionPointer({ surface: ctx.services.surface }) ?? undefined,
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

    const activeModel = resolveActiveModelDisplay({ serving: currentModel, configuredRegistryKey: configManager.get('provider.model') as string, configuredLabel: runtime.model, configuredProvider: runtime.provider, failover: failoverState.current() });
    const headerLines = UIFactory.createHeader(width, activeModel.headerModel, activeModel.headerProvider, conversation.title || undefined, lastGitInfoRef.value, undefined, activeModel.divergenceNote);
    const managerAgents = agentManager.list().filter((a) => a.status === 'running' || a.status === 'pending');
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
      hasAttachments: input.getImageAttachments().size > 0, turnState: sessionSnapshot.turnState,
    });
    const contextStatusHint = resolveContextStatusHint({
      evaluate: (args) => evaluateSessionMaintenance({ configManager, ...args, sessionMemoryCount: ctx.services.sessionMemoryStore.list().length }),
      currentTokens: orchestrator.lastInputTokens, contextWindow,
    });
    const footerLines = buildShellFooter({
      width,
      promptText: promptInfo.visibleLines.join('\n'),
      promptLineCount: promptInfo.visibleLines.length,
      promptCursorPos: promptCursorOffset(promptInfo),
      usage: { up: orchestrator.usage.input, down: orchestrator.usage.output, fleetCostUsd: footerFleetCost(() => ctx.services.processRegistry.query().nodes, runningAgentCount > 0) },
      showExitNotice: input.showExitNotice,
      lastCopyTime: input.lastCopyTime,
      model: activeModel.footerModel, modelNote: activeModel.divergenceNote,
      toolCount: toolRegistry.list().length,
      workingDir,
      provider: activeModel.footerProvider,
      contextWindow,
      contextStatusHint,
      retryHint: retryAffordanceHint(retryAffordance),
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
      webSurfaceUrl: configManager.get('web.enabled') ? resolveWebSurfaceUrl(configManager) : undefined,
      // Always-visible "sleep disabled" chip — topology-aware: the DAEMON's state in adopted-external mode, the in-process manager otherwise (power-chip-source.ts).
      powerKeepAwake: powerChipSource.get().keepAwake,
      // Composer must not read as focused while the panel/process indicator owns keyboard focus.
      promptFocused: !input.panelFocused && !input.indicatorFocused,
      indicatorFocused: input.indicatorFocused,
      runningAgentProgress: runningAgentSummary.progress,
      composerMode: composerState.modeLabel,
      composerStatus: composerState.statusLabel,
      composerFlags: composerState.flags,
      composerPendingRisk: composerState.pendingRisk, permissionMode: configManager.get('permissions.mode') as string, voiceCapture: voiceCaptureStatus(),
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
    if (conversation.consumeSplashTransition()) compositor.requestFullRepaint(); // splash → transcript: repaint the whole viewport once

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
        const liveToolCall = { id: streamMetrics.activeToolCallId ?? 'live', name: streamMetrics.activeToolName, arguments: {} };
        viewport.push(...renderToolCallBlock(liveToolCall, 'executing', undefined, conversationWidth, undefined, undefined, undefined, streamMetrics.activeToolStartedAtMs));
      }
    }

    if (pendingPermission) {
      viewport.push(...PermissionPromptUI.createPromptLines(conversationWidth, pendingPermission, pendingPermission.hunkState, pendingPermission.detailsExpanded, pendingPermission.requestedBy, PermissionPromptUI.promptViewState(pendingPermission, conversationWidth, approvalBroker)));
    }

    viewport.push(...UIFactory.createQueuedMessageList(conversationWidth, orchestrator.listQueuedMessages()));
    viewport.push(...memoryProvenanceUi.renderChip(conversationWidth, configManager));

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
  const terminalOutputGuard = installFullScreenTerminalOutputGuard({ stdout, stderr: process.stderr, onCapture: (total) => { commandContext.session.runtime.terminalWritesIntercepted = total; render(); } });

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
    daemonCredentials: ctx.services.daemonCredentials, // a daemon-scoped credential is stored by the daemon, in one verified step
    daemonConfig: ctx.services.daemonConfig, // a daemon-owned setting is written where the daemon reads it
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
    surface: ctx.services.surface,
    gitStatusProvider,
    lastGitInfoRef,
    buildSessionContinuityHints,
    render, webhookNotifier: ctx.services.webhookNotifier, focusTracker: ctx.services.focusTracker, terminalNotifier, runtimeBus: uiServices.runtime.runtimeBus,
  });
  unsubs.push(...turnUnsubs);

  unsubs.push(uiServices.events.turns.on('TURN_COMPLETED', (evt) => memoryProvenanceUi.onTurnCompleted(evt)));

  // Stable turn context for failover retry — set in submitInput, read by retryTurn.
  let retryCtx: { count: number; text: string; content?: ContentPart[]; opts?: Parameters<typeof orchestrator.handleUserInput>[2] } | null = null;
  // One-key retry affordance, active right after a user-visible TURN_ERROR: 'r' re-submits on the
  // current provider, 'm' opens the model picker, any other character clears it and routes normally.
  // Surfaced as a transient FOOTER hint (see retryAffordanceHint below), not a transcript message.
  // Time-bounded: onExpire repaints once the 60s disarm timer fires, so a stray keypress hours
  // later can never trigger a real retry — see retry-affordance.ts.
  const retryAffordance = createRetryAffordanceState({ onExpire: render });
  const retryTurn = (notice?: string): boolean => {
    if (!retryCtx) return false; // nothing to roll back to; the caller narrates instead
    const { count, text, content: rContent, opts: rOpts } = retryCtx;
    // Roll back to pre-submission count, then re-submit. SDK gap — no retry-in-place (see handoff).
    // The rollback erases the failed turn's transcript — the failover notice included, which is how
    // that notice used to vanish before anyone could read it. The caller hands it over instead, and
    // it is posted here: after the rollback, above the prompt it explains.
    conversation.removeMessagesAfter(count);
    if (notice) systemMessageRouter.userReceipt(notice);
    void refreshMemoryRecallSnapshot(ctx.services).then(() => orchestrator.handleUserInput(text, rContent, rOpts)).catch((e: unknown) => logger.debug('retryTurn', { error: summarizeError(e) }));
    return true;
  };
  const streamResult: WireStreamEventMetricsResult = wireStreamEventMetrics({
    events: uiServices.events, orchestrator, providerRegistry,
    systemMessageRouter, render, metrics: streamMetrics,
    providerOptimizer: ctx.services.providerOptimizer, costLookup: providerRegistry, retryTurn,
    failoverState, getConfiguredRegistryKey: () => configManager.get('provider.model') as string | undefined,
    // The REQUESTED level, through the one helper every remap site reads from.
    getConfiguredReasoningEffort: () => requestedEffortLevel(configManager),
    isApprovalPending: () => pendingPermission !== null,
  });
  unsubs.push(...streamResult.unsubs);
  // Activate one-key retry affordance when a user-visible error surfaces.
  wireRetryAffordanceOnError(streamResult.onErrorSurfaced, retryAffordance, () => retryCtx !== null, render);

  // Register terminal-restoring crash/termination handlers BEFORE entering raw mode so a throw
  // during setup or the initial render still restores the terminal; 'exit' is the final safety net.
  process.on('uncaughtException', uncaughtExceptionHandler);
  process.on('SIGTERM', terminationSignalHandler);
  process.on('SIGHUP', terminationSignalHandler);
  process.on('exit', exitListener);

  // --- Terminal setup ---
  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
  allowTerminalWrite(() => stdout.write((cli.flags.noAltScreen ? '' : ALT_SCREEN_ENTER) + CLEAR_SCREEN + CURSOR_HIDE + MOUSE_ENABLE + KEYBOARD_EXT_ENABLE + PASTE_ENABLE + FOCUS_ENABLE));
  // forced dark/light applies before first paint; auto (TTY only) fires the
  // OSC 11 probe and repaints once if light wins. filterInput strips the reply from stdin.
  const themeProbe = installBackgroundThemeProbe({ configManager, isTTY: Boolean(stdout.isTTY), env: process.env, writeQuery: (b) => allowTerminalWrite(() => stdout.write(b)), requestRepaint: () => { compositor.resetDiff(); render(); } });

  // continueRecovery lets --continue/bare --resume check the target session for a live crash snapshot newer than its store before resuming (see tui-startup.ts).
  applyInitialTuiCliState({ cli, input, commandRegistry, commandContext, shellPaths: ctx.services.shellPaths, surface: ctx.services.surface, render, continueRecovery: { sessionManager: ctx.services.sessionManager, runtime, conversation, writeLastSessionPointer, receipt: (line) => systemMessageRouter.userReceipt(line) } });

  stdin.on('data', (raw: string) => {
    const data = themeProbe.filterInput(raw); if (data.length === 0) return;
    const blocking = handleBlockingShellInput({
      data, pendingPermission, render,
      abortTurn: () => orchestrator.abort(),
    });
    pendingPermission = blocking.pendingPermission;
    if (blocking.handled) {
      return;
    }
    // One-key retry affordance: armed after a user-visible TURN_ERROR; any key other than r/m dismisses it and routes normally.
    if (retryAffordance.armed) {
      disarmRetryAffordance(retryAffordance);
      if (handleErrorAffordanceKey(data, { retryArmed: retryCtx !== null, retry: retryTurn, openModelPicker: () => commandContext.openModelPicker?.(), render })) return;
      render(); // disarm must repaint immediately so the footer hint clears even when the key fell through
    }
    // One-key jump to a spawned CI fix-session: 'j' attaches, any other key dismisses and routes normally.
    if (fixSessionAttachArmed !== null) {
      const armedFixSessionId = fixSessionAttachArmed;
      fixSessionAttachArmed = null;
      if (handleFixSessionAttachKey(data, { armedFixSessionId, attach: attachToFixSession, render })) return;
    }

    input.feed(data);
  });
  process.on('SIGINT', sigintHandler); process.on('unhandledRejection', unhandledRejectionHandler); stdout.on('resize', resizeHandler);

  // State restores happen ONLY when the user explicitly asks — a CLI flag
  // (--continue/--resume/--fork), a slash command (/session resume,
  // /checkpoints, /rewind), or the startup recovery offer's modal. There is
  // deliberately no unconditional auto-restore here: a bare launch never
  // loads a saved conversation on its own (owner ruling).

  // Initial render
  conversation.rebuildHistory();
  render();

  // Crash-recovery snapshot: asked, never assumed. Scheduled after the first
  // frame so the question is drawn rather than posed at a blank terminal.
  scheduleRecoveryOffer(buildRecoveryOfferWiring({
    surface: ctx.services.surface, sessionManager: ctx.services.sessionManager, runtime, conversation, commandContext,
    writeLastSessionPointer, receipt: (line) => systemMessageRouter.userReceipt(line), render,
  }));

  // Auto-save to recovery file every 60s + multi-instance liveness-marker
  // refresh — see runtime/recovery-autosave.ts.
  recoveryInterval = startRecoveryAutosave({ conversation, runtime, surface: ctx.services.surface, buildSessionContinuityHints });
}

main().catch(reportFatalStartupError);
