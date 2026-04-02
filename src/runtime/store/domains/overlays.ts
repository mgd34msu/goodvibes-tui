/**
 * Overlays domain state — tracks which full-screen or floating overlays
 * are currently visible and their configuration.
 */

/** All known overlay identifiers in the TUI. */
export type OverlayId =
  | 'help'
  | 'model_picker'
  | 'session_picker'
  | 'command_palette'
  | 'search'
  | 'permission_prompt'
  | 'confirmation'
  | 'settings'
  | 'agent_inspector'
  | 'task_monitor';

/** State of a single overlay instance. */
export interface OverlayInstance {
  /** Overlay identifier. */
  id: OverlayId;
  /** Whether the overlay is visible. */
  visible: boolean;
  /** Epoch ms when the overlay was opened. */
  openedAt: number;
  /** Optional opaque payload specific to each overlay type. */
  payload?: unknown;
  /** Z-order (higher = on top). */
  zIndex: number;
}

/**
 * OverlayDomainState — manages the overlay stack and focus.
 */
export interface OverlayDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Overlay stack ──────────────────────────────────────────────────────────
  /** All registered overlay instances keyed by OverlayId. */
  overlays: Map<OverlayId, OverlayInstance>;
  /** Stack of currently visible overlay IDs in z-order (bottom → top). */
  visibleStack: OverlayId[];
  /** The overlay currently holding keyboard focus (undefined = none). */
  focusedOverlayId?: OverlayId;

  // ── Permission prompt state ─────────────────────────────────────────────────
  /**
   * Pending permission prompt context.
   * Populated when the 'permission_prompt' overlay is open.
   */
  pendingPermission?: {
    callId: string;
    toolName: string;
    category: string;
    args: Record<string, unknown>;
  };

  // ── Confirmation overlay state ─────────────────────────────────────────────
  /**
   * Pending confirmation dialog context.
   * Populated when the 'confirmation' overlay is open.
   */
  pendingConfirmation?: {
    message: string;
    detail?: string;
    confirmLabel: string;
    cancelLabel: string;
    resolveKey: string;
  };
}

/**
 * Returns the default initial state for the overlays domain.
 */
export function createInitialOverlaysState(): OverlayDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    overlays: new Map(),
    visibleStack: [],
    focusedOverlayId: undefined,
    pendingPermission: undefined,
    pendingConfirmation: undefined,
  };
}
