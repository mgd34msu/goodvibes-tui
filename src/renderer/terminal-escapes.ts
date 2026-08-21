/**
 * terminal-escapes, the raw control sequences main.ts writes to enter/leave the
 * TUI's terminal mode (alt screen, mouse, cursor, keyboard-extension, paste, and
 * focus reporting). Extracted from main.ts as plain constants so the entry file
 * stays within the source-file line-count gate; behaviour is unchanged.
 */

export const ALT_SCREEN_ENTER = '\x1b[?1049h';
export const ALT_SCREEN_EXIT = '\x1b[?1049l';
export const MOUSE_ENABLE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
export const MOUSE_DISABLE = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';
export const CURSOR_HIDE = '\x1b[?25l';
export const CURSOR_SHOW = '\x1b[?25h';
export const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';
export const KEYBOARD_EXT_ENABLE = '\x1b[>4;2m' + '\x1b[?1u';
export const KEYBOARD_EXT_DISABLE = '\x1b[>4;0m' + '\x1b[?1l';
export const PASTE_ENABLE = '\x1b[?2004h';
export const PASTE_DISABLE = '\x1b[?2004l';
export const FOCUS_ENABLE = '\x1b[?1004h';
export const FOCUS_DISABLE = '\x1b[?1004l';
