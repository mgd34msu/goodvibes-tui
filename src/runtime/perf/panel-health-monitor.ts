/**
 * PanelHealthMonitor — enforces per-panel resource contracts.
 *
 * Tracks update rate and render cost per panel. Panels that exceed their
 * contracted budget are throttled (render gated to a minimum interval).
 * Panels with sustained violations are degraded (rendered at a fixed low rate).
 *
 * The monitor does NOT render panels itself — callers ask canRender() before
 * rendering and report the actual render cost via recordRender().
 *
 * This keeps the monitor policy-focused and the rendering path ignorant of
 * throttling policy details.
 */

import type { PanelResourceContract, PanelHealthState } from './panel-contracts.ts';
import {
  CATEGORY_CONTRACTS,
  buildContract,
  createInitialPanelHealthState,
} from './panel-contracts.ts';

/** Measurement window for update-rate enforcement (ms). */
const RATE_WINDOW_MS = 1000;

/** Number of recent render durations to keep for p95 calculation. */
const RENDER_SAMPLE_CAPACITY = 20;

/** Ring buffer for render duration samples. */
interface RingBuffer {
  buf: number[];
  head: number;
  size: number;
}

/** Recovery: violations reset to 0 after this many consecutive clean windows. */
const RECOVERY_CLEAN_WINDOWS = 3;

/** Internal per-panel tracking state (not externally visible). */
interface PanelTrack {
  contract: PanelResourceContract;
  health: PanelHealthState;
  /** Ring buffer of recent render durations (ms). */
  renderSamples: RingBuffer;
  /** Epoch ms timestamps of render requests in the current window. */
  windowRequests: number[];
  /** Number of consecutive clean measurement windows (no violations). */
  cleanWindows: number;
  /** Start of the current measurement window. */
  windowStart: number;
}

/**
 * PanelHealthMonitor — tracks panel resource usage and enforces budgets.
 *
 * Usage:
 * 1. Register panels with register(panelId, category).
 * 2. Before rendering: if (!monitor.canRender(panelId, now)) skip the render.
 * 3. After rendering: monitor.recordRender(panelId, durationMs, now).
 * 4. Read health via getHealth(panelId) or getAllHealth().
 */
export class PanelHealthMonitor {
  private readonly _tracks: Map<string, PanelTrack> = new Map();

  /**
   * Register a panel with the monitor.
   *
   * If the panel is already registered, this is a no-op.
   *
   * @param panelId - Unique panel identifier.
   * @param category - Panel category (used to select the base contract).
   * @param contractOverrides - Optional per-panel contract overrides.
   */
  register(
    panelId: string,
    category: string,
    contractOverrides?: Partial<Omit<PanelResourceContract, 'panelId'>>,
  ): void {
    if (this._tracks.has(panelId)) return;

    const contract = buildContract(panelId, category, contractOverrides);
    const health = createInitialPanelHealthState(panelId);

    this._tracks.set(panelId, {
      contract,
      health,
      renderSamples: { buf: new Array(RENDER_SAMPLE_CAPACITY), head: 0, size: 0 },
      windowRequests: [],
      cleanWindows: 0,
      windowStart: 0,
    });
  }

  /**
   * Deregister a panel, removing all tracking state.
   */
  deregister(panelId: string): void {
    this._tracks.delete(panelId);
  }

  /**
   * Check whether a panel is permitted to render at the given time.
   *
   * Records the render request for rate tracking regardless of the outcome.
   * If the panel is not registered, renders are always permitted.
   *
   * @param panelId - Panel to check.
   * @param now - Current epoch ms (defaults to Date.now()).
   * @returns true if the render is permitted; false if it should be skipped.
   */
  canRender(panelId: string, now: number = Date.now()): boolean {
    const track = this._tracks.get(panelId);
    if (!track) return true; // unregistered panels are always permitted

    // Rotate the measurement window if needed
    this._rotateWindow(track, now);

    // Gate on throttle/degrade interval
    if (now < track.health.nextAllowedAt) {
      track.health.totalSuppressed++;
      return false;
    }

    // Record this request in the current window
    track.windowRequests.push(now);

    // Check update rate limit
    let requestsInWindow = 0;
    for (const t of track.windowRequests) {
      if (now - t < RATE_WINDOW_MS) requestsInWindow++;
    }
    // Note: stale entries older than RATE_WINDOW_MS are pruned at window rotation, not here
    const maxPerWindow = track.contract.maxUpdatesPerSecond;

    if (requestsInWindow > maxPerWindow) {
      // Rate exceeded: throttle or degrade
      this._applyViolation(track, now);
      track.health.totalSuppressed++;
      return false;
    }

    track.health.totalPermitted++;
    return true;
  }

