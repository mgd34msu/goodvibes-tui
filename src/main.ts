#!/usr/bin/env bun
import { homedir } from 'node:os';
import { Compositor } from './renderer/compositor.ts';
import { type Line } from './types/grid.ts';
import { UIFactory } from './renderer/ui-factory.ts';
import { Orchestrator } from './core/orchestrator';
import { InputHandler } from './input/handler.ts';
import { SelectionManager } from './input/selection.ts';
import type { ContentPart } from '@pellux/goodvibes-sdk/platform/providers/interface';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools/registry';
import { registerAllTools } from '@pellux/goodvibes-sdk/platform/tools/index';
import { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state/file-undo';
import { PermissionManager } from '@pellux/goodvibes-sdk/platform/permissions/manager';
import { AcpManager } from '@pellux/goodvibes-sdk/platform/acp/manager';
import { PermissionPromptUI } from './permissions/prompt.ts';
import { CommandRegistry } from './input/command-registry.ts';
import type { CommandContext } from './input/command-registry.ts';
import { renderProcessIndicator } from './renderer/process-indicator.ts';
import { WrfcController } from '@pellux/goodvibes-sdk/platform/agents/wrfc-controller';
import { registerBuiltinCommands } from './input/commands.ts';
import { ScheduleManager } from '@pellux/goodvibes-sdk/platform/tools/workflow/index';
import { InputHistory } from './input/input-history.ts';
import { getTierPromptSupplement, getTierForContextWindow } from '@pellux/goodvibes-sdk/platform/providers/tier-prompts';
import { GitStatusProvider } from './renderer/git-status.ts';
import type { GitHeaderInfo } from './renderer/git-status.ts';
import { createShellLayout } from './renderer/layout-engine.ts';
import { buildShellFooter, estimateShellFooterHeight } from './renderer/shell-surface.ts';
import {
  buildConversationViewport,
} from './renderer/conversation-layout.ts';
import { applyConversationOverlays } from './renderer/conversation-overlays.ts';
import { buildPanelCompositeData } from './renderer/panel-composite.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { registerBuiltinPanels } from './panels/builtin-panels.ts';
import { renderPanelTabBar } from './renderer/panel-tab-bar.ts';
import { bootstrapRuntime } from './runtime/bootstrap.ts';
import type { BootstrapContext } from './runtime/bootstrap.ts';
import type { HITLMode } from '@pellux/goodvibes-sdk/platform/state/mode-manager';
import type { HookPhase, HookCategory, HookEventPath } from '@pellux/goodvibes-sdk/platform/hooks/types';
import {
  checkRecoveryFile,
  deleteRecoveryFile,
  loadRecoveryConversation,
  persistConversation,
  writeRecoveryFile,
} from '@pellux/goodvibes-sdk/platform/runtime/session-persistence';
import { handleBlockingShellInput, type PendingPermissionState } from './shell/blocking-input.ts';
import { wireShellUiOpeners } from './shell/ui-openers.ts';
import { deriveComposerState } from './core/composer-state.ts';
import { buildPersistedSessionContext, formatReturnContextForDisplay, getReturnContextMode, maybeAssistReturnContextSummary } from '@pellux/goodvibes-sdk/platform/runtime/session-return-context';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';
import { prepareShellCliRuntime } from './cli/entrypoint.ts';
import { applyInitialTuiCliState } from './cli/tui-startup.ts';
import { wireSpokenTurnRuntime } from './audio/spoken-turn-wiring.ts';
import {
  attachSpokenTurnModelRouting,
  createSpokenTurnInputOptions,
} from './audio/spoken-turn-model-routing.ts';
import { allowTerminalWrite, installTuiTerminalOutputGuard } from './runtime/terminal-output-guard.ts';

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

  let streamStartTime = 0;
  let streamDeltaCount = 0;
  let streamTokenSpeed = 0;

  let scrollTop = 0;
  let scrollLocked = true;

  const getPromptContentWidth = () => {
    const w = stdout.columns || 80;
    const boxMargin = 2;
    const boxWidth = w - (boxMargin * 2);
    return boxWidth - 4 - 3; // minus padding (4) minus prefix width (3: ' > ')
  };

  const getViewportHeight = (): number => {
    if (input.onboardingWizard.active) return stdout.rows || 24;
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

  const unsubs: Array<() => void> = [];
  let recoveryInterval: ReturnType<typeof setInterval> | null = null;
  let stopSpokenOutputForExit: (() => void) | null = null;
  let recoveryPending = false;

  const sigintHandler = (): void => input.feed('\x03');
  let _unhandledRejectionCount = 0;
  let _unhandledRejectionWindowStart = Date.now();
  const unhandledRejectionHandler = (reason: unknown): void => {
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
  };
  const resizeHandler = (): void => {
    input.setContentWidth(getPromptContentWidth());
    compositor.resetDiff();
    render();
  };

  const exitApp = (): void => {
    stopSpokenOutputForExit?.();
    unsubs.forEach(fn => fn());
    const snapshot = conversation.toJSON() as { messages: Array<import('./core/conversation.ts').ConversationMessageSnapshot>; timestamp?: number };
    ctx.shutdown({ ...snapshot, ...buildPersistedSessionContext(snapshot.messages, conversation.getTitleSource(), buildSessionContinuityHints()) }).catch((err) => {
      logger.debug('ctx.shutdown error during exitApp (non-fatal)', { error: summarizeError(err) });
    });
    if (recoveryInterval !== null) { clearInterval(recoveryInterval); recoveryInterval = null; }
    deleteRecoveryFile({ homeDirectory });
    stdin.removeAllListeners('data');
    stdout.removeListener('resize', resizeHandler);
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('unhandledRejection', unhandledRejectionHandler);
    const exitScreen = cli.flags.noAltScreen ? CLEAR_SCREEN : CLEAR_SCREEN + ALT_SCREEN_EXIT;
    allowTerminalWrite(() => stdout.write(PASTE_DISABLE + KEYBOARD_EXT_DISABLE + MOUSE_DISABLE + CURSOR_SHOW + exitScreen));
    terminalOutputGuard.dispose();
    stdin.setRawMode(false);
    process.exit(0);
  };

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
        const memId = ctx.services.sessionMemoryStore.add(memoryText);
        systemMessageRouter.high(`[Memory] Pinned: "${memoryText}" (${memId})`);
        processedText = memoryText;
      }
    }
    if (processedText || content) {
      if (options.spokenOutput && processedText) {
        spokenTurns.submitNextTurn(processedText);
      }
      const inputOptions = options.spokenOutput ? createSpokenTurnInputOptions() : undefined;
      orchestrator.handleUserInput(processedText, content, inputOptions).catch((err: unknown) => {
        logger.debug('handleUserInput safety catch (already handled by runTurn)', { error: summarizeError(err) });
      });
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

  // ── InputHandler — created here so getViewportHeight can reference it ──────
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
    workingDir,
    model: runtime.model,
    provider: runtime.provider,
    toolCount,
  };


  // --- Render function ---
  const render = () => {
    const width = stdout.columns || 80;
    const height = stdout.rows || 24;

    // Cache the current model for consistent values across the entire render frame
    const currentModel = providerRegistry.getCurrentModel();
    const sessionSnapshot = uiServices.readModels.session.getSnapshot();
    const agentSnapshot = uiServices.readModels.agents.getSnapshot();

    // Build header and footer FIRST so we know the exact viewport height
    const headerLines = UIFactory.createHeader(width, currentModel.id, currentModel.provider, conversation.title || undefined, lastGitInfoRef.value);
    const managerAgents = agentManager.list().filter(
      (a) => a.status === 'running' || a.status === 'pending',
    );
    const runtimeAgents = agentSnapshot.active;
    const runningAgentIds = new Set<string>();
    let runningAgentProgress: string | undefined;
    for (const agent of managerAgents) {
      runningAgentIds.add(agent.id);
      if (!runningAgentProgress && agent.progress) runningAgentProgress = agent.progress;
    }
    for (const agent of runtimeAgents) {
      runningAgentIds.add(agent.id);
      if (!runningAgentProgress && agent.latestProgress) runningAgentProgress = agent.latestProgress;
    }
    const runningAgentCount = runningAgentIds.size;
    const runningProcessCount = processManager.list().filter((p) => !p.status.startsWith('done')).length;
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
    const composerState = deriveComposerState({
      text: input.prompt,
      commandMode: input.commandMode,
      panelFocused: input.panelFocused,
      pendingApproval: pendingPermission !== null,
      hasAttachments: input.getImageAttachments().size > 0,
      turnState: sessionSnapshot.turnState,
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
      hitlMode: modeManager.getHITLMode(),
      runningAgentCount,
      runningProcessCount,
      indicatorFocused: input.indicatorFocused,
      runningAgentProgress,
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
    let viewport = conversationViewport.viewport;

    if (orchestrator.isThinking) {
      const showSpeed = configManager.get('display.showTokenSpeed') as boolean;
      const showPreview = configManager.get('display.showToolPreview') as boolean;
      const partialToolPreview = showPreview ? sessionSnapshot.streamToolPreview : undefined;
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
      keybindingsManager: ctx.services.keybindingsManager,
      conversationWidth,
      viewportHeight: vHeight,
      contextWindow: currentModel.contextWindow,
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
    getConfiguredProviderIds: ctx._getConfiguredProviderIds,
    getPinned: ctx._getPinned,
    render,
  });

  // --- Streaming speed + tool preview wiring ---
  const refreshGit = () => gitStatusProvider.refresh().then((info) => { lastGitInfoRef.value = info; render(); }).catch(() => { /* non-fatal */ });
  // Refresh git status after each turn completes or after tool results arrive
  unsubs.push(uiServices.events.turns.on('TURN_COMPLETED', () => {
    // Auto-save after every LLM turn so kills don't lose the session
    try {
      const snapshot = conversation.toJSON() as { messages: Array<import('./core/conversation.ts').ConversationMessageSnapshot>; timestamp?: number };
      const persisted = buildPersistedSessionContext(snapshot.messages, conversation.getTitleSource(), buildSessionContinuityHints());
      persistConversation(
        runtime.sessionId,
        { ...snapshot, ...persisted },
        runtime.model,
        runtime.provider,
        conversation.title || '',
        { workingDirectory: workingDir, homeDirectory, sessionManager: ctx.services.sessionManager },
      );
      hookDispatcher.fire({ path: 'Lifecycle:session:save' as HookEventPath, phase: 'Lifecycle' as HookPhase, category: 'session' as HookCategory, specific: 'save', sessionId: runtime.sessionId, timestamp: Date.now(), payload: { sessionId: runtime.sessionId } }).catch((err: unknown) => logger.debug('hook fire error', { error: summarizeError(err) }));
    } catch (e) { logger.debug('auto-save on turn:complete failed', { error: summarizeError(e) }); }
    refreshGit();
  }));
  unsubs.push(uiServices.events.tools.on('TOOL_SUCCEEDED', () => {
    refreshGit();
  }));
  unsubs.push(uiServices.events.tools.on('TOOL_FAILED', () => {
    refreshGit();
  }));

  unsubs.push(uiServices.events.turns.on('STREAM_START', () => {
    streamStartTime = Date.now();
    streamDeltaCount = 0;
    streamTokenSpeed = 0;
  }));
  unsubs.push(uiServices.events.turns.on('STREAM_DELTA', () => {
    streamDeltaCount++;
    const elapsed = (Date.now() - streamStartTime) / 1000;
    // Note: counts stream deltas, not actual tokens. ~1 delta per token for most providers.
    streamTokenSpeed = elapsed > 0 ? streamDeltaCount / elapsed : 0;
  }));

  // --- Terminal setup ---
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  allowTerminalWrite(() => stdout.write((cli.flags.noAltScreen ? '' : ALT_SCREEN_ENTER) + CLEAR_SCREEN + CURSOR_HIDE + MOUSE_ENABLE + KEYBOARD_EXT_ENABLE + PASTE_ENABLE));

  applyInitialTuiCliState({
    cli,
    input,
    commandRegistry,
    commandContext,
    shellPaths: ctx.services.shellPaths,
    render,
  });

  stdin.on('data', (data: string) => {
    const blocking = handleBlockingShellInput({
      data,
      pendingPermission,
      recoveryPending,
      abortTurn: () => orchestrator.abort(),
      conversation,
      systemMessageRouter,
      render,
      loadRecoveryConversation: () => loadRecoveryConversation({ homeDirectory }),
      deleteRecoveryFile: () => deleteRecoveryFile({ homeDirectory }),
    });
    pendingPermission = blocking.pendingPermission;
    recoveryPending = blocking.recoveryPending;
    if (blocking.handled) {
      return;
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
    systemMessageRouter.high(`[Recovery] Found unsaved session from ${new Date(recoveryInfo.timestamp).toLocaleString()}. Title: "${recoveryInfo.title}". Press R to restore, any other key to discard.`);
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
