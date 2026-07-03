/**
 * KeybindingsManager — loads and merges keyboard shortcut configuration.
 *
 * Default bindings are hardcoded here. Users can override any binding by
 * creating ~/.goodvibes/tui/keybindings.json.
 *
 * Config file format example:
 * {
 *   "search": { "key": "g", "ctrl": true },
 *   "block-copy": { "key": "c", "ctrl": true, "alt": true }
 * }
 *
 * Each value is a KeyCombo or an array of KeyCombos for multi-binding support.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { resolveSurfaceDirectory } from '@/runtime/index.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

/** Identifies a specific key press with modifiers. */
export interface KeyCombo {
  /** Logical key name (single char like 'f', or named key like 'r', 'z', 'f2', etc.) */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** All bindable action identifiers. */
export type KeyAction =
  | 'copy-selection'
  | 'clear-cancel'
  | 'screen-clear'
  | 'panel-picker'
  | 'panel-close'
  | 'panel-close-all'
  | 'panel-tab-next'
  | 'panel-tab-prev'
  | 'panel-tab-1'
  | 'panel-tab-2'
  | 'panel-tab-3'
  | 'panel-tab-4'
  | 'panel-tab-5'
  | 'panel-tab-6'
  | 'panel-tab-7'
  | 'panel-tab-8'
  | 'panel-tab-9'
  | 'panel-ops'
  | 'panel-focus-toggle'
  | 'history-search'
  | 'search'
  | 'block-copy'
  | 'bookmark'
  | 'block-save'
  | 'delete-word'
  | 'apply-diff-line-start'
  | 'next-error-line-end'
  | 'kill-line'
  | 'clear-prompt'
  | 'undo'
  | 'redo'
  | 'paste'
  | 'word-back'
  | 'word-forward'
  | 'kill-to-start'
  | 'kill-word-forward'
  | 'yank'
  | 'yank-pop';

/** Human-readable description for each action (used in /keybindings display). */
export const ACTION_DESCRIPTIONS: Record<KeyAction, string> = {
  'copy-selection':        'Copy selected text to clipboard',
  'clear-cancel':          'Clear input / cancel generation / exit (double)',
  'screen-clear':          'Repaint the screen',
  'panel-picker':          'Open, focus, or hide the panel workspace',
  'panel-close':            'Close the currently active panel',
  'panel-close-all':         'Close all open panels',
  'panel-tab-next':        'Next workspace panel tab',
  'panel-tab-prev':        'Previous workspace panel tab',
  'panel-tab-1':           'Jump to workspace panel tab 1',
  'panel-tab-2':           'Jump to workspace panel tab 2',
  'panel-tab-3':           'Jump to workspace panel tab 3',
  'panel-tab-4':           'Jump to workspace panel tab 4',
  'panel-tab-5':           'Jump to workspace panel tab 5',
  'panel-tab-6':           'Jump to workspace panel tab 6',
  'panel-tab-7':           'Jump to workspace panel tab 7',
  'panel-tab-8':           'Jump to workspace panel tab 8',
  'panel-tab-9':           'Jump to workspace panel tab 9',
  'panel-ops':             'Open the Ops Control panel',
  'panel-focus-toggle':    'Switch keyboard focus between top and bottom pane',
  'history-search':        'Reverse input history search',
  'search':                'Toggle conversation search',
  'block-copy':            'Copy nearest block to clipboard',
  'bookmark':              'Bookmark / unbookmark nearest block',
  'block-save':            'Save nearest block to file',
  'delete-word':           'Delete word backward',
  'apply-diff-line-start': 'Apply nearest diff / move to line start',
  'next-error-line-end':   'Navigate to next error / move to line end',
  'kill-line':             'Kill to end of line',
  'clear-prompt':          'Clear the entire prompt (Alt+U; kill-to-start owns Ctrl+U)',
  'undo':                  'Undo last prompt edit',
  'redo':                  'Redo last undone edit',
  'paste':                 'Paste from clipboard (image priority)',
  'word-back':             'Move cursor to start of previous word (Alt+B)',
  'word-forward':          'Move cursor to end of next word (Alt+F)',
  'kill-to-start':         'Kill from cursor to start of line into kill ring (Ctrl+U)',
  'kill-word-forward':     'Kill word forward into kill ring (Alt+D)',
  'yank':                  'Yank (paste) from kill ring (Ctrl+Shift+Y)',
  'yank-pop':              'Rotate kill ring and yank next entry (Alt+Y)',
};

/** Default key bindings for all actions. */
export const DEFAULT_KEYBINDINGS: Record<KeyAction, KeyCombo[]> = {
  'copy-selection':        [{ key: 'c', ctrl: true, shift: true }],
  'clear-cancel':          [{ key: 'c', ctrl: true }],
  'screen-clear':          [{ key: 'l', ctrl: true }],
  'panel-picker':          [{ key: 'p', ctrl: true }],
  'panel-close':            [{ key: 'x', ctrl: true }],
  'panel-close-all':         [{ key: 'x', ctrl: true, shift: true }],
  'panel-tab-next':        [{ key: ']', ctrl: true }],
  'panel-tab-prev':        [{ key: '[', ctrl: true }],
  // Alt+1..9: jump directly to the Nth workspace panel tab (across both panes).
  // The tokenizer delivers Alt as the token's `meta` modifier; comboMatches /
  // lookup treat `meta` as an alias for `alt`, so these alt-combos route through
  // the same rebindable path as every other action.
  'panel-tab-1':           [{ key: '1', alt: true }],
  'panel-tab-2':           [{ key: '2', alt: true }],
  'panel-tab-3':           [{ key: '3', alt: true }],
  'panel-tab-4':           [{ key: '4', alt: true }],
  'panel-tab-5':           [{ key: '5', alt: true }],
  'panel-tab-6':           [{ key: '6', alt: true }],
  'panel-tab-7':           [{ key: '7', alt: true }],
  'panel-tab-8':           [{ key: '8', alt: true }],
  'panel-tab-9':           [{ key: '9', alt: true }],
  // Ctrl+O: open the Ops Control panel (operator intervention console).
  // Routed globally in handleGlobalShortcutToken: prefers commandContext.openOpsPanel()
  // when the operator-control-plane feature flag wired it, else falls back to opening
  // the always-registered 'ops-control' panel type directly via the panel manager.
  'panel-ops':             [{ key: 'o', ctrl: true }],
  // Ctrl+G: toggle keyboard focus between the top and bottom panes. Ctrl+G is
  // otherwise unbound in the default table.
  'panel-focus-toggle':    [{ key: 'g', ctrl: true }],
  'history-search':        [{ key: 'r', ctrl: true }],
  'search':                [{ key: 'f', ctrl: true }],
  'block-copy':            [{ key: 'y', ctrl: true }],
  'bookmark':              [{ key: 'b', ctrl: true }],
  'block-save':            [{ key: 's', ctrl: true }],
  'delete-word':           [{ key: 'w', ctrl: true }],
  'apply-diff-line-start': [{ key: 'a', ctrl: true }],
  'next-error-line-end':   [{ key: 'e', ctrl: true }],
  'kill-line':             [{ key: 'k', ctrl: true }],
  // Alt+U: clear entire prompt. Ctrl+U is owned by kill-to-start (readline
  // convention). Alt+U is unused by any other default and is representable by
  // the tokenizer's { key, alt } combo form.
  'clear-prompt':          [{ key: 'u', alt: true }],
  'undo':                  [{ key: 'z', ctrl: true }],
  'redo':                  [{ key: 'z', ctrl: true, shift: true }],
  'paste':                 [{ key: 'v', ctrl: true }],
  // Word navigation (Alt+B / Alt+F — emacs readline standard)
  'word-back':             [{ key: 'b', alt: true }],
  'word-forward':          [{ key: 'f', alt: true }],
  // Kill-ring operations.
  // Note: 'kill-line' (Ctrl+K) kills to end; 'kill-to-start' (Ctrl+U) kills to start.
  // 'clear-prompt' (Alt+U) clears the entire buffer regardless of cursor position.
  // kill-to-start owns Ctrl+U (readline convention); clear-prompt uses Alt+U.
  'kill-to-start':         [{ key: 'u', ctrl: true }],
  // Alt+D: kill word forward (no prior conflict)
  'kill-word-forward':     [{ key: 'd', alt: true }],
  // Ctrl+Shift+Y: yank from kill ring.
  // CONFLICT RESOLVED: Ctrl+Y was 'block-copy'; yank moved to Ctrl+Shift+Y.
  'yank':                  [{ key: 'y', ctrl: true, shift: true }],
  // Alt+Y: yank-pop (rotate ring after yank)
  'yank-pop':              [{ key: 'y', alt: true }],
};

/** Resolved overrides type: each key can be a single combo or array. */
type KeybindingsFile = Partial<Record<KeyAction, KeyCombo | KeyCombo[]>>;

export interface KeybindingsManagerOptions {
  readonly configPath?: string;
  readonly userRoot?: string;
  readonly homeDirectory?: string;
  readonly surfaceRoot?: string;
}

function resolveKeybindingsPath(options?: KeybindingsManagerOptions): string {
  if (options?.configPath) {
    return options.configPath;
  }
  const userRoot = options?.userRoot ?? options?.homeDirectory;
  if (!userRoot) {
    throw new Error('KeybindingsManager requires configPath or an explicit userRoot/homeDirectory.');
  }
  if (options?.surfaceRoot) {
    return resolveSurfaceDirectory(userRoot, options.surfaceRoot, 'keybindings.json');
  }
  return join(userRoot, '.goodvibes', 'tui', 'keybindings.json');
}

/**
 * KeybindingsManager — owns the resolved keybinding table.
 *
 * Call loadFromDisk() once at startup (in main.ts) to merge user config.
 * Then use matches() anywhere a key token is being evaluated.
 */
export class KeybindingsManager {
  private bindings: Record<KeyAction, KeyCombo[]>;
  private configPath: string;
  /** Inverted lookup map: composite key → KeyAction. Built in buildLookupMap(). */
  private lookupMap = new Map<string, KeyAction>();

