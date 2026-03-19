#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Compositor } from './renderer/compositor.ts';
import { createEmptyLine } from './types/grid.ts';
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
import { agentOrchestrator } from './agents/orchestrator.ts';
import { PermissionManager } from './permissions/manager.ts';
import { AcpManager } from './acp/manager.ts';
import { HookDispatcher } from './hooks/dispatcher.ts';
import { PermissionPromptUI } from './permissions/prompt.ts';
import type { PermissionRequest } from './permissions/prompt.ts';
import { CommandRegistry } from './input/command-registry.ts';
import type { CommandContext } from './input/command-registry.ts';
import { renderFilePickerOverlay } from './renderer/file-picker-overlay.ts';
import { renderModelPickerOverlay } from './renderer/model-picker-overlay.ts';
import { renderSearchOverlay } from './renderer/search-overlay.ts';
import { renderProcessIndicator } from './renderer/process-indicator.ts';
import { AgentManager } from './tools/agent/index.ts';
import { WrfcController } from './agents/wrfc-controller.ts';
import { ProcessManager } from './tools/shared/process-manager.ts';
import { renderSelectionModalOverlay } from './renderer/selection-modal-overlay.ts';
import { registerBuiltinCommands } from './input/commands.ts';
import { ScheduleManager } from './tools/workflow/index.ts';
import { InputHistory } from './input/input-history.ts';
import { loadSystemPrompt as _loadSystemPrompt } from './utils/prompt-loader.ts';
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
import { scan, loadPersistedProviders, persistProviders, removePersistedProviders } from './discovery/index.ts';

function loadSystemPrompt(): string {
  return _loadSystemPrompt(
    () => configManager.get('provider.systemPromptFile') as string | undefined,
  );
}

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

/** Conversation persistence directory. */
const CONV_DIR = join(process.cwd(), '.goodvibes', 'conversations');
const LAST_CONV_FILE = join(CONV_DIR, 'last.json');

