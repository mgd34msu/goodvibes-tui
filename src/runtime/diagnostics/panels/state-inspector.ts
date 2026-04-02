/**
 * State Inspector diagnostic panel data provider.
 *
 * Produces on-demand snapshots of the runtime store's domain states.
 * Implements the "Live domain state viewer" and "Raw state mode" from
 * v3 Section 26 (Devtools / State Inspector).
 *
 * All domains are serialized to JSON-safe plain objects at snapshot time.
 * Maps and Sets are converted to arrays; circular references are replaced
 * with a sentinel string.
 */
import type { RuntimeStateSnapshot, DomainStateEntry } from '../types.ts';

/**
 * Minimal interface for a domain state slice used by the inspector.
 * Each domain registered with the store should conform to this shape.
 */
export interface InspectableDomain {
  /** Domain name identifier. */
  readonly name: string;
  /** Retrieve the current domain state as a plain object. */
  getState(): Record<string, unknown>;
  /** The revision counter from the domain state. */
  getRevision(): number;
  /** The lastUpdatedAt timestamp from the domain state. */
  getLastUpdatedAt(): number;
}

/**
 * Serialize a value to a JSON-safe plain object, converting Maps/Sets to arrays
 * and replacing circular references with a sentinel.
 *
 * @param value - Value to serialize.
 * @param seen - WeakSet tracking seen objects to detect cycles.
 * @returns A JSON-safe representation.
 */
function serializeSafe(value: unknown, seen = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (value instanceof Map) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      result[String(k)] = serializeSafe(v, seen);
    }
    return result;
  }

  if (value instanceof Set) {
    return [...value].map((v) => serializeSafe(v, seen));
  }

  if (Array.isArray(value)) {
    return value.map((v) => serializeSafe(v, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = serializeSafe(v, seen);
  }
  return result;
}

/**
 * StateInspectorPanel — on-demand runtime state snapshot provider.
 *
 * Domains are registered at construction time. Call `getSnapshot()` to
 * capture the current state of all registered domains.
 *
 * Unlike event-driven panels, this panel does not maintain an internal
 * buffer — each `getSnapshot()` call produces a fresh snapshot.
 */
export class StateInspectorPanel {
  private readonly _domains: InspectableDomain[];
  /** Registered change notification callbacks. */
  private readonly _subscribers = new Set<() => void>();

  /**
   * @param domains - Array of domain adapters to inspect.
   */
  constructor(domains: InspectableDomain[] = []) {
    this._domains = domains;
  }

  /**
   * Register an additional domain for inspection after construction.
   *
   * @param domain - Domain adapter to add.
   */
  public registerDomain(domain: InspectableDomain): void {
    this._domains.push(domain);
    this._notify();
  }

  /**
   * Capture a point-in-time snapshot of all registered domains.
   * Maps and Sets in the state are converted to plain objects/arrays.
   *
   * @returns An immutable RuntimeStateSnapshot.
   */
  public getSnapshot(): RuntimeStateSnapshot {
    const entries: DomainStateEntry[] = this._domains.map((domain) => ({
      domain: domain.name,
      revision: domain.getRevision(),
      lastUpdatedAt: domain.getLastUpdatedAt(),
      state: serializeSafe(domain.getState()) as Record<string, unknown>,
    }));

    return {
      capturedAt: Date.now(),
      domains: entries,
    };
  }

  /**
   * Register a callback invoked when the domain registry changes.
   * Note: callbacks are NOT invoked on every state mutation — call
   * `getSnapshot()` on demand to retrieve current state.
   *
   * @returns An unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch {
        // Non-fatal: subscriber errors must not crash the provider
      }
    }
  }
}