  constructor(options: KeybindingsManagerOptions) {
    this.configPath = resolveKeybindingsPath(options);
    // Start with deep copy of defaults
    this.bindings = this.cloneDefaults();
    this.buildLookupMap();
  }

  private cloneDefaults(): Record<KeyAction, KeyCombo[]> {
    const result = {} as Record<KeyAction, KeyCombo[]>;
    for (const [action, combos] of Object.entries(DEFAULT_KEYBINDINGS) as [KeyAction, KeyCombo[]][]) {
      result[action] = combos.map(c => ({ ...c }));
    }
    return result;
  }

  /**
   * Load user overrides from disk and merge into the binding table.
   * Unknown actions are ignored with a debug log. Malformed entries are skipped.
   * Safe to call multiple times (reloads on each call).
   */
  loadFromDisk(): void {
    if (!existsSync(this.configPath)) return;
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as KeybindingsFile;
      const validActions = new Set(Object.keys(DEFAULT_KEYBINDINGS) as KeyAction[]);

      // Reset to defaults before applying overrides
      this.bindings = this.cloneDefaults();

      for (const [action, combo] of Object.entries(parsed)) {
        if (!validActions.has(action as KeyAction)) {
          logger.debug('keybindings: unknown action, skipping', { action });
          continue;
        }
        const normalized = Array.isArray(combo) ? combo : [combo];
        if (!this.validateCombos(normalized)) {
          logger.debug('keybindings: invalid combo for action, skipping', { action, combo });
          continue;
        }
        this.bindings[action as KeyAction] = normalized;
      }
      logger.debug('keybindings: loaded overrides from disk', { path: this.configPath });
    } catch (err) {
      logger.debug('keybindings: failed to load config file', { path: this.configPath, err: summarizeError(err) });
    }
    this.buildLookupMap();
  }