function saveConversation(data: object): void {
  try {
    mkdirSync(CONV_DIR, { recursive: true });
    writeFileSync(LAST_CONV_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch { /* non-fatal */ }
}

function loadLastConversation(): { messages: never[] } | null {
  try {
    if (existsSync(LAST_CONV_FILE)) {
      return JSON.parse(readFileSync(LAST_CONV_FILE, 'utf-8')) as { messages: never[] };
    }
  } catch { /* non-fatal */ }
  return null;
}

async function main() {
  const stdout = process.stdout;
  const stdin = process.stdin;

  // --- Module wiring ---
  const bus = new EventBus();
  const conversation = new ConversationManager(() => stdout.columns || 80);
  conversation.setConfigManager(configManager);
  const compositor = new Compositor(stdout);
  const selection = new SelectionManager();

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

  // --- Git status provider ---
  const gitStatusProvider = new GitStatusProvider();
  let lastGitInfo: GitHeaderInfo | undefined = undefined;
  // Prime the cache on startup (non-blocking)
  gitStatusProvider.getStatus().then((info) => {
    lastGitInfo = info;
    bus.emit('render:request');
  }).catch(() => { /* non-fatal */ });

  // --- Runtime state (mutable, can be changed by slash commands) ---
  const runtime = {
    model: configManager.get('provider.model'),
    provider: configManager.get('provider.provider'),
    debugMode: false,
    systemPrompt: loadSystemPrompt() || config.systemPrompt || '',
    reasoningEffort: configManager.get('provider.reasoningEffort'),
  };

  /** Content width inside the prompt box (box width minus padding). */
  const getPromptContentWidth = () => {
    const w = stdout.columns || 80;
    const boxMargin = 2;
    const boxWidth = w - (boxMargin * 2);
    return boxWidth - 4 - 3; // minus padding (4) minus prefix width (3: ' > ')
  };

  /** Base footer row count: separator + prompt box (top+content+bottom) + blank +
   *  token line + ctx bar + compact bar + context line (blank+info+blank) + help/exit line + trailing blank.
   */
  const FOOTER_BASE_ROWS = 9;

  const getViewportHeight = () => {
    const promptLines = input.getVisiblePromptLineCount(getPromptContentWidth());
    // FOOTER_BASE_ROWS base footer rows + 2 progress bars (always shown when model has contextWindow) + prompt lines
    const currentModel = providerRegistry.getCurrentModel();
    const hasProgressBars = currentModel.contextWindow > 0 ? 2 : 0;
    return (stdout.rows || 24) - 2 - (FOOTER_BASE_ROWS + promptLines + hasProgressBars);
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

  // Populated after bus.on() calls below — used to clean up listeners on exit
  const unsubs: Array<() => void> = [];

  const exitApp = () => {
    unsubs.forEach(fn => fn());
    // Save conversation on exit
    saveConversation(conversation.toJSON());
    try { ScheduleManager.getInstance().destroy(); } catch { /* non-fatal */ }
    try { providerRegistry.stopWatching(); } catch { /* non-fatal */ }
    stdin.removeAllListeners('data');
    stdout.removeAllListeners('resize');
    stdout.write(PASTE_DISABLE + KEYBOARD_EXT_DISABLE + MOUSE_DISABLE + CURSOR_SHOW + ALT_SCREEN_EXIT);
    stdin.setRawMode(false);
    process.exit(0);
  };

  // --- Tool registry ---
  const toolRegistry = new ToolRegistry();
  const { fileCache, projectIndex } = registerAllTools(toolRegistry);
  agentOrchestrator.setDependencies(fileCache, projectIndex);
  // Initialize WrfcController with EventBus and wire to AgentOrchestrator
  agentOrchestrator.setEventBus(bus);
  WrfcController.getInstance(bus);

  // Notify the user when a WRFC cascade abort occurs (identical gate failures in consecutive chains)
  unsubs.push(bus.on('wrfc:cascade-abort', ({ chainId, reason }: { chainId: string; reason: string }) => {
    conversation.addSystemMessage(`[WRFC] Cascade abort: ${reason} (chain ${chainId})`);
    bus.emit('render:request');
  }));

  // WRFC chain lifecycle — bubble events to conversation
  unsubs.push(bus.on('wrfc:chain-created', ({ chainId, task }: { chainId: string; task: string }) => {
    conversation.addSystemMessage(`[WRFC] Chain ${chainId} started: ${task}`);
    bus.emit('render:request');
  }));

  unsubs.push(bus.on('wrfc:review-complete', ({ chainId, score, passed }: { chainId: string; score: number; passed: boolean }) => {
    const icon = passed ? '\u2713' : '\u2717';
    const threshold = configManager.get('wrfc.scoreThreshold') as number;
    const suffix = passed ? '' : ` - Minimum score is ${threshold}/10, spawning a fix agent ...`;
    conversation.addSystemMessage(`[WRFC] ${icon} Review ${chainId.slice(0, 12)}: ${score}/10${suffix}`);
    bus.emit('render:request');
  }));

  unsubs.push(bus.on('wrfc:chain-passed', ({ chainId }: { chainId: string }) => {
    conversation.addSystemMessage(`[WRFC] \u2713 Chain ${chainId.slice(0, 12)} PASSED — all gates clear`);
    bus.emit('render:request');
  }));

  unsubs.push(bus.on('wrfc:chain-failed', ({ chainId, reason }: { chainId: string; reason: string }) => {
    conversation.addSystemMessage(`[WRFC] \u2717 Chain ${chainId.slice(0, 12)} FAILED: ${reason.slice(0, 80)}`);
    bus.emit('render:request');
  }));

  unsubs.push(bus.on('wrfc:auto-commit', ({ chainId, commitHash }: { chainId: string; commitHash?: string }) => {
    const suffix = commitHash ? ` (${commitHash.slice(0, 7)})` : '';
    conversation.addSystemMessage(`[WRFC] Auto-committed chain ${chainId.slice(0, 12)}${suffix}`);
    bus.emit('render:request');
  }));

  unsubs.push(bus.on('wrfc:gate-result', ({ chainId, gate, passed }: { chainId: string; gate: string; passed: boolean }) => {
    const icon = passed ? '\u2713' : '\u2717';
    const color = passed ? '#22c55e' : '#ef4444';
    conversation.addSystemMessage(`[WRFC]   ${icon} Gate: ${gate} ${passed ? 'passed' : 'FAILED'}`);
    bus.emit('render:request');
  }));

  // Start watching for custom provider file changes so hot-reload works.
  providerRegistry.startWatching(bus);

  const permissionManager = new PermissionManager(bus);

  const hookDispatcher = new HookDispatcher();

  const input = new InputHandler(
    bus,
    selection,
    () => scrollTop,
    getViewportHeight,
    () => conversation.history,
    scroll,
    exitApp,
  );

  const orchestrator = new Orchestrator(
    bus,
    conversation,
    getViewportHeight,
    scrollToEnd,
    toolRegistry,
    permissionManager,
    () => runtime.systemPrompt,
    hookDispatcher,
  );

  const acpManager = new AcpManager(bus);
  orchestrator.registerDelegateTool(acpManager);

  // --- Command registry ---
  const commandRegistry = new CommandRegistry();
  registerBuiltinCommands(commandRegistry);

  const commandContext: CommandContext = {
    eventBus: bus,
    providerRegistry,
    conversationManager: conversation,
    config,
    configManager,
    runtime,
    renderRequest: () => bus.emit('render:request'),
    print: (text: string) => {
      conversation.log(text, { fg: '252' });
      bus.emit('render:request');
    },
    exit: exitApp,
    reloadSystemPrompt: loadSystemPrompt,
    toolRegistry,
  };

  input.setCommandRegistry(commandRegistry, commandContext);
  input.setConversationManager(conversation);
  input.setContentWidth(getPromptContentWidth());
  input.filePicker.setOnUpdate(() => bus.emit('render:request'));
  input.agentDetailModal.setOnRefresh(() => bus.emit('render:request'));
  input.processModal.setOnRefresh(() => bus.emit('render:request'));

  // --- Model picker wiring ---
  commandContext.openModelPicker = () => {
    const models = providerRegistry.getSelectableModels();
    input.modelPicker.open(models, runtime.model);
    bus.emit('render:request');
  };

  commandContext.openProviderPicker = () => {
    const providers = [...new Set(providerRegistry.listModels().map(m => m.provider))];
    input.modelPicker.openProviders(providers, runtime.provider);
    bus.emit('render:request');
  };

  commandContext.openSelection = (title, items, opts, callback) => {
    input.openSelection(title, items, opts, callback);
  };

  commandContext.openContextInspector = () => {
    input.contextInspectorModal.open();
    bus.emit('render:request');
  };

  commandContext.openBookmarkModal = () => {
    input.bookmarkModal.open();
    bus.emit('render:request');
  };

  commandContext.openHelpOverlay = () => {
    input.helpOverlayActive = !input.helpOverlayActive;
    input.helpScrollOffset = 0;
  };
  (commandContext as unknown as Record<string, unknown>).openShortcutsOverlay = () => {
    input.shortcutsOverlayActive = !input.shortcutsOverlayActive;
    input.shortcutsScrollOffset = 0;
    bus.emit('render:request');
  };

  commandContext.openProfilePicker = () => {
    input.profilePickerModal.open();
    bus.emit('render:request');
  };

  commandContext.openSettingsModal = () => {
    input.settingsModal.open(configManager);
    bus.emit('render:request');
  };

  commandContext.openSessionPicker = () => {
    input.sessionPickerModal.open();
    bus.emit('render:request');
  };

  commandContext.openProfilePicker = () => {
    input.profilePickerModal.open();
    bus.emit('render:request');
  };

  // When model+effort selection is complete via the picker, apply both
  unsubs.push(bus.on('model-picker:complete', (data) => {
    if (!data?.model) return;
    const def = data.model;
    const effort = data.effort;
    try {
      providerRegistry.setCurrentModel(def.id);
      runtime.model = def.id;
      runtime.provider = def.provider;
      runtime.reasoningEffort = effort as 'instant' | 'low' | 'medium' | 'high';
      configManager.set('provider.model', def.id);
      configManager.set('provider.provider', def.provider);
      configManager.set('provider.reasoningEffort', effort as 'instant' | 'low' | 'medium' | 'high');
      conversation.log(`Switched to model: ${def.displayName} (${def.provider}), effort: ${effort}`, { fg: '135' });
      bus.emit('command:model-changed', { provider: def.provider, model: def.id });
    } catch (e) {
      conversation.log(`Error switching model: ${(e as Error).message}`, { fg: '#ef4444' });
    }
    // Full screen redraw to ensure all UI elements (including context bar) reflect the new model
    compositor.resetDiff();
    bus.emit('render:request');
  }));

  // --- Input history ---
  const saveHistory = configManager.get('behavior.saveHistory');
  const inputHistory = new InputHistory(undefined, saveHistory);
  input.setHistory(inputHistory);

  // --- Splash options ---
  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir: config.workingDir,
    model: runtime.model,
    provider: runtime.provider,
    toolCount,
  };

  // --- Resume flag ---
  const shouldResume = process.argv.includes('--resume');
  if (shouldResume) {
    const saved = loadLastConversation();
    if (saved) conversation.fromJSON(saved);
  }

  // --- Render function ---
  const render = () => {
    const width = stdout.columns || 80;
    const height = stdout.rows || 24;
    // Flush any pending message renders before taking snapshot
    conversation.getDisplayBlocks();

    // Cache the current model for consistent values across the entire render frame
    const currentModel = providerRegistry.getCurrentModel();


    // Build header and footer FIRST so we know the exact viewport height
    const headerLines = UIFactory.createHeader(width, currentModel.id, currentModel.provider, conversation.title || undefined, lastGitInfo);
    const runningAgentCount = AgentManager.getInstance().list().filter((a) => a.status === 'running' || a.status === 'pending').length;
    const runningProcessCount = ProcessManager.getInstance().list().filter((p) => !p.status.startsWith('done')).length;
    const processIndicatorLines = renderProcessIndicator(width, runningAgentCount, runningProcessCount, input.indicatorFocused);
    const cw = getPromptContentWidth();
    const promptInfo = input.getWrappedPromptInfo(cw);
    const footerContentLines = UIFactory.createFooter(
      width,
      promptInfo.visibleLines.join('\n'),
      orchestrator.usage as unknown as { up: number; down: number; max?: number },
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
      orchestrator.lastInputTokens
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
      const mpLines = renderModelPickerOverlay(input.modelPicker, width);
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
      viewport.push(...renderSettingsModal(input.settingsModal, width));
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
    });
  };

  // --- Streaming speed + tool preview wiring ---
  // Refresh git status after each turn completes or after tool results arrive
  unsubs.push(bus.on('turn:complete', () => {
    gitStatusProvider.refresh().then((info) => {
      lastGitInfo = info;
      bus.emit('render:request');
    }).catch(() => { /* non-fatal */ });
  }));
  unsubs.push(bus.on('turn:tool-result', () => {
    gitStatusProvider.refresh().then((info) => {
      lastGitInfo = info;
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
    scrollLocked = true; // Re-lock on any user input
    orchestrator.handleUserInput(text, content);
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

    input.feed(data);
  });
  process.on('SIGINT', () => input.feed('\x03'));
  stdout.on('resize', () => {
    input.setContentWidth(getPromptContentWidth());
    compositor.resetDiff();
    render();
  });

  // Initial render
  conversation.rebuildHistory();
  render();

  // --- Load persisted local LLM providers (instant, before background scan) ---
  const persisted = loadPersistedProviders();
  if (persisted.length > 0) {
    try {
      providerRegistry.registerDiscoveredProviders(persisted);
      for (const server of persisted) {
        conversation.addSystemMessage(
          `[Local] ${server.name} at ${server.host}:${server.port} (${server.models.length} model${server.models.length !== 1 ? 's' : ''}) — from last session`
        );
      }
      bus.emit('render:request');
    } catch {
      // Non-fatal
    }
  }

  // --- Background scan to verify persisted + discover new ---
  scan().then((result) => {
    const currentModel = configManager.get('provider.model') as string;

    // Build sets for reconciliation
    const foundKeys = new Set(result.servers.map(s => `${s.host}:${s.port}`));
    const persistedKeys = new Set(persisted.map(s => `${s.host}:${s.port}`));

    // Newly discovered servers (not previously persisted)
    const newServers = result.servers.filter(s => !persistedKeys.has(`${s.host}:${s.port}`));

    // Previously persisted but now unreachable
    const removedServers = persisted.filter(s => !foundKeys.has(`${s.host}:${s.port}`));

    // Register all found servers (re-registers persisted ones with fresh model lists)
    if (result.servers.length > 0) {
      try {
        providerRegistry.registerDiscoveredProviders(result.servers);
      } catch {
        // Non-fatal
      }
    }

    // Log newly discovered servers
    for (const server of newServers) {
      conversation.addSystemMessage(
        `[Scan] Found ${server.name} at ${server.host}:${server.port} (${server.models.length} model${server.models.length !== 1 ? 's' : ''})`
      );
    }

    // Handle removed servers
    if (removedServers.length > 0) {
      removePersistedProviders(removedServers);

      for (const server of removedServers) {
        conversation.addSystemMessage(
          `[Scan] ${server.name} at ${server.host}:${server.port} is no longer reachable — removed`
        );

        // Check if the active model was on this removed server
        const wasActive = server.models.includes(currentModel);
        if (wasActive) {
          configManager.set('provider.model', 'openrouter/free');
          configManager.set('provider.provider', 'openrouter');
          try {
            providerRegistry.setCurrentModel('openrouter/free');
            runtime.model = 'openrouter/free';
            runtime.provider = 'openrouter';
          } catch { /* non-fatal */ }
          conversation.addSystemMessage(
            `[Scan] Active model was on ${server.name} — switched to openrouter/free`
          );
        }
      }
    }

    // Persist current state: writes found servers (may be empty if all were removed)
    if (result.servers.length > 0 || removedServers.length > 0) {
      persistProviders(result.servers);
    }

    if (newServers.length > 0 || removedServers.length > 0) {
      bus.emit('render:request');
    }
  }).catch(() => {
    // Non-fatal: scan failure is expected when no local LLMs are running
  });
}

main().catch(console.error);
