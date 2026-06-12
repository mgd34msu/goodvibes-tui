import { existsSync, readFileSync, renameSync } from 'node:fs';

/**
 * A migration function that transforms data from version N to N+1.
 * Receives the raw parsed object and must return the upgraded object.
 */
export type VersionMigration = (data: Record<string, unknown>) => Record<string, unknown>;

export interface ReadVersionedOptions {
  /**
   * The version number this reader expects. When the file version equals
   * `currentVersion`, no migrations are run. When it is lower, migrations
   * are applied stepwise. When it is higher or unrecognised, `onUnknown`
   * behaviour fires.
   */
  readonly currentVersion: number;

  /**
   * Optional stepwise migrations indexed by the FROM version.
   * `migrations[1]` upgrades version-1 data to version-2 data.
   * Applied in ascending order until `currentVersion` is reached.
   */
  readonly migrations?: Readonly<Record<number, VersionMigration>>;

  /**
   * What to do when the file version is unrecognised (higher than
   * `currentVersion` or missing/non-numeric).
   *
   * `'quarantine'` — rename the file to `<path>.unrecognized` and return null.
   */
  readonly onUnknown: 'quarantine';
}

/**
 * Migration-aware, quarantine-on-failure versioned file reader.
 *
 * Parse flow:
 *   1. If the file does not exist → return null.
 *   2. If JSON is corrupt → quarantine to `<path>.unrecognized`, return null.
 *   3. If the version field is missing or higher than currentVersion →
 *      quarantine, return null.
 *   4. If the version is lower than currentVersion → apply stepwise migrations.
 *      If no migration exists for a version gap, or a migration throws,
 *      quarantine and return null.
 *   5. Return the (possibly migrated) object. Callers are responsible for
 *      narrowing the returned value — this helper handles versioning and
 *      corruption only, not schema validation.
 */
export function readVersioned<T extends { version: number }>(
  path: string,
  options: ReadVersionedOptions,
): T | null {
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    quarantine(path);
    return null;
  }

  if (!isPlainObject(raw)) {
    quarantine(path);
    return null;
  }

  const fileVersion = raw['version'];
  if (typeof fileVersion !== 'number' || !Number.isFinite(fileVersion)) {
    quarantine(path);
    return null;
  }

  if (fileVersion > options.currentVersion) {
    // Produced by a newer process — quarantine rather than corrupt.
    quarantine(path);
    return null;
  }

  let data: Record<string, unknown> = raw;

  if (fileVersion < options.currentVersion) {
    const migrations = options.migrations ?? {};
    for (let v = fileVersion; v < options.currentVersion; v++) {
      const migrate = migrations[v];
      if (!migrate) {
        // No migration path for this version gap — quarantine.
        quarantine(path);
        return null;
      }
      try {
        data = migrate(data);
      } catch {
        quarantine(path);
        return null;
      }
    }
  }

  return data as T;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quarantine(path: string): void {
  try {
    renameSync(path, `${path}.unrecognized`);
  } catch {
    // Best-effort — if rename fails (e.g. race), proceed silently.
  }
}
