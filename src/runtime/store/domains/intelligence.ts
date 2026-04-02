/**
 * Intelligence domain state — tracks AI-assisted developer intelligence
 * features: diagnostics, completions, hover info, and symbol references.
 */

/** Status of an intelligence feature. */
export type IntelligenceFeatureStatus = 'unavailable' | 'loading' | 'ready' | 'degraded';

/** A single LSP diagnostic. */
export interface LspDiagnostic {
  /** Relative file path. */
  filePath: string;
  /** 0-indexed line number. */
  line: number;
  /** 0-indexed column. */
  column: number;
  /** Severity level. */
  severity: 'error' | 'warning' | 'info' | 'hint';
  /** Diagnostic message. */
  message: string;
  /** Diagnostic source (e.g. 'typescript'). */
  source?: string;
  /** Diagnostic code. */
  code?: string;
}

/** Symbol information from workspace symbol search. */
export interface WorkspaceSymbol {
  /** Symbol name. */
  name: string;
  /** Symbol kind (LSP SymbolKind integer). */
  kind: number;
  /** Relative file path. */
  filePath: string;
  /** 0-indexed line. */
  line: number;
  /** 0-indexed column. */
  column: number;
}

/** Current completions / hover state. */
export interface IntelligenceHoverState {
  /** Whether hover info is currently displayed. */
  active: boolean;
  /** File path of the hover target. */
  filePath?: string;
  /** Hover content (Markdown). */
  content?: string;
  /** Epoch ms when the hover was last updated. */
  updatedAt?: number;
}

/**
 * IntelligenceDomainState — developer intelligence features.
 */
export interface IntelligenceDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Feature availability ────────────────────────────────────────────────────
  /** Diagnostics feature status. */
  diagnosticsStatus: IntelligenceFeatureStatus;
  /** Completions feature status. */
  completionsStatus: IntelligenceFeatureStatus;
  /** Symbol search feature status. */
  symbolSearchStatus: IntelligenceFeatureStatus;
  /** Hover feature status. */
  hoverStatus: IntelligenceFeatureStatus;

  // ── Diagnostics ────────────────────────────────────────────────────────────
  /** Current diagnostics keyed by file path. */
  diagnostics: Map<string, LspDiagnostic[]>;
  /** Total error diagnostics across all files. */
  errorCount: number;
  /** Total warning diagnostics across all files. */
  warningCount: number;

  // ── Hover ────────────────────────────────────────────────────────────────
  /** Current hover display state. */
  hover: IntelligenceHoverState;

  // ── Statistics ─────────────────────────────────────────────────────────────
  /** Total LSP requests made this session. */
  totalRequests: number;
  /** Total LSP request errors. */
  totalErrors: number;
  /** Average LSP response latency in ms. */
  avgLatencyMs: number;
}

/**
 * Returns the default initial state for the intelligence domain.
 */
export function createInitialIntelligenceState(): IntelligenceDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    diagnosticsStatus: 'unavailable',
    completionsStatus: 'unavailable',
    symbolSearchStatus: 'unavailable',
    hoverStatus: 'unavailable',
    diagnostics: new Map(),
    errorCount: 0,
    warningCount: 0,
    hover: { active: false },
    totalRequests: 0,
    totalErrors: 0,
    avgLatencyMs: 0,
  };
}
