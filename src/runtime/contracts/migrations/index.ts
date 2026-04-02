/**
 * Compatibility Contracts — Migration Registry
 *
 * The MigrationRegistry holds all registered schema migration steps and
 * provides path resolution and ordered execution for any version pair.
 *
 * @module contracts/migrations
 */

import {
  type MigrationStep,
  type MigrationResult,
  type SchemaVersion,
  compareVersions,
  versionsEqual,
  versionToString,
} from '../types.ts';

/**
 * Central registry for all schema migration steps.
 *
 * Migrations are registered per contract name and resolved as an ordered
 * chain from a given source version to the current target version.
 * All migration functions must be pure (no mutations, no side effects).
 */
export class MigrationRegistry {
  private readonly steps = new Map<string, MigrationStep[]>();

  /**
   * Registers a migration step for a given contract.
   *
   * Steps are stored in insertion order and sorted at resolution time.
   * Duplicate from→to pairs for the same contract are not permitted.
   *
   * @param contract - The contract name (e.g. 'runtimeState').
   * @param step - The migration step to register.
   * @throws If a step with the same from→to is already registered.
   */
  register(contract: string, step: MigrationStep): void {
    if (!this.steps.has(contract)) {
      this.steps.set(contract, []);
    }
    const existing = this.steps.get(contract)!;
    const duplicate = existing.find(
      (s) => versionsEqual(s.from, step.from) && versionsEqual(s.to, step.to),
    );
    if (duplicate) {
      throw new Error(
        `Duplicate migration step for contract '${contract}': ` +
          `${versionToString(step.from)} → ${versionToString(step.to)}`,
      );
    }
    existing.push(step);
  }

  /**
   * Returns true if any migration path exists from `fromVersion` toward
   * a higher version for the given contract.
   *
   * @param contract - The contract name.
   * @param fromVersion - The source schema version to migrate from.
   */
  canMigrate(contract: string, fromVersion: SchemaVersion): boolean {
    const steps = this.steps.get(contract) ?? [];
    return steps.some((s) => versionsEqual(s.from, fromVersion));
  }

  /**
   * Resolves an ordered chain of migration steps from `from` to `to`.
   *
   * Uses a greedy forward walk: at each version, finds the step that advances
   * closest to the target. Throws if no complete path exists.
   *
   * @param contract - The contract name.
   * @param from - The starting schema version.
   * @param to - The target schema version.
   * @returns Ordered array of MigrationSteps forming the complete path.
   * @throws If no migration path exists between the two versions.
   */
  getMigrationPath(
    contract: string,
    from: SchemaVersion,
    to: SchemaVersion,
  ): MigrationStep[] {
    if (versionsEqual(from, to)) return [];

    if (compareVersions(from, to) > 0) {
      throw new Error(
        `Downgrade migration is not supported for contract '${contract}': ` +
          `cannot migrate from ${versionToString(from)} to ${versionToString(to)}`,
      );
    }

    const allSteps = this.steps.get(contract) ?? [];
    const path: MigrationStep[] = [];
    let current = from;

    while (!versionsEqual(current, to)) {
      // Find all steps that start from the current version
      const candidates = allSteps.filter((s) => versionsEqual(s.from, current));
      if (candidates.length === 0) {
        throw new Error(
          `No migration step found for contract '${contract}' ` +
            `at version ${versionToString(current)} (target: ${versionToString(to)})`,
        );
      }
      // Pick the step that advances closest to the target without overshooting
      const step = candidates.reduce((best, candidate) => {
        const cmpBest = compareVersions(best.to, to);
        const cmpCandidate = compareVersions(candidate.to, to);
        // Prefer steps that don't overshoot; among those, prefer the one closest to target
        if (cmpBest > 0 && cmpCandidate <= 0) return candidate;
        if (cmpCandidate > 0 && cmpBest <= 0) return best;
        return compareVersions(candidate.to, best.to) > 0 ? candidate : best;
      });

      if (compareVersions(step.to, current) <= 0) {
        throw new Error(
          `Migration step for contract '${contract}' does not advance version: ` +
            `${versionToString(step.from)} → ${versionToString(step.to)}`,
        );
      }

      path.push(step);
      current = step.to;

      if (path.length > 100) {
        throw new Error(
          `Migration path for contract '${contract}' exceeded 100 steps — possible cycle detected`,
        );
      }
    }

    return path;
  }

  /**
   * Migrates data from `fromVersion` to the latest version reachable via
   * registered steps for the given contract.
   *
   * If `fromVersion` already matches the end of the migration chain,
   * the data is returned as-is without transformation.
   *
   * @param contract - The contract name.
   * @param data - The raw data to migrate.
   * @param fromVersion - The schema version of the incoming data.
   * @returns The migrated data and the version it was migrated to.
   * @throws If the migration path is incomplete or a step throws.
   */
  migrate(
    contract: string,
    data: unknown,
    fromVersion: SchemaVersion,
  ): MigrationResult {
    // Find the highest reachable version from this starting point
    const targetVersion = this._resolveLatestVersion(contract, fromVersion);

    if (versionsEqual(fromVersion, targetVersion)) {
      return { data, version: fromVersion };
    }

    const path = this.getMigrationPath(contract, fromVersion, targetVersion);
    let current = data;
    for (const step of path) {
      current = step.migrate(current);
    }

    return { data: current, version: targetVersion };
  }

  /**
   * Resolves the highest version reachable from `fromVersion` by following
   * the chain of registered steps.
   */
  private _resolveLatestVersion(
    contract: string,
    fromVersion: SchemaVersion,
  ): SchemaVersion {
    const allSteps = this.steps.get(contract) ?? [];
    let current = fromVersion;
    const visited = new Set<string>();

    while (true) {
      const key = versionToString(current);
      if (visited.has(key)) break;
      visited.add(key);

      const next = allSteps
        .filter((s) => versionsEqual(s.from, current))
        .sort((a, b) => compareVersions(b.to, a.to))[0];

      if (!next) break;
      current = next.to;
    }

    return current;
  }

  /**
   * Returns all registered contract names.
   */
  contractNames(): string[] {
    return [...this.steps.keys()];
  }
}
