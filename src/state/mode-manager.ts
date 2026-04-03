import type { DomainVerbosity } from '../runtime/notifications/types.ts';

// ---------------------------------------------------------------------------
// Precision tool verbosity modes (original API, preserved)
// ---------------------------------------------------------------------------

export type ModePreset = 'default' | 'vibecoding' | 'justvibes' | (string & Record<never, never>);

export interface VerbosityDefaults {
  write: string;
  edit: string;
  read: string;
  grep: string;
  glob: string;
  exec: string;
}

export interface ModeDefinition {
  name: ModePreset;
  description: string;
  verbosityDefaults: Partial<VerbosityDefaults>;
  enforcement: 'strict' | 'advisory';
}

const DEFAULT_VERBOSITY: VerbosityDefaults = {
  write: 'standard',
  edit: 'with_diff',
  read: 'standard',
  grep: 'matches',
  glob: 'paths_only',
  exec: 'standard',
};

const VIBECODING_VERBOSITY: VerbosityDefaults = {
  write: 'count_only',
  edit: 'minimal',
  read: 'standard',
  grep: 'files_only',
  glob: 'paths_only',
  exec: 'minimal',
};

const BUILT_IN_MODES: ModeDefinition[] = [
  {
    name: 'default',
    description: 'Standard precision tool verbosity with confirmation prompts.',
    verbosityDefaults: DEFAULT_VERBOSITY,
    enforcement: 'advisory',
  },
  {
    name: 'vibecoding',
    description: 'Reduced verbosity for rapid iteration; still confirms destructive operations.',
    verbosityDefaults: VIBECODING_VERBOSITY,
    enforcement: 'advisory',
  },
  {
    name: 'justvibes',
    description: 'Minimal output, no confirmation prompts. Fast and autonomous.',
    verbosityDefaults: VIBECODING_VERBOSITY,
    enforcement: 'advisory',
  },
];

// ---------------------------------------------------------------------------
// HITL UX modes (Section 5.11)
// ---------------------------------------------------------------------------

export type HITLMode = 'quiet' | 'balanced' | 'operator';

export interface HITLModeDefinition {
  name: HITLMode;
  description: string;
  defaultDomainVerbosity: DomainVerbosity;
  quietWhileTyping: boolean;
  batchWindowMs: number;
}

export const HITL_QUIET: HITLModeDefinition = {
  name: 'quiet',
  description: 'Minimal verbosity. Suppresses most notifications. Batches updates in 5s windows.',
  defaultDomainVerbosity: 'minimal',
  quietWhileTyping: true,
  batchWindowMs: 5_000,
};

export const HITL_BALANCED: HITLModeDefinition = {
  name: 'balanced',
  description: 'Normal verbosity. Standard notification flow. Batches updates in 2s windows.',
  defaultDomainVerbosity: 'normal',
  quietWhileTyping: true,
  batchWindowMs: 2_000,
};

export const HITL_OPERATOR: HITLModeDefinition = {
  name: 'operator',
  description: 'Verbose. All notifications shown immediately. No quiet-while-typing suppression.',
  defaultDomainVerbosity: 'verbose',
  quietWhileTyping: false,
  batchWindowMs: 500,
};

const HITL_PRESETS: HITLModeDefinition[] = [HITL_QUIET, HITL_BALANCED, HITL_OPERATOR];

// ---------------------------------------------------------------------------
// ModeManager singleton
// ---------------------------------------------------------------------------

export class ModeManager {
  private static instance: ModeManager | undefined;

  private currentMode: ModePreset = 'default';
  private modes: ModeDefinition[] = [...BUILT_IN_MODES];

  private hitlMode: HITLMode = 'balanced';
  private domainOverrides: Map<string, DomainVerbosity> = new Map();

  private constructor() {}

  static getInstance(): ModeManager {
    if (!ModeManager.instance) {
      ModeManager.instance = new ModeManager();
    }
    return ModeManager.instance;
  }

  static resetInstance(): void {
    ModeManager.instance = undefined;
  }

  // -------------------------------------------------------------------------
  // Precision tool verbosity mode API
  // -------------------------------------------------------------------------

  getMode(): ModePreset {
    return this.currentMode;
  }

  getModeDefinition(): ModeDefinition {
    return this.modes.find((m) => m.name === this.currentMode) ?? this.modes[0]!;
  }

  setMode(mode: ModePreset): void {
    const found = this.modes.find((m) => m.name === mode);
    if (!found) {
      const available = this.modes.map((m) => `"${m.name}"`).join(', ');
      throw new Error(`Unknown mode: "${mode}". Available modes: ${available}`);
    }
    this.currentMode = mode;
  }

  listModes(): ModeDefinition[] {
    return [...this.modes];
  }

  registerMode(def: ModeDefinition): void {
    const idx = this.modes.findIndex((m) => m.name === def.name);
    if (idx >= 0) {
      this.modes[idx] = def;
    } else {
      this.modes.push(def);
    }
  }

  getVerbosityDefaults(): Partial<VerbosityDefaults> {
    return { ...this.getModeDefinition().verbosityDefaults };
  }

  // -------------------------------------------------------------------------
  // HITL UX mode API (Section 5.11)
  // -------------------------------------------------------------------------

  getHITLMode(): HITLMode {
    return this.hitlMode;
  }

  getHITLPreset(): HITLModeDefinition {
    return HITL_PRESETS.find((p) => p.name === this.hitlMode) ?? HITL_BALANCED;
  }

  /**
   * Switch the active HITL mode.
   *
   * Switching modes clears all per-domain verbosity overrides that may have
   * been set via {@link setDomainVerbosity}. This ensures the new mode's
   * `defaultDomainVerbosity` applies uniformly until the caller re-establishes
   * any domain-specific overrides.
   */
  setHITLMode(mode: HITLMode): void {
    const found = HITL_PRESETS.find((p) => p.name === mode);
    if (!found) {
      const available = HITL_PRESETS.map((p) => `"${p.name}"`).join(', ');
      throw new Error(`Unknown HITL mode: "${mode}". Available: ${available}`);
    }
    this.hitlMode = mode;
    this.domainOverrides.clear();
  }

  listHITLPresets(): HITLModeDefinition[] {
    return [...HITL_PRESETS];
  }

  setDomainVerbosity(domain: string, verbosity: DomainVerbosity): void {
    this.domainOverrides.set(domain, verbosity);
  }

  getDomainVerbosity(domain: string): DomainVerbosity {
    return this.domainOverrides.get(domain) ?? this.getHITLPreset().defaultDomainVerbosity;
  }

  getDomainOverrides(): Record<string, DomainVerbosity> {
    return Object.fromEntries(this.domainOverrides);
  }

  applyToRouter(router: {
    setQuietWhileTyping(enabled: boolean): void;
    setBatchWindowMs?(ms: number): void;
    setDefaultDomainVerbosity?(verbosity: DomainVerbosity): void;
    setDomainVerbosity(domain: string, verbosity: DomainVerbosity): void;
  }): void {
    const preset = this.getHITLPreset();
    router.setQuietWhileTyping(preset.quietWhileTyping);
    router.setBatchWindowMs?.(preset.batchWindowMs);
    router.setDefaultDomainVerbosity?.(preset.defaultDomainVerbosity);
    for (const [domain, verbosity] of this.domainOverrides) {
      router.setDomainVerbosity(domain, verbosity);
    }
  }
}
