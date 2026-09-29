/**
 * External-editor composition for the composer.
 *
 * Opens the user's $VISUAL/$EDITOR on the current composer draft, then loads
 * the edited text back into the composer. While the editor runs the TUI is
 * suspended: raw mode is dropped and the alt screen / mouse / paste / focus
 * modes are disabled so the editor owns a normal terminal; on return the TUI
 * modes are restored and the screen is repainted from scratch.
 *
 * The subprocess is run through the existing exec pattern (Bun/Node
 * `spawnSync` with inherited stdio) so the editor shares this process's tty.
 * The spawn is injectable for testing.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALT_SCREEN_ENTER, ALT_SCREEN_EXIT, CLEAR_SCREEN, CURSOR_HIDE, CURSOR_SHOW,
  MOUSE_ENABLE, MOUSE_DISABLE, KEYBOARD_EXT_ENABLE, KEYBOARD_EXT_DISABLE,
  PASTE_ENABLE, PASTE_DISABLE, FOCUS_ENABLE, FOCUS_DISABLE,
} from '../renderer/terminal-escapes.ts';

export interface EditorSpawnResult {
  readonly status: number | null;
  readonly error?: Error | undefined;
}

/** Runs the editor synchronously with inherited stdio. Injectable for tests. */
export type EditorSpawn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => EditorSpawnResult;

export interface ComposerEditorDeps {
  readonly readDraft: () => string;
  readonly writeDraft: (text: string) => void;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Drop the TUI's raw/alt-screen modes so the editor owns the terminal. */
  readonly suspend: () => void;
  /** Restore the TUI's modes and repaint. */
  readonly resume: () => void;
  readonly notify: (message: string) => void;
  readonly spawn?: EditorSpawn;
}

/** Resolve $VISUAL/$EDITOR into a command + fixed args, or null when unset. */
export function resolveEditorCommand(env: NodeJS.ProcessEnv): { cmd: string; args: string[] } | null {
  const raw = (env.VISUAL || env.EDITOR || '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  const cmd = parts[0];
  if (!cmd) return null;
  return { cmd, args: parts.slice(1) };
}

const defaultSpawn: EditorSpawn = (cmd, args, opts) => {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd, env: opts.env });
  return { status: res.status, error: res.error };
};