  /**
   * buildLookupMap — Rebuild the inverted lookup map from the current bindings table.
   * Called after constructor init and after loadFromDisk().
   * Map key format: "logicalName:ctrl:shift:alt" (booleans as 0/1).
   * Last writer wins for duplicate combos (deterministic: iterate actions in order).
   */
  private buildLookupMap(): void {
    this.lookupMap.clear();
    for (const [action, combos] of Object.entries(this.bindings) as [KeyAction, KeyCombo[]][]) {
      for (const combo of combos) {
        const key = `${combo.key}:${combo.ctrl ? 1 : 0}:${combo.shift ? 1 : 0}:${combo.alt ? 1 : 0}`;
        this.lookupMap.set(key, action);
      }
    }
  }

  /**
   * lookup — O(1) keybinding lookup by token.
   * Returns the matching KeyAction, or null if no binding matches.
   */
  lookup(token: { logicalName?: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }): KeyAction | null {
    if (!token.logicalName) return null;
    // The tokenizer delivers the Alt modifier as `meta`; the binding table stores
    // it as `alt`. Treat the two as one modifier at the matching boundary so
    // Alt-based combos (word-nav, kill-ring, panel-tab-1..9) resolve at runtime.
    const alt = token.alt ?? token.meta;
    const key = `${token.logicalName}:${token.ctrl ? 1 : 0}:${token.shift ? 1 : 0}:${alt ? 1 : 0}`;
    return this.lookupMap.get(key) ?? null;
  }