  /**
   * Record the actual render duration for a panel.
   *
   * Should be called after every permitted render completes. Updates the
   * p95 render cost and may escalate the panel's throttle status if the
   * render cost budget is violated.
   *
   * @param panelId - Panel that rendered.
   * @param durationMs - Actual render duration in milliseconds.
   * @param now - Epoch ms at render completion (defaults to Date.now()).
   */
  recordRender(panelId: string, durationMs: number, now: number = Date.now()): void {
    const track = this._tracks.get(panelId);
    if (!track) return;

    // Add sample to ring buffer (O(1) modular index — no shift/realloc)
    const rb = track.renderSamples;
    rb.buf[rb.head] = durationMs;
    rb.head = (rb.head + 1) % RENDER_SAMPLE_CAPACITY;
    if (rb.size < RENDER_SAMPLE_CAPACITY) rb.size++;

    // Update p95
    const samples = rb.buf.slice(0, rb.size);
    samples.sort((a, b) => a - b); // sort in-place, no second copy
    const p95Val = samples[Math.ceil(samples.length * 0.95) - 1] ?? 0;
    track.health.renderP95Ms = p95Val;
    track.health.lastRenderAt = now;
    track.health.rendersInWindow++;

    // Check render cost budget
    if (track.health.renderP95Ms > track.contract.maxRenderMs) {
      this._applyViolation(track, now);
    } else {
      // Render cost within budget — count as a clean observation
      this._recordClean(track);
    }
  }

  /**
   * Return the current health state for a panel, or undefined if not registered.
   */
  getHealth(panelId: string): PanelHealthState | undefined {
    return this._tracks.get(panelId)?.health;
  }

  /**
   * Return health states for all registered panels.
   */
  getAllHealth(): PanelHealthState[] {
    return Array.from(this._tracks.values()).map((t) => ({ ...t.health }));
  }

  /**
   * Return the resource contract for a registered panel, or undefined.
   */
  getContract(panelId: string): PanelResourceContract | undefined {
    return this._tracks.get(panelId)?.contract;
  }

  /**
   * Forcibly reset a panel's health state to normal.
   * Useful for tests or manual operator intervention.
   */
  resetHealth(panelId: string): void {
    const track = this._tracks.get(panelId);
    if (!track) return;
    track.health = createInitialPanelHealthState(panelId);
    track.renderSamples = { buf: new Array(RENDER_SAMPLE_CAPACITY), head: 0, size: 0 };
    track.windowRequests = [];
    track.cleanWindows = 0;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _rotateWindow(track: PanelTrack, now: number): void {
    if (track.windowStart === 0) {
      track.windowStart = now;
      return;
    }
    if (now - track.windowStart >= RATE_WINDOW_MS) {
      // Check for recovery
      let requestsLastWindow = 0;
      for (const t of track.windowRequests) {
        if (t >= track.windowStart && t < track.windowStart + RATE_WINDOW_MS) requestsLastWindow++;
      }
      const withinBudget = requestsLastWindow <= track.contract.maxUpdatesPerSecond;
      if (withinBudget) {
        track.cleanWindows++;
        if (track.cleanWindows >= RECOVERY_CLEAN_WINDOWS) {
          this._recover(track);
        }
      } else {
        track.cleanWindows = 0;
      }
      // Discard old requests
      track.windowRequests = track.windowRequests.filter((t) => now - t < RATE_WINDOW_MS);
      track.windowStart = now;
      track.health.rendersInWindow = 0;
    }
  }

  private _applyViolation(track: PanelTrack, now: number): void {
    track.health.consecutiveViolations++;
    track.cleanWindows = 0;

    if (track.health.consecutiveViolations >= track.contract.degradeAfterViolations) {
      // Escalate to degraded
      track.health.throttleStatus = 'degraded';
      track.health.healthStatus = 'overloaded';
      track.health.nextAllowedAt = now + track.contract.degradedIntervalMs;
    } else {
      // Apply standard throttle
      track.health.throttleStatus = 'throttled';
      track.health.healthStatus = 'warning';
      track.health.nextAllowedAt = now + track.contract.throttleIntervalMs;
    }
  }

  /**
   * Dual-path recovery: `_recordClean` handles render-cost-based recovery
   * (triggered from `recordRender` after a cheap render), while `_rotateWindow`
   * handles rate-based recovery (triggered at window boundaries). Both paths
   * call `_recover` once the clean-window threshold is met, so either signal
   * alone is sufficient to restore a panel to normal status.
   */
  private _recordClean(track: PanelTrack): void {
    // Only advance recovery if we're already throttled/degraded
    if (track.health.throttleStatus === 'normal') return;
    track.cleanWindows++;
    if (track.cleanWindows >= RECOVERY_CLEAN_WINDOWS) {
      this._recover(track);
    }
  }

  private _recover(track: PanelTrack): void {
    track.health.throttleStatus = 'normal';
    track.health.healthStatus = 'healthy';
    track.health.consecutiveViolations = 0;
    track.health.nextAllowedAt = 0;
    track.cleanWindows = 0;
  }
}
