import { CONFIG_SCHEMA, type ConfigKey } from '../config/index.ts';
import type { ProfileData } from '@pellux/goodvibes-sdk/platform/profiles/manager';

function setNestedValue(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current: Record<string, unknown> = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const existing = current[segment];
    if (!existing || typeof existing !== 'object') {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = structuredClone(value);
}

function getNestedValue(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function configSnapshotToProfileData(snapshot: Record<string, unknown>): ProfileData {
  const profile: Record<string, unknown> = {};
  for (const entry of CONFIG_SCHEMA) {
    if (
      !entry.key.startsWith('display.')
      && !entry.key.startsWith('provider.')
      && !entry.key.startsWith('behavior.')
    ) {
      continue;
    }
    const value = snapshot[entry.key];
    if (value !== undefined) {
      setNestedValue(profile, entry.key.split('.'), value);
    }
  }
  return profile as ProfileData;
}

export function profileDataToConfigSnapshot(data: ProfileData): Partial<Record<ConfigKey, unknown>> {
  const snapshot: Partial<Record<ConfigKey, unknown>> = {};
  for (const entry of CONFIG_SCHEMA) {
    if (
      !entry.key.startsWith('display.')
      && !entry.key.startsWith('provider.')
      && !entry.key.startsWith('behavior.')
    ) {
      continue;
    }
    const value = getNestedValue(data, entry.key.split('.'));
    if (value !== undefined) snapshot[entry.key] = structuredClone(value);
  }
  return snapshot;
}
