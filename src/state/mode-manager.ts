// ---------------------------------------------------------------------------
// ModeManager — output mode management
// Session-scoped: no config persistence, pure state holder.
// ---------------------------------------------------------------------------

export interface ModeDefinition {
  name: string;
  description: string;
  verbosityDefaults: Record<string, string>;
  enforcement: 'strict' | 'advisory';
}

// ---------------------------------------------------------------------------
// Built-in modes
// ---------------------------------------------------------------------------

const DEFAULT_MODE: ModeDefinition = {
  name: 'default',
  description: 'Standard output verbosity with diffs and full match context.',
  verbosityDefaults: {
    write: 'standard',
    edit: 'with_diff',
    read: 'standard',
    grep: 'matches',
    glob: 'paths_only',
    exec: 'standard',
  },
  enforcement: 'advisory',
};

const VIBECODING_MODE: ModeDefinition = {
  name: 'vibecoding',
  description: 'Minimal output verbosity optimised for fast, token-efficient iteration.',
  verbosityDefaults: {
    write: 'count_only',
    edit: 'minimal',
    read: 'standard',
    grep: 'files_only',
    glob: 'paths_only',
    exec: 'minimal',
  },
  enforcement: 'advisory',
};

const JUSTVIBES_MODE: ModeDefinition = {
  name: 'justvibes',
  description: 'Ultra-quiet mode: suppress all non-essential output.',
  verbosityDefaults: {
    write: 'count_only',
    edit: 'minimal',
    read: 'standard',
    grep: 'files_only',
    glob: 'paths_only',
    exec: 'minimal',
  },
  enforcement: 'advisory',
};

// ---------------------------------------------------------------------------
// ModeManager
// ---------------------------------------------------------------------------

let _instance: ModeManager | null = null;

export class ModeManager {
  private modes: Map<string, ModeDefinition>;
  private current: string;

  private constructor() {
    this.modes = new Map();
    this.modes.set('default', DEFAULT_MODE);
    this.modes.set('vibecoding', VIBECODING_MODE);
    this.modes.set('justvibes', JUSTVIBES_MODE);
    this.current = 'default';
  }

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------

  static getInstance(): ModeManager {
    if (!_instance) {
      _instance = new ModeManager();
    }
    return _instance;
  }

  /**
   * Reset the singleton — intended for testing only.
   */
  static resetInstance(): void {
    _instance = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Returns the name of the currently active mode.
   */
  getMode(): string {
    return this.current;
  }

  /**
   * Switch to the named mode. Throws if the mode is not registered.
   */
  setMode(name: string): void {
    if (!this.modes.has(name)) {
      throw new Error(`Unknown mode: "${name}". Available modes: ${[...this.modes.keys()].join(', ')}`);
    }
    this.current = name;
  }

  /**
   * Returns a copy of all registered mode definitions.
   */
  listModes(): ModeDefinition[] {
    return [...this.modes.values()];
  }

  /**
   * Returns the verbosity defaults for the current mode.
   */
  getVerbosityDefaults(): Record<string, string> {
    const mode = this.modes.get(this.current);
    // current is always a valid key — safe assertion
    return { ...(mode as ModeDefinition).verbosityDefaults };
  }

  /**
   * Register a custom mode at runtime. Overwriting a built-in mode is allowed.
   */
  registerMode(mode: ModeDefinition): void {
    this.modes.set(mode.name, mode);
  }
}
