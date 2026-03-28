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
import { homedir } from 'node:os';
import { logger } from '../utils/logger.ts';

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
  | 'panel-tab-next'
  | 'panel-tab-prev'
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
  | 'paste';

/** Human-readable description for each action (used in /keybindings display). */
export const ACTION_DESCRIPTIONS: Record<KeyAction, string> = {
  'copy-selection':        'Copy selected text to clipboard',
  'clear-cancel':          'Clear input / cancel generation / exit (double)',
  'screen-clear':          'Repaint the screen',
  'panel-picker':          'Toggle panel sidebar',
  'panel-tab-next':        'Next panel tab',
  'panel-tab-prev':        'Previous panel tab',
  'history-search':        'Reverse input history search',
  'search':                'Toggle conversation search',
  'block-copy':            'Copy nearest block to clipboard',
  'bookmark':              'Bookmark / unbookmark nearest block',
  'block-save':            'Save nearest block to file',
  'delete-word':           'Delete word backward',
  'apply-diff-line-start': 'Apply nearest diff / move to line start',
  'next-error-line-end':   'Navigate to next error / move to line end',
  'kill-line':             'Kill to end of line',
  'clear-prompt':          'Clear the prompt',
  'undo':                  'Undo last prompt edit',
  'redo':                  'Redo last undone edit',
  'paste':                 'Paste from clipboard (image priority)',
};

/** Default key bindings for all actions. */
export const DEFAULT_KEYBINDINGS: Record<KeyAction, KeyCombo[]> = {
  'copy-selection':        [{ key: 'c', ctrl: true, shift: true }],
  'clear-cancel':          [{ key: 'c', ctrl: true }],
  'screen-clear':          [{ key: 'l', ctrl: true }],
  'panel-picker':          [{ key: 'p', ctrl: true }],
  'panel-tab-next':        [{ key: '}', ctrl: true }],
  'panel-tab-prev':        [{ key: '~', ctrl: true }],
  'history-search':        [{ key: 'r', ctrl: true }],
  'search':                [{ key: 'f', ctrl: true }],
  'block-copy':            [{ key: 'y', ctrl: true }],
  'bookmark':              [{ key: 'b', ctrl: true }],
  'block-save':            [{ key: 's', ctrl: true }],
  'delete-word':           [{ key: 'w', ctrl: true }],
  'apply-diff-line-start': [{ key: 'a', ctrl: true }],
  'next-error-line-end':   [{ key: 'e', ctrl: true }],
  'kill-line':             [{ key: 'k', ctrl: true }],
  'clear-prompt':          [{ key: 'u', ctrl: true }],
  'undo':                  [{ key: 'z', ctrl: true }],
  'redo':                  [{ key: 'z', ctrl: true, shift: true }],
  'paste':                 [{ key: 'v', ctrl: true }],
};

/** Resolved overrides type: each key can be a single combo or array. */
type KeybindingsFile = Partial<Record<KeyAction, KeyCombo | KeyCombo[]>>;

/**
 * KeybindingsManager — singleton that owns the resolved keybinding table.
 *
 * Call loadFromDisk() once at startup (in main.ts) to merge user config.
 * Then use matches() anywhere a key token is being evaluated.
 */
export class KeybindingsManager {
  private bindings: Record<KeyAction, KeyCombo[]>;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? join(homedir(), '.goodvibes', 'tui', 'keybindings.json');
    // Start with deep copy of defaults
    this.bindings = this.cloneDefaults();
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
      logger.debug('keybindings: failed to load config file', { path: this.configPath, err: String(err) });
    }
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
    token: { logicalName?: string; ctrl?: boolean; shift?: boolean; alt?: boolean },
  ): boolean {
    const combos = this.bindings[action];
    if (!combos) return false;
    return combos.some((combo) => this.comboMatches(combo, token));
  }

  private comboMatches(
    combo: KeyCombo,
    token: { logicalName?: string; ctrl?: boolean; shift?: boolean; alt?: boolean },
  ): boolean {
    if (token.logicalName !== combo.key) return false;
    if (!!combo.ctrl !== !!token.ctrl) return false;
    if (!!combo.shift !== !!token.shift) return false;
    if (!!combo.alt !== !!token.alt) return false;
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

/** Module-level singleton — shared across the app. */
let _instance: KeybindingsManager | undefined;

export function getKeybindingsManager(): KeybindingsManager {
  if (!_instance) {
    _instance = new KeybindingsManager();
  }
  return _instance;
}

/** Reset the singleton (for testing). */
export function resetKeybindingsManager(): void {
  _instance = undefined;
}
