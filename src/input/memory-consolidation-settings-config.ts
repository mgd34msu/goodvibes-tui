/**
 * memory-consolidation-settings-config.ts — TUI-local synthetic settings
 * entries for `learning.consolidation.*`.
 *
 * The SDK hoisted idle-time memory consolidation (merge/decay/archive
 * proposals over standing memory records) from the agent surface to
 * `@pellux/goodvibes-sdk/platform/state` (memory-consolidation-config.ts,
 * memory-consolidation.ts) so every consumer resolves the same policy the
 * same way. Per that module's own doc comment: "The shared SDK config schema
 * has no `learning.consolidation` category, so these are read directly from
 * a user-supplied `learning` block that the ConfigManager deep-merge
 * preserves to `getRaw()`." None of the nine keys are in the SDK's
 * ConfigKey union — same situation as worktree.setup.commands
 * (worktree-setup-config.ts), which this file mirrors: a brand-new top-level
 * config section with no DEFAULT_CONFIG entry, so ConfigManager.get()/set()
 * path resolution can throw for it. Reads here go through the SDK's own
 * `resolveMemoryConsolidationConfig`, which reads `getRaw()` directly (no
 * schema path resolution, so it cannot throw the way `get()` can); writes
 * go through the settings modal's existing generic setDynamic path, which
 * already degrades a resolution failure into an honest "Save failed"
 * message (applySettingValue in settings-modal-mutations.ts) — the same
 * documented limitation the worktree synthetic entries carry.
 *
 * Off by default (`enabled: false`): the consolidation pass never runs
 * unless a user explicitly turns it on.
 */
import type { ConfigKey, ConfigManager, ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';
import {
  DEFAULT_MEMORY_CONSOLIDATION_CONFIG,
  resolveMemoryConsolidationConfig,
  type ResolvedMemoryConsolidationConfig,
} from '@pellux/goodvibes-sdk/platform/state';
import type { SettingEntry } from './settings-modal-types.ts';

const KEY_PREFIX = 'learning.consolidation.';

function key(field: keyof ResolvedMemoryConsolidationConfig): ConfigKey {
  return `${KEY_PREFIX}${field}` as ConfigKey;
}

interface FieldSpec {
  readonly field: keyof ResolvedMemoryConsolidationConfig;
  readonly type: 'boolean' | 'number';
  readonly description: string;
}

const FIELD_SPECS: readonly FieldSpec[] = [
  {
    field: 'enabled',
    type: 'boolean',
    description: 'Master switch for idle-time memory consolidation (merge duplicate records, decay/archive stale ones). Off by default — the pass never runs until explicitly enabled.',
  },
  {
    field: 'intervalMs',
    type: 'number',
    description: 'Minimum time between consolidation runs, in milliseconds. Also doubles as the schedule cadence. Default 21600000 (6 hours).',
  },
  {
    field: 'minIdleMs',
    type: 'number',
    description: 'Minimum continuous idle time required before a consolidation run starts, in milliseconds. Default 0 (no idle requirement beyond the interval).',
  },
  {
    field: 'maxMergesPerRun',
    type: 'number',
    description: 'Maximum number of duplicate record groups merged in a single consolidation run. Default 10.',
  },
  {
    field: 'maxDecaysPerRun',
    type: 'number',
    description: 'Maximum number of records decayed or archived in a single consolidation run. Default 20.',
  },
  {
    field: 'maxProposalsPerRun',
    type: 'number',
    description: 'Maximum number of proposals (merge + decay combined) emitted in a single consolidation run. Default 20.',
  },
  {
    field: 'decayAgeDays',
    type: 'number',
    description: 'Active records not referenced since this many days ago (by updatedAt) become decay candidates. Default 45.',
  },
  {
    field: 'decayConfidenceStep',
    type: 'number',
    description: 'Confidence points removed from a never-referenced decaying record on each consolidation run. Default 10.',
  },
  {
    field: 'archiveConfidenceFloor',
    type: 'number',
    description: 'A decaying record whose confidence would fall to or below this floor is archived (marked stale) instead of merely decayed further. Default 40.',
  },
];

/** All nine `learning.consolidation.*` synthetic ConfigSetting descriptors, in display order. */
export const MEMORY_CONSOLIDATION_SYNTHETIC_SETTINGS: readonly ConfigSetting[] = FIELD_SPECS.map((spec) => ({
  key: key(spec.field),
  type: spec.type,
  default: DEFAULT_MEMORY_CONSOLIDATION_CONFIG[spec.field],
  description: spec.description,
}));

const MEMORY_CONSOLIDATION_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set(
  MEMORY_CONSOLIDATION_SYNTHETIC_SETTINGS.map((s) => s.key),
);

/** True for any of the nine `learning.consolidation.*` synthetic keys. */
export function isMemoryConsolidationConfigKey(k: ConfigKey): boolean {
  return MEMORY_CONSOLIDATION_CONFIG_KEYS.has(k);
}

/** Build the nine synthetic SettingEntry rows for the learning consolidation category, reading through the SDK's own resolver. */
export function buildMemoryConsolidationSyntheticEntries(
  configManager: Pick<ConfigManager, 'getRaw'>,
): SettingEntry[] {
  let resolved: ResolvedMemoryConsolidationConfig;
  try {
    resolved = resolveMemoryConsolidationConfig(configManager);
  } catch {
    resolved = DEFAULT_MEMORY_CONSOLIDATION_CONFIG;
  }
  return FIELD_SPECS.map((spec, index) => {
    const setting = MEMORY_CONSOLIDATION_SYNTHETIC_SETTINGS[index]!;
    const currentValue = resolved[spec.field];
    return {
      setting,
      currentValue,
      isDefault: currentValue === DEFAULT_MEMORY_CONSOLIDATION_CONFIG[spec.field],
    };
  });
}
