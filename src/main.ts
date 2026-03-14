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
import { config } from './config.ts';
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
import { registerBuiltinCommands } from './input/commands.ts';

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
  const compositor = new Compositor(stdout);
  const selection = new SelectionManager();

  // Permission state — set while a permission prompt is blocking the orchestrator
  let pendingPermission: PermissionRequest | null = null;

  let scrollTop = 0;
  /** When true, view auto-scrolls to bottom on every render.
   *  False when user manually scrolls up. Reset on user input. */
  let scrollLocked = true;

  // --- Runtime state (mutable, can be changed by slash commands) ---
  const runtime = {
    model: config.model,
    provider: config.provider,
    debugMode: false,
    systemPrompt: config.systemPrompt ?? '',
  };

  const getViewportHeight = () => {
    const promptLines = input.prompt.split('\n').length;
    return (stdout.rows || 24) - 2 - (7 + promptLines);
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
    runtime,
    renderRequest: () => bus.emit('render:request'),
    print: (text: string) => {
      conversation.log(text, { fg: '135' });
      bus.emit('render:request');
    },
    exit: exitApp,
  };

  input.setCommandRegistry(commandRegistry, commandContext);

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

    // Calculate how many rows are consumed by overlays (thinking, permissions, queue)
    let overlayRows = 0;
    if (orchestrator.isThinking) overlayRows += 2; // spinner + blank
    if (pendingPermission) overlayRows += 8; // permission prompt
    overlayRows += orchestrator.messageQueue.length * 3; // queued messages

    // Shrink viewport to make room for overlays
    const effectiveVHeight = vHeight - overlayRows;

    // Auto-scroll to bottom when orchestrator is active or user was near bottom
    const maxScroll = Math.max(0, conversation.history.getLineCount() - effectiveVHeight);
    if (scrollLocked) {
      scrollTop = maxScroll;
    }

    const viewport = conversation.history.getSnapshot(scrollTop, effectiveVHeight, width);

    if (orchestrator.isThinking) {
      const thinking = UIFactory.createThinkingFragment(width, orchestrator.getSpinner());
      viewport.push(...thinking);
    }

    if (pendingPermission) {
      viewport.push(...PermissionPromptUI.createPromptLines(width, pendingPermission));
    }

    orchestrator.messageQueue.forEach(msg => {
      viewport.push(...UIFactory.createQueuedMessageFragment(width, msg));
    });

    compositor.composite({
      width, height,
      header: UIFactory.createHeader(width, runtime.model, runtime.provider),
      viewport,
      footer: UIFactory.createFooter(width, input.prompt, orchestrator.usage, input.showExitNotice, input.lastCopyTime, undefined, undefined, input.cursorPos),
      selection: {
        isCellSelected: (col, row) => selection.isCellSelected(col, row),
        scrollTop,
        lineCount: conversation.history.getLineCount(),
      },
    });
  };

  // --- Event wiring ---
  bus.on('render:request', render);
  bus.on('input:submit', ({ text }) => {
    scrollLocked = true; // Re-lock on any user input
    orchestrator.handleUserInput(text);
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
    compositor.resetDiff();
    render();
  });

  // Initial render
  conversation.rebuildHistory();
  render();
}

main().catch(console.error);