  private validateCombos(combos: unknown[]): combos is KeyCombo[] {
    return combos.every((c) => {
      if (typeof c !== 'object' || c === null) return false;
      const combo = c as Record<string, unknown>;
      return typeof combo['key'] === 'string' && combo['key'].length > 0;
    });
  }

  /**
   * matches — Check whether a keyboard token matches the given action.
   *
   * @param action  The action to test.
   * @param token   The parsed keyboard token from InputTokenizer.
   *                Expects: { logicalName: string; ctrl?: boolean; shift?: boolean; alt?: boolean }
   */
  matches(
    action: KeyAction,
    token: { logicalName?: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean },
  ): boolean {
    const combos = this.bindings[action];
    if (!combos) return false;
    return combos.some((combo) => this.comboMatches(combo, token));
  }

  private comboMatches(
    combo: KeyCombo,
    token: { logicalName?: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean },
  ): boolean {
    if (token.logicalName !== combo.key) return false;
    if (!!combo.ctrl !== !!token.ctrl) return false;
    if (!!combo.shift !== !!token.shift) return false;
    // Alt arrives as `meta` from the tokenizer; accept either as the Alt modifier.
    if (!!combo.alt !== !!(token.alt ?? token.meta)) return false;
    return true;
  }

  /**
   * getAll — Return the full resolved binding table for display purposes.
   */
  getAll(): Array<{ action: KeyAction; combos: KeyCombo[]; description: string }> {
    return (Object.keys(this.bindings) as KeyAction[]).map((action) => ({
      action,
      combos: this.bindings[action],
      description: ACTION_DESCRIPTIONS[action],
    }));
  }

  /**
   * getComboLabel — Return a human-readable label for the first combo of an action.
   * Example: { key: 'f', ctrl: true } → "Ctrl+F"
   */
  getComboLabel(action: KeyAction): string {
    const combos = this.bindings[action];
    if (!combos?.length) return '(unbound)';
    return this.formatCombo(combos[0]);
  }

  /**
   * formatCombo — Format a KeyCombo as a human-readable string.
   */
  formatCombo(combo: KeyCombo): string {
    const parts: string[] = [];
    if (combo.ctrl) parts.push('Ctrl');
    if (combo.alt) parts.push('Alt');
    if (combo.shift) parts.push('Shift');
    parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
    return parts.join('+');
  }

  /** Return the config file path. */
  getConfigPath(): string {
    return this.configPath;
  }
}
