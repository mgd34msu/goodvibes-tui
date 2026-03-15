#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Compositor } from './renderer/compositor.ts';
import { UIFactory } from './renderer/ui-factory.ts';
import { EventBus } from './core/event-bus.ts';
import { ConversationManager } from './core/conversation.ts';
import { Orchestrator } from './core/orchestrator.ts';
import { InputHandler } from './input/handler.ts';
import { SelectionManager } from './input/selection.ts';
import { config, configManager } from './config/index.ts';
import { providerRegistry } from './providers/registry.ts';
import { ToolRegistry } from './tools/registry.ts';
import { FileReadTool } from './tools/file-read.ts';
import { FileWriteTool } from './tools/file-write.ts';
import { FileEditTool } from './tools/file-edit.ts';
import { ShellExecTool } from './tools/shell-exec.ts';
import { GrepTool } from './tools/grep.ts';
import { ListDirTool } from './tools/list-dir.ts';
import { GlobTool } from './tools/glob-tool.ts';
import { PermissionManager } from './permissions/manager.ts';
import { AcpManager } from './acp/manager.ts';
import { PermissionPromptUI } from './permissions/prompt.ts';
import type { PermissionRequest } from './permissions/prompt.ts';
import { CommandRegistry } from './input/command-registry.ts';
import { renderFilePickerOverlay } from './renderer/file-picker-overlay.ts';
import { renderModelPickerOverlay } from './renderer/model-picker-overlay.ts';
import { renderSearchOverlay } from './renderer/search-overlay.ts';
import { registerBuiltinCommands } from './input/commands.ts';
import { InputHistory } from './input/input-history.ts';
import { loadSystemPrompt as _loadSystemPrompt } from './utils/prompt-loader.ts';

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

  const exitApp = () => {
    // Save conversation on exit
    saveConversation(conversation.toJSON());
    stdout.write(PASTE_DISABLE + KEYBOARD_EXT_DISABLE + MOUSE_DISABLE + CURSOR_SHOW + ALT_SCREEN_EXIT);
    stdin.setRawMode(false);
    process.exit(0);
  };

  // --- Tool registry ---
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new FileReadTool());
  toolRegistry.register(new FileWriteTool());
  toolRegistry.register(new FileEditTool());
  toolRegistry.register(new ShellExecTool());
  toolRegistry.register(new GrepTool());
  toolRegistry.register(new ListDirTool());
  toolRegistry.register(new GlobTool());

  const permissionManager = new PermissionManager(bus);

  const orchestrator = new Orchestrator(
    bus,
    conversation,
    getViewportHeight,
    scrollToEnd,
    toolRegistry,
    permissionManager,
    () => runtime.systemPrompt,
  );

  const acpManager = new AcpManager(bus);
  orchestrator.registerDelegateTool(acpManager);

  const input = new InputHandler(
    bus,
    selection,
    () => scrollTop,
    getViewportHeight,
    () => conversation.history,
    scroll,
    exitApp,
  );

  // --- Command registry ---
  const commandRegistry = new CommandRegistry();
  registerBuiltinCommands(commandRegistry);

  const commandContext = {
    eventBus: bus,
    providerRegistry,
    conversationManager: conversation,
    config,
    configManager,
    runtime,
    renderRequest: () => bus.emit('render:request'),
    print: (text: string) => {
      conversation.log(text, { fg: '135' });
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

  // --- Model picker wiring ---
  commandContext.openModelPicker = () => {
    const models = providerRegistry.getSelectableModels();
    input.modelPicker.open(models, runtime.model);
    bus.emit('render:request');
  };

  commandContext.openProviderPicker = () => {
    const providers = ['openai', 'anthropic', 'gemini', 'inceptionlabs'];
    input.modelPicker.openProviders(providers, runtime.provider);
    bus.emit('render:request');
  };

  // When model+effort selection is complete via the picker, apply both
  bus.on('model-picker:complete', (data) => {
    const def = data.model;
    const effort = data.effort;
    try {
      providerRegistry.setCurrentModel(def.id);
      runtime.model = def.id;
      runtime.provider = def.provider;
      runtime.reasoningEffort = effort;
      configManager.set('provider.model', def.id);
      configManager.set('provider.provider', def.provider);
      configManager.set('provider.reasoningEffort', effort);
      conversation.log(`Switched to model: ${def.displayName} (${def.provider}), effort: ${effort}`, { fg: '135' });
      bus.emit('command:model-changed', { provider: def.provider, model: def.id });
    } catch (e) {
      conversation.log(`Error switching model: ${(e as Error).message}`, { fg: '#ef4444' });
    }
    bus.emit('render:request');
  });

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
    const vHeight = getViewportHeight();

    // Flush any pending message renders before taking snapshot
    conversation.getDisplayBlocks();

    // Calculate how many rows are consumed by overlays (thinking, permissions, queue, file picker)
    let overlayRows = 0;
    if (orchestrator.isThinking) overlayRows += 2; // spinner + blank
    if (pendingPermission) overlayRows += 8; // permission prompt
    overlayRows += orchestrator.messageQueue.length * 3; // queued messages
    if (input.filePicker.active) {
      overlayRows += Math.min(input.filePicker.results.length, 12) + 4; // results + borders/search
    }
    if (input.modelPicker.active) {
      overlayRows += input.modelPicker.getItemCount() + 7; // items + title/empty/divider/detail/bottom
    }
    if (input.searchManager.active) {
      overlayRows += 1; // search bar
    }

    // Shrink viewport to make room for overlays
    const effectiveVHeight = vHeight - overlayRows;

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
      viewport.push(...UIFactory.createQueuedMessageFragment(width, msg));
    });

    if (input.filePicker.active) {
      viewport.push(...renderFilePickerOverlay(input.filePicker, width));
    }

    if (input.modelPicker.active) {
      viewport.push(...renderModelPickerOverlay(input.modelPicker, width));
    }

    if (input.searchManager.active) {
      viewport.push(...renderSearchOverlay(input.searchManager, width));
    }

    compositor.composite({
      width, height,
      header: UIFactory.createHeader(width, runtime.model, runtime.provider, conversation.title || undefined),
      viewport,
      footer: (() => {
        const cw = getPromptContentWidth();
        const info = input.getWrappedPromptInfo(cw);
        return UIFactory.createFooter(
          width,
          info.visibleLines.join('\n'),
          orchestrator.usage,
          input.showExitNotice,
          input.lastCopyTime,
          runtime.model, toolCount,
          info.visibleCursorLine >= 0
            ? info.visibleLines.slice(0, info.visibleCursorLine).reduce((s, l) => s + l.length + 1, 0) + info.visibleCursorCol
            : undefined,
          config.workingDir,
          runtime.provider,
          providerRegistry.getCurrentModel().contextWindow,
          configManager.get('behavior.autoCompactThreshold') as number
        );
      })(),
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
  bus.on('turn:stream-start', () => {
    streamStartTime = Date.now();
    streamDeltaCount = 0;
    streamTokenSpeed = 0;
    partialToolPreview = undefined;
  });
  bus.on('turn:stream-delta', (data) => {
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
  });
  bus.on('turn:stream-end', () => {
    partialToolPreview = undefined;
  });

  // --- Event wiring ---
  bus.on('render:request', render);
  bus.on('input:submit', ({ text, content }) => {
    scrollLocked = true; // Re-lock on any user input
    orchestrator.handleUserInput(text, content);
  });

  // Cancel generation when requested by input handler
  bus.on('cancel:generation', () => {
    if (orchestrator.isThinking) {
      orchestrator.abort();
    }
  });

  // Permission prompt wiring — store the pending request and trigger a render.
  // The orchestrator's Promise is blocked until resolve() is called.
  bus.on('permission:request', (req) => {
    pendingPermission = req;
    bus.emit('render:request');
  });

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
}

main().catch(console.error);
