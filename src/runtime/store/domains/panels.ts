/**
 * Panels domain state — tracks the panel-first operator UX surfaces:
 * which panels are open, their layout, and focus state.
 */

/** All known panel identifiers in the TUI. */
export type PanelId =
  | 'main_conversation'
  | 'agent_monitor'
  | 'task_list'
  | 'tool_trace'
  | 'diff_viewer'
  | 'file_explorer'
  | 'git_status'
  | 'mcp_inspector'
  | 'plugin_manager'
  | 'telemetry_dashboard'
  | 'session_list';

/** Layout position within a split-pane TUI layout. */
export type PanelPosition = 'primary' | 'secondary' | 'sidebar' | 'footer';

/** State of a single panel. */
export interface PanelState {
  /** Panel identifier. */
  id: PanelId;
  /** Whether the panel is currently open/visible. */
  open: boolean;
  /** Layout position assignment. */
  position: PanelPosition;
  /** Relative size weight within its position slot (1–100). */
  sizeWeight: number;
  /** Whether the panel currently has input focus. */
  focused: boolean;
  /** Epoch ms when the panel was last activated. */
  lastActivatedAt?: number;
  /**
   * Scroll offset in lines (for scrollable panels).
   */
  scrollOffset: number;
  /** Whether the panel content is collapsed. */
  collapsed: boolean;
}

/**
 * PanelDomainState — panel layout and focus management.
 */
export interface PanelDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Panel registry ─────────────────────────────────────────────────────────
  /** All panels keyed by PanelId. */
  panels: Map<PanelId, PanelState>;
  /** The panel currently holding keyboard focus. */
  focusedPanelId: PanelId;
  /** Previously focused panel (for focus restoration). */
  previousFocusedPanelId?: PanelId;

  // ── Layout ─────────────────────────────────────────────────────────────────
  /** Whether the sidebar is visible. */
  sidebarVisible: boolean;
  /** Whether the footer panel row is visible. */
  footerVisible: boolean;
  /** Current terminal width in columns. */
  terminalColumns: number;
  /** Current terminal height in rows. */
  terminalRows: number;
}

/**
 * Returns the default initial state for the panels domain.
 */
export function createInitialPanelsState(): PanelDomainState {
  const defaultPanel = (id: PanelId, open: boolean, position: PanelPosition): PanelState => ({
    id,
    open,
    position,
    sizeWeight: 50,
    focused: id === 'main_conversation',
    lastActivatedAt: undefined,
    scrollOffset: 0,
    collapsed: false,
  });

  const panels = new Map<PanelId, PanelState>([
    ['main_conversation', defaultPanel('main_conversation', true, 'primary')],
    ['agent_monitor', defaultPanel('agent_monitor', false, 'secondary')],
    ['task_list', defaultPanel('task_list', false, 'secondary')],
    ['tool_trace', defaultPanel('tool_trace', false, 'footer')],
    ['diff_viewer', defaultPanel('diff_viewer', false, 'secondary')],
    ['file_explorer', defaultPanel('file_explorer', false, 'sidebar')],
    ['git_status', defaultPanel('git_status', false, 'sidebar')],
    ['mcp_inspector', defaultPanel('mcp_inspector', false, 'secondary')],
    ['plugin_manager', defaultPanel('plugin_manager', false, 'secondary')],
    ['telemetry_dashboard', defaultPanel('telemetry_dashboard', false, 'secondary')],
    ['session_list', defaultPanel('session_list', false, 'sidebar')],
  ]);

  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    panels,
    focusedPanelId: 'main_conversation',
    previousFocusedPanelId: undefined,
    sidebarVisible: false,
    footerVisible: false,
    terminalColumns: 80,
    terminalRows: 24,
  };
}
