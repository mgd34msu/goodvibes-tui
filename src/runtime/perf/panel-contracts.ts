/**
 * Panel resource contracts — per-panel CPU/IO/update budget definitions.
 *
 * Each panel declares a resource contract describing its acceptable update
 * rate and render cost. The PanelHealthMonitor enforces these contracts at
 * runtime, throttling or degrading panels that exceed their budgets.
 */

/** Throttle status for a panel. */
export type PanelThrottleStatus = 'normal' | 'throttled' | 'degraded';

/** Health of a single panel based on contract compliance. */
export type PanelHealthStatus = 'healthy' | 'warning' | 'overloaded';

/**
 * Resource contract for a single panel.
 *
 * Defines the maximum acceptable update rate and render cost budget.
 * Violations trigger throttling; sustained violations trigger degradation.
 */
export interface PanelResourceContract {
  /** Panel id this contract applies to. */
  panelId: string;

  /**
   * Maximum updates per second the panel is allowed to request.
   * Panels that exceed this rate are throttled.
   */
  maxUpdatesPerSecond: number;

  /**
   * Maximum acceptable render duration in milliseconds (p95).
   * Panels that consistently exceed this are degraded.
   */
  maxRenderMs: number;

  /**
   * Minimum interval in milliseconds between renders when throttled.
   * The monitor enforces this floor when the panel exceeds its update rate.
   */
  throttleIntervalMs: number;

  /**
   * Number of consecutive budget violations before moving to 'degraded' status.
   * Degraded panels render at a fixed reduced rate regardless of update requests.
   */
  degradeAfterViolations: number;

  /**
   * Fixed render interval in milliseconds when the panel is degraded.
   * Replaces throttleIntervalMs for severely overloaded panels.
   */
  degradedIntervalMs: number;
}

/**
 * Live health state for a single panel, maintained by the PanelHealthMonitor.
 */
export interface PanelHealthState {
  /** Panel id. */
  panelId: string;

  /** Current throttle status. */
  throttleStatus: PanelThrottleStatus;

  /** Current health status. */
  healthStatus: PanelHealthStatus;

  /** Observed render count over the last measurement window. */
  rendersInWindow: number;

  /** p95 render duration in ms over the last measurement window. */
  renderP95Ms: number;

  /** Number of consecutive contract violations (update rate or render cost). */
  consecutiveViolations: number;

  /** Epoch ms when the panel was last allowed to render. */
  lastRenderAt: number;

  /** Epoch ms of next allowed render (0 = no restriction). */
  nextAllowedAt: number;

  /** Total renders suppressed due to throttle or degradation since monitor start. */
  totalSuppressed: number;

  /** Total renders permitted since monitor start. */
  totalPermitted: number;
}

/**
 * Default resource contracts by panel category.
 *
 * Panels without an explicit contract inherit from their category default.
 * Active/interactive panels get more generous budgets; monitoring panels
 * are throttled aggressively to prevent render storms.
 */
export const CATEGORY_CONTRACTS: Record<string, Omit<PanelResourceContract, 'panelId'>> = {
  development: {
    maxUpdatesPerSecond: 10,
    maxRenderMs: 20,
    throttleIntervalMs: 100,
    degradeAfterViolations: 5,
    degradedIntervalMs: 500,
  },
  agent: {
    maxUpdatesPerSecond: 5,
    maxRenderMs: 30,
    throttleIntervalMs: 200,
    degradeAfterViolations: 5,
    degradedIntervalMs: 1000,
  },
  monitoring: {
    maxUpdatesPerSecond: 2,
    maxRenderMs: 50,
    throttleIntervalMs: 500,
    degradeAfterViolations: 3,
    degradedIntervalMs: 2000,
  },
  session: {
    maxUpdatesPerSecond: 4,
    maxRenderMs: 25,
    throttleIntervalMs: 250,
    degradeAfterViolations: 5,
    degradedIntervalMs: 1000,
  },
  ai: {
    maxUpdatesPerSecond: 8,
    maxRenderMs: 20,
    throttleIntervalMs: 125,
    degradeAfterViolations: 5,
    degradedIntervalMs: 500,
  },
  /** Fallback for unrecognised categories. */
  default: {
    maxUpdatesPerSecond: 5,
    maxRenderMs: 30,
    throttleIntervalMs: 200,
    degradeAfterViolations: 5,
    degradedIntervalMs: 1000,
  },
};

/**
 * Build a PanelResourceContract for a panel, merging category defaults
 * with any per-panel overrides.
 *
 * @param panelId - The panel's unique id.
 * @param category - The panel's category (used to select the base contract).
 * @param overrides - Optional per-panel overrides applied on top of the category contract.
 */
export function buildContract(
  panelId: string,
  category: string,
  overrides?: Partial<Omit<PanelResourceContract, 'panelId'>>,
): PanelResourceContract {
  const base = CATEGORY_CONTRACTS[category] ?? CATEGORY_CONTRACTS['default']!;
  return {
    panelId,
    ...base,
    ...overrides,
  };
}

/**
 * Create an initial (clean) PanelHealthState for a panel.
 */
export function createInitialPanelHealthState(panelId: string): PanelHealthState {
  return {
    panelId,
    throttleStatus: 'normal',
    healthStatus: 'healthy',
    rendersInWindow: 0,
    renderP95Ms: 0,
    consecutiveViolations: 0,
    lastRenderAt: 0,
    nextAllowedAt: 0,
    totalSuppressed: 0,
    totalPermitted: 0,
  };
}
