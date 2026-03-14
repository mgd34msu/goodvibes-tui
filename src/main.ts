#!/usr/bin/env bun
import { Compositor } from './renderer/compositor.ts';
import { UIFactory } from './renderer/ui-factory.ts';
import { state } from './core/state.ts';
import { InputTokenizer } from './core/tokenizer.ts';
import { getSplashLines } from './utils/splash-lines.ts';
import { logger } from './utils/logger.ts';
import { copyToClipboard, pasteFromClipboard } from './utils/clipboard.ts';

const ALT_SCREEN_ENTER = '\x1b[?1049h';
const ALT_SCREEN_EXIT  = '\x1b[?1049l';
const MOUSE_ENABLE     = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_DISABLE    = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';
const CURSOR_HIDE      = '\x1b[?25l';
const CURSOR_SHOW      = '\x1b[?25h';
const CLEAR_SCREEN     = '\x1b[2J\x1b[3J\x1b[H';

const KEYBOARD_EXT_ENABLE = '\x1b[>4;2m' + '\x1b[?1u';
const KEYBOARD_EXT_DISABLE = '\x1b[>4;0m' + '\x1b[?1l';
const PASTE_ENABLE     = '\x1b[?2004h';
const PASTE_DISABLE    = '\x1b[?2004l';

async function main() {
  const stdout = process.stdout;
  const stdin = process.stdin;
  const compositor = new Compositor(stdout);
  const tokenizer = new InputTokenizer();

  let lastCtrlCTime = 0;

  // Initial State
  state.refreshHistory();

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdout.write(ALT_SCREEN_ENTER + CLEAR_SCREEN + CURSOR_HIDE + MOUSE_ENABLE + KEYBOARD_EXT_ENABLE + PASTE_ENABLE);

  const render = () => {
    const width = stdout.columns || 80;
    const height = stdout.rows || 24;
    
    let interactionRows = 0;
    const interactionFragments: any[][] = [];

    if (state.isThinking) {
      const thinking = UIFactory.createThinkingFragment(width, state.getSpinner());
      interactionFragments.push(thinking);
      interactionRows += thinking.length;
    }

    state.messageQueue.forEach(msg => {
      const frag = UIFactory.createQueuedMessageFragment(width, msg);
      interactionFragments.push(frag);
      interactionRows += frag.length;
    });

    const vHeight = state.getViewportHeight() - interactionRows;
    const viewport = state.history.getSnapshot(state.scrollTop, vHeight, width);
    interactionFragments.forEach(frag => viewport.push(...frag));

    compositor.composite({
      width, height,
      header: UIFactory.createHeader(width, state.model, state.provider),
      viewport,
      footer: UIFactory.createFooter(width, state.prompt, state.usage, state.showExitNotice, state.lastCopyTime)
    });
  };

  const exitApp = () => {
    stdout.write(PASTE_DISABLE + KEYBOARD_EXT_DISABLE + MOUSE_DISABLE + CURSOR_SHOW + ALT_SCREEN_EXIT);
    stdin.setRawMode(false);
    process.exit(0);
  };

  const handleCtrlC = () => {
    const now = Date.now();
    if (now - lastCtrlCTime < 1000) {
      exitApp();
    } else {
      lastCtrlCTime = now;
      state.showExitNotice = true;
      render();
      setTimeout(() => { state.showExitNotice = false; render(); }, 1000);
    }
  };

  const handleCopy = () => {
    if (state.hasSelection()) {
      copyToClipboard(state.getSelectedText());
      state.lastCopyTime = Date.now();
      render();
      setTimeout(render, 2005);
    }
  };

  stdin.on('data', (data: string) => {
    const tokens = tokenizer.feed(data);
    for (const token of tokens) {
      if (token.type === 'text') {
        // Audit Fix: Register incoming text as a potential paste marker
        state.prompt += state.registerPaste(token.value);
      } else if (token.type === 'key') {
        if (token.logicalName === 'c' && token.ctrl && token.shift) {
          handleCopy();
          continue;
        }
        if (token.logicalName === 'c' && token.ctrl && !token.shift) {
          handleCtrlC();
          continue;
        }
        if (token.logicalName === 'enter') {
          if (token.shift) {
            state.prompt += '\n';
          } else {
            const text = state.prompt.trim();
            if (text === ':q') { exitApp(); return; }
            if (text) {
              state.prompt = '';
              state.sendMessage(text, render);
            }
          }
          continue;
        }

        if (token.logicalName === 'backspace') {
          state.prompt = state.prompt.slice(0, -1);
        } else if (token.logicalName === 'up') {
          if (state.messageQueue.length > 0) state.pullFromQueue();
          else state.scroll(-3, state.getViewportHeight());
        } else if (token.logicalName === 'down') {
          state.scroll(3, state.getViewportHeight());
        }
      } else if (token.type === 'mouse') {
        const vHeight = state.getViewportHeight();
        const headerH = 2;
        const viewportRow = token.row - headerH;
        
        // Handle Scrolling
        if (token.button === 64) state.scroll(-3, vHeight);
        else if (token.button === 65) state.scroll(3, vHeight);
        
        // Audit Fix: Handle Middle Click Paste (Button 1)
        if (token.button === 1 && token.action === 'press') {
          const text = pasteFromClipboard();
          if (text) state.prompt += text;
          render();
          continue;
        }

        // Handle Selection
        if (token.button === 0 && token.action === 'press') {
          state.startSelection(token.col, viewportRow);
        } else if (token.button === 32) {
          state.extendSelection(token.col, viewportRow);
        } else if (token.action === 'release') {
          handleCopy();
          state.endSelection();
        }
      }
    }
    render();
  });

  process.on('SIGINT', handleCtrlC);
  stdout.on('resize', render);
  render();
}

main().catch(console.error);