/** Core flow: temp file round-trip around a suspended-terminal editor launch. */
export function openComposerInEditor(deps: ComposerEditorDeps): void {
  const editor = resolveEditorCommand(deps.env);
  if (!editor) {
    deps.notify('[Editor] Set $EDITOR or $VISUAL to edit the composer in an external editor.');
    return;
  }
  const draft = deps.readDraft();
  // Real production scratch (runs on the end user's machine, not test
  // infrastructure), so this stays rooted at the real OS temp dir rather
  // than the test-only makeProjectTempDir helper. Cleaned up in the
  // `finally` below on every exit path.
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-composer-'));
  const file = join(dir, 'COMPOSER.md');
  const spawn = deps.spawn ?? defaultSpawn;
  let result: EditorSpawnResult;
  try {
    writeFileSync(file, draft, 'utf8');
    deps.suspend();
    try {
      result = spawn(editor.cmd, [...editor.args, file], { cwd: deps.cwd, env: deps.env });
    } finally {
      deps.resume();
    }
    if (result.error) {
      deps.notify(`[Editor] Failed to launch ${editor.cmd}: ${result.error.message}`);
      return;
    }
    if (result.status !== 0 && result.status !== null) {
      deps.notify(`[Editor] ${editor.cmd} exited with code ${result.status}; composer left unchanged.`);
      return;
    }
    let edited = draft;
    try { edited = readFileSync(file, 'utf8'); } catch { /* keep the original draft */ }
    deps.writeDraft(edited.replace(/\n+$/, '')); // editors append a trailing newline
    deps.notify('[Editor] Composer updated from external editor.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LEAVE_TUI = PASTE_DISABLE + KEYBOARD_EXT_DISABLE + MOUSE_DISABLE + FOCUS_DISABLE + ALT_SCREEN_EXIT + CURSOR_SHOW;
const ENTER_TUI = ALT_SCREEN_ENTER + CLEAR_SCREEN + CURSOR_HIDE + MOUSE_ENABLE + KEYBOARD_EXT_ENABLE + PASTE_ENABLE + FOCUS_ENABLE;

export interface ComposerEditorOpenerDeps {
  /** The live composer buffer (InputHandler exposes public `prompt`/`cursorPos`). */
  readonly buffer: { prompt: string; cursorPos: number };
  readonly stdin: { setRawMode(on: boolean): unknown };
  readonly stdout: { write(seq: string): unknown };
  /** Terminal-output guard wrapper (allowTerminalWrite). */
  readonly writeGuard: (fn: () => void) => void;
  readonly repaint: () => void;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly notify: (message: string) => void;
  readonly spawn?: EditorSpawn;
}

/** Build the `openComposerEditor` command action, wiring terminal suspend/resume. */
export function makeComposerEditorOpener(deps: ComposerEditorOpenerDeps): () => void {
  return () => openComposerInEditor({
    readDraft: () => deps.buffer.prompt,
    writeDraft: (text) => { deps.buffer.prompt = text; deps.buffer.cursorPos = text.length; },
    cwd: deps.cwd,
    env: deps.env,
    notify: deps.notify,
    spawn: deps.spawn,
    suspend: () => {
      try { deps.stdin.setRawMode(false); } catch { /* stdin may not be a TTY */ }
      deps.writeGuard(() => deps.stdout.write(LEAVE_TUI));
    },
    resume: () => {
      deps.writeGuard(() => deps.stdout.write(ENTER_TUI));
      try { deps.stdin.setRawMode(true); } catch { /* stdin may not be a TTY */ }
      deps.repaint();
    },
  });
}

/** Editors known to take `+<line> <file>` to open at a line. */
const LINE_ARG_EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'micro', 'kak', 'hx', 'helix', 'ne', 'joe', 'mg']);

export interface FileEditorOpenerDeps {
  readonly stdin: { setRawMode(on: boolean): unknown };
  readonly stdout: { write(seq: string): unknown };
  readonly writeGuard: (fn: () => void) => void;
  readonly repaint: () => void;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly notify: (message: string) => void;
  readonly spawn?: EditorSpawn;
}

/**
 * Build `openFileInEditor`: suspend the TUI, run $VISUAL / $EDITOR on a file
 * (at a line when the editor is known to take `+<line>`), then restore and
 * repaint. The Changes modal's `o` uses this.
 */
export function makeFileEditorOpener(deps: FileEditorOpenerDeps): (path: string, line?: number) => void {
  return (path, line) => {
    const editor = resolveEditorCommand(deps.env);
    if (!editor) {
      deps.notify('[Editor] Set $EDITOR or $VISUAL to open files in an external editor.');
      return;
    }
    const base = editor.cmd.split('/').pop() ?? editor.cmd;
    const lineArgs = line !== undefined && line > 0 && LINE_ARG_EDITORS.has(base) ? [`+${line}`] : [];
    const spawn = deps.spawn ?? defaultSpawn;
    try { deps.stdin.setRawMode(false); } catch { /* stdin may not be a TTY */ }
    deps.writeGuard(() => deps.stdout.write(LEAVE_TUI));
    let result: EditorSpawnResult;
    try {
      result = spawn(editor.cmd, [...editor.args, ...lineArgs, path], { cwd: deps.cwd, env: deps.env });
    } finally {
      deps.writeGuard(() => deps.stdout.write(ENTER_TUI));
      try { deps.stdin.setRawMode(true); } catch { /* stdin may not be a TTY */ }
      deps.repaint();
    }
    if (result.error) deps.notify(`[Editor] Failed to launch ${editor.cmd}: ${result.error.message}`);
    else if (result.status !== 0 && result.status !== null) deps.notify(`[Editor] ${editor.cmd} exited with code ${result.status}.`);
  };
}
