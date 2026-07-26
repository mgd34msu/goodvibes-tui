import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_SCHEMA } from '@pellux/goodvibes-sdk/platform/config';
import { FEATURE_SETTINGS } from '@pellux/goodvibes-sdk/platform/runtime/state';
import { featureEnablementWrite } from '../runtime/feature-settings.ts';
import { CommandRegistry } from '../input/command-registry.ts';
import { registerBuiltinCommands } from '../input/commands.ts';

export interface VerificationLedgerArea {
  readonly area: string;
  readonly total: number;
  readonly localSignalVerified: number;
  readonly localBehaviorVerified: number;
  readonly externalOutcomeRequired: number;
  readonly notes: string;
}

export interface VerificationLedger {
  readonly generatedAt: string;
  readonly areas: readonly VerificationLedgerArea[];
  readonly totals: {
    readonly total: number;
    readonly localSignalVerified: number;
    readonly localBehaviorVerified: number;
    readonly externalOutcomeRequired: number;
    readonly localSignalPercent: number;
    readonly localBehaviorPercent: number;
  };
}

/**
 * Baseline count of `Settings schema and persistence` items with real local
 * behavior verification, as measured when this ledger was first authored. New
 * schema keys added since then are accounted for explicitly (see
 * FEATURE_KNOB_LOCAL_SETTINGS) rather than folded into this number, so the
 * baseline stays an auditable fixed point.
 */
const SETTINGS_BEHAVIOR_BASELINE = 184;

/**
 * Config keys promoted into CONFIG_SCHEMA for the flag-gated feature knobs
 * (SDK commit f5c4af31, "config: add schema keys for flag-gated feature
 * knobs"). Adding these 28 keys raised the settings inventory `total` without a
 * matching rise in behavior-verified coverage, which dropped
 * `localBehaviorPercent` below its floor. Each key is a local, non-external
 * setting whose full persistence behavior — schema default, set → write →
 * reload round-trip, and reset-to-default — is exercised by
 * `src/test/verification/feature-knob-settings-persistence.test.ts`. They are
 * therefore genuinely behavior-verified locally and counted as such here.
 */
export const FEATURE_KNOB_LOCAL_SETTINGS = [
  'provider.optimizerMode',
  'provider.optimizerPinnedModel',
  'permissions.divergenceThreshold',
  'permissions.maxDivergenceRecords',
  'tools.overflowSpillBackend',
  'notifications.burstWindowMs',
  'notifications.burstThreshold',
  'notifications.burstCooldownMs',
  'fetch.sanitizeMode',
  'fetch.trustedHosts',
  'fetch.blockedHosts',
  'security.tokenAudit.rotationCadenceDays',
  'security.tokenAudit.rotationWarningDays',
  'security.tokenAudit.managed',
  'integrations.delivery.maxRetries',
  'integrations.delivery.initialDelayMs',
  'integrations.delivery.maxDelayMs',
  'integrations.delivery.maxDlqSize',
  'integrations.delivery.sloEnforced',
  'policy.bundleSource',
  'policy.bundlePath',
  'agents.passiveInjection.budgetTokens',
  'agents.passiveInjection.relevanceFloor',
  'agents.passiveInjection.codeLimit',
  'agents.contextCompactThreshold',
  'runtime.toolBudget.maxMs',
  'runtime.toolBudget.maxTokens',
  'runtime.toolBudget.maxCostUsd',
] as const;

/**
 * Config keys added by the paired-device and trigger-family domains in SDK
 * 1.14.0. Like FEATURE_KNOB_LOCAL_SETTINGS above, these arrived as new
 * CONFIG_SCHEMA entries that raised the settings inventory `total` with no
 * matching behavior coverage, dropping `localBehaviorPercent` below its floor.
 *
 * THIS CONSTANT IS NOT A DIAL. Each key below is counted because a test that
 * exercises it was actually written:
 * `src/test/verification/device-and-trigger-settings-persistence.test.ts` runs,
 * for every key in this list, the same four-part persistence contract the
 * feature-knob keys are counted for — schema default exposure, `set()` through
 * the key's own validator to disk, reload into a fresh ConfigManager with
 * read-back equality, and reset-to-default that also survives reload. That test
 * additionally asserts this list is exactly the non-enablement key set of both
 * domains and overlaps neither of the other counted sets, so nothing here is
 * double-counted and nothing drifts in uncounted.
 *
 * PER-KEY EVIDENCE — what is verified, and how live the key is TODAY.
 * "persistence" below means the four-part contract above; the second column
 * records whether anything in this tree (TUI or the pinned SDK) reads the key,
 * audited by tracing each key to its consumers.
 *
 *   watchers.triggers.backoffLadderMs        persistence · live (trigger supervisor retry ladder)
 *   watchers.triggers.breakerStrikes         persistence · live (strike breaker)
 *   watchers.triggers.defaultCheckIntervalMs persistence · live (condition-check scheduler)
 *   watchers.triggers.probeTimeoutMs         persistence · live (probe execution)
 *   watchers.triggers.maxConcurrentChecks    persistence · live (check concurrency cap)
 *   watchers.triggers.observationRingSize    persistence · live (observation ring)
 *   watchers.triggers.runHistoryLimit        persistence · live (run history retention)
 *   watchers.triggers.runHistoryTtlHours     persistence · live (run history sweep)
 *   watchers.triggers.eventLogLimit          persistence · live (event log retention)
 *   watchers.triggers.eventLogTtlHours       persistence · live (event log sweep)
 *   watchers.triggers.sweepIntervalMs        persistence · live (housekeeping cadence)
 *   watchers.triggers.supervisionTickMs      persistence · live (supervision loop tick)
 *   watchers.triggers.streamQueueLimit       persistence · live (stream watcher queue)
 *   watchers.triggers.streamBatchLines       persistence · live (stream batching)
 *   watchers.triggers.streamBatchIntervalMs  persistence · live (stream batching)
 *   watchers.triggers.onExitMaxDurationMs    persistence · live (on-exit trigger duration cap)
 *   watchers.triggers.onExitStdin            persistence · live (on-exit stdin posture)
 *   watchers.triggers.outputTailBytes        persistence · live (captured output tail)
 *   device.capabilities.allowAlwaysOffer     persistence · settings surface only in this build
 *   device.capabilities.requestTimeoutSeconds persistence · settings surface only in this build
 *   device.location.precision                persistence · settings surface only in this build
 *   device.clipboard.readMode                persistence · settings surface only in this build
 *   device.capture.retentionHours            persistence · settings surface only in this build
 *   device.capture.maxArtifacts              persistence · settings surface only in this build
 *   device.capture.sweepIntervalMinutes      persistence · settings surface only in this build
 *   device.grants.expiryDays                 persistence · settings surface only in this build
 *   device.grants.maxPerNode                 persistence · settings surface only in this build
 *   device.grants.auditRetentionDays         persistence · settings surface only in this build
 *   device.nodes.maxPaired                   persistence · live (enforced at the pairing path)
 *
 * On `device.nodes.maxPaired`: the SDK enforces it where a device pairs —
 * PairingTokenManager.mint refuses a NEW node at the cap with
 * PairingLimitReachedError (code DEVICE_NODES_MAX_PAIRED, carrying the setting
 * name, the cap and the live count), mapped to HTTP 409 by the pairing and
 * pairing-handoff routes. An already-paired node supersedes its own record
 * instead of being refused, migration mints off the legacy shared token are
 * deliberately exempt, lowering the cap unpairs nobody, and a non-positive or
 * non-finite value reads as no cap so a broken setting cannot lock the owner
 * out. The cap is read per mint, so a change applies without a restart. What is
 * counted HERE is still only the persistence contract this repo's test
 * exercises — the enforcement itself is SDK-side and SDK-tested, and is recorded
 * in this column so the "how live is it" audit stays accurate, not to claim
 * coverage this repo did not write.
 *
 * On the other ten `device.*` rows: DeviceCapabilityService carries its own
 * policy struct whose defaults match those keys one for one, and names them in
 * its field comments and refusal messages, but no code path in either tree maps
 * configuration into that struct. Persistence is therefore the whole of what is
 * verified for them, and the settings-workspace description for the `device`
 * category says exactly that to the user rather than implying live knobs.
 *
 * DELIBERATELY NOT COUNTED: the 24 non-enablement `voice.wake.*` keys from the
 * same release. `wake-word-detection` is declared `notOperable` — no surface
 * captures audio — so its rows stay in `total` and out of the numerator. That is
 * the honest reading, and it is why this list raises coverage by 29 and not 53.
 */
export const DEVICE_AND_TRIGGER_LOCAL_SETTINGS = [
  'watchers.triggers.backoffLadderMs',
  'watchers.triggers.breakerStrikes',
  'watchers.triggers.defaultCheckIntervalMs',
  'watchers.triggers.probeTimeoutMs',
  'watchers.triggers.maxConcurrentChecks',
  'watchers.triggers.observationRingSize',
  'watchers.triggers.runHistoryLimit',
  'watchers.triggers.runHistoryTtlHours',
  'watchers.triggers.eventLogLimit',
  'watchers.triggers.eventLogTtlHours',
  'watchers.triggers.sweepIntervalMs',
  'watchers.triggers.supervisionTickMs',
  'watchers.triggers.streamQueueLimit',
  'watchers.triggers.streamBatchLines',
  'watchers.triggers.streamBatchIntervalMs',
  'watchers.triggers.onExitMaxDurationMs',
  'watchers.triggers.onExitStdin',
  'watchers.triggers.outputTailBytes',
  'device.capabilities.allowAlwaysOffer',
  'device.capabilities.requestTimeoutSeconds',
  'device.location.precision',
  'device.clipboard.readMode',
  'device.capture.retentionHours',
  'device.capture.maxArtifacts',
  'device.capture.sweepIntervalMinutes',
  'device.grants.expiryDays',
  'device.grants.maxPerNode',
  'device.grants.auditRetentionDays',
  'device.nodes.maxPaired',
] as const;

/**
 * Every feature's enablement settings key whose on/off writes round-trip
 * through a REAL on-disk ConfigManager in
 * `src/test/verification/../input/settings-modal-flag-persistence.test.ts`
 * ("every feature with an off position round-trips both directions"). These
 * are first-class schema keys under the dissolved feature model, so they are
 * genuinely behavior-verified locally. Keys already counted in the
 * feature-knob list are excluded to keep the sum honest.
 */
const ENABLEMENT_KEYS_BEHAVIOR_VERIFIED = new Set(
  FEATURE_SETTINGS
    .filter((feature) => featureEnablementWrite(feature.id, true) !== null && featureEnablementWrite(feature.id, false) !== null)
    .map((feature) => feature.enablement.key)
    .filter((key) => !(FEATURE_KNOB_LOCAL_SETTINGS as readonly string[]).includes(key)),
).size;

/** Settings with real local behavior verification: the authored baseline plus the persistence-tested feature-knob, device/trigger, and enablement keys. */
/**
 * Config keys added by the LAN group-key layer: the automatic group-key
 * rotation interval, the dual-generation acceptance window around a rotation,
 * the discovery beacon interval, and the roster gossip interval.
 *
 * THIS CONSTANT IS NOT A DIAL, for the same reason as the two above. Each key
 * is counted because a test that exercises it was actually written:
 * `src/test/verification/cluster-group-settings-persistence.test.ts` runs the
 * same four-part persistence contract — schema default exposure, `set()`
 * through the key's own validator to disk, reload into a fresh ConfigManager
 * with read-back equality, and reset-to-default that survives reload.
 *
 * PER-KEY EVIDENCE. All four have a LIVE consumer in this build, which is more
 * than several of the keys counted above can claim:
 *   cluster.keyRotationHours        — read by resolveClusterGroupSettings and
 *                                     compared against the current key's age in
 *                                     the group runtime's rotation check.
 *   cluster.keyRotationGraceMinutes — sets how long the previous generation
 *                                     stays accepted after a scheduled
 *                                     rotation; drives the keyring's accepted
 *                                     generation set.
 *   cluster.beaconSeconds           — the discovery beacon timer interval, and
 *                                     the basis of the "recently heard from"
 *                                     window that decides which member mints a
 *                                     rotation.
 *   cluster.rosterGossipSeconds     — how often the member list is shared.
 *
 * `cluster.enabled` is NOT here: it is a feature enablement key and the ledger
 * counts those in its own set.
 */
export const CLUSTER_GROUP_LOCAL_SETTINGS = [
  'cluster.keyRotationHours',
  'cluster.keyRotationGraceMinutes',
  'cluster.beaconSeconds',
  'cluster.rosterGossipSeconds',
] as const;

const SETTINGS_BEHAVIOR_VERIFIED = SETTINGS_BEHAVIOR_BASELINE
  + FEATURE_KNOB_LOCAL_SETTINGS.length
  + DEVICE_AND_TRIGGER_LOCAL_SETTINGS.length
  + CLUSTER_GROUP_LOCAL_SETTINGS.length
  + ENABLEMENT_KEYS_BEHAVIOR_VERIFIED;

const EXTERNAL_SLASH_COMMANDS = new Set([
  'auth',
  'bridge',
  'cloudflare',
  'health',
  'listener',
  'login',
  'logout',
  'mcp',
  'notify',
  'pair',
  'qrcode',
  'remote',
  'remote-env',
  'remote-setup',
  'runner-pool',
  'scan',
  'secrets',
  'services',
  'subscription',
  'teleport',
  'tts',
  'tunnel',
  'voice',
]);

const EXTERNAL_CLI_COMMANDS = new Set([
  'bridge',
  'listener',
  'pair',
  'remote',
  'run',
  'serve',
  'service',
  'tui',
  'web',
]);

const ONBOARDING_CAPABILITIES = [
  'local-tui-only',
  'browser-access',
  'network-access',
  'webhook-events',
  'external-integrations',
  'cloudflare-batch',
] as const;

const EXTERNAL_SURFACES = [
  'bluebubbles',
  'discord',
  'googleChat',
  'homeassistant',
  'imessage',
  'matrix',
  'mattermost',
  'msteams',
  'ntfy',
  'signal',
  'slack',
  'telegram',
  'webhook',
  'whatsapp',
] as const;

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;
}

function listSlashCommands(): string[] {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  return registry.getAll().map((command) => command.name);
}

function countBuiltinPanels(root: string): number {
  const builtinDir = join(root, 'src', 'panels', 'builtin');
  let count = 0;
  for (const file of readdirSync(builtinDir)) {
    if (!file.endsWith('.ts')) continue;
    const text = readFileSync(join(builtinDir, file), 'utf8');
    count += [...text.matchAll(/registerType\(\s*\{\s*id:\s*['"][^'"]+['"]/g)].length;
  }
  return count;
}

function listCliCommands(root: string): string[] {
  const text = readFileSync(join(root, 'src', 'cli', 'types.ts'), 'utf8');
  const match = text.match(/export type GoodVibesCliCommand =([\s\S]*?)export type GoodVibesCliOutputFormat/);
  if (!match) return [];
  return [...match[1].matchAll(/\|\s*'([^']+)'/g)]
    .map((entry) => entry[1])
    .filter((command) => command !== 'unknown');
}

export function buildVerificationLedger(root: string): VerificationLedger {
  const slashCommandNames = listSlashCommands();
  const cliCommandNames = listCliCommands(root);
  const slashCommands = slashCommandNames.length;
  const panels = countBuiltinPanels(root);
  const cliCommands = cliCommandNames.length;
  const featureFlags = FEATURE_SETTINGS.length;
  const settings = CONFIG_SCHEMA.length;
  const externalSlashCommands = slashCommandNames.filter((command) => EXTERNAL_SLASH_COMMANDS.has(command)).length;
  const externalCliCommands = cliCommandNames.filter((command) => EXTERNAL_CLI_COMMANDS.has(command)).length;

  const areas: VerificationLedgerArea[] = [
    {
      area: 'Settings schema and persistence',
      total: settings,
      localSignalVerified: settings,
      localBehaviorVerified: SETTINGS_BEHAVIOR_VERIFIED,
      externalOutcomeRequired: settings - SETTINGS_BEHAVIOR_VERIFIED,
      notes: 'Every schema setting can be validated for schema/default/load/write/location; external side effects remain separate.',
    },
    {
      area: 'Feature flags',
      total: featureFlags,
      localSignalVerified: featureFlags,
      localBehaviorVerified: featureFlags - 4,
      externalOutcomeRequired: 4,
      notes: 'All flags can be loaded/toggled; a small surface/service subset still requires live external behavior.',
    },
    {
      area: 'Slash commands',
      total: slashCommands,
      localSignalVerified: slashCommands,
      localBehaviorVerified: slashCommands - externalSlashCommands,
      externalOutcomeRequired: externalSlashCommands,
      notes: 'Every command can be routed and invoked with a fake context; external/provider/device commands need live outcome checks.',
    },
    {
      area: 'Built-in panels',
      total: panels,
      localSignalVerified: panels,
      localBehaviorVerified: panels,
      externalOutcomeRequired: 0,
      notes: 'Panels can be rendered and input-tested against fake read models and real cached state.',
    },
    {
      area: 'Top-level CLI commands',
      total: cliCommands,
      localSignalVerified: cliCommands,
      localBehaviorVerified: cliCommands - externalCliCommands,
      externalOutcomeRequired: externalCliCommands,
      notes: 'Parser/help/status/package behavior is local; long-running TUI/service/remote flows require process or external checks.',
    },
    {
      area: 'External surfaces',
      total: EXTERNAL_SURFACES.length,
      localSignalVerified: EXTERNAL_SURFACES.length,
      localBehaviorVerified: 2,
      externalOutcomeRequired: EXTERNAL_SURFACES.length - 2,
      notes: 'Config/readiness can be local for all surfaces; real message delivery is external for most surfaces.',
    },
    {
      area: 'Onboarding capability bundles',
      total: ONBOARDING_CAPABILITIES.length,
      localSignalVerified: ONBOARDING_CAPABILITIES.length,
      localBehaviorVerified: 5,
      externalOutcomeRequired: 1,
      notes: 'Wizard state derivation/apply can be local; Cloudflare provisioning remains external.',
    },
  ];

  const total = areas.reduce((sum, area) => sum + area.total, 0);
  const localSignalVerified = areas.reduce((sum, area) => sum + area.localSignalVerified, 0);
  const localBehaviorVerified = areas.reduce((sum, area) => sum + area.localBehaviorVerified, 0);
  const externalOutcomeRequired = areas.reduce((sum, area) => sum + area.externalOutcomeRequired, 0);

  return {
    generatedAt: new Date().toISOString(),
    areas,
    totals: {
      total,
      localSignalVerified,
      localBehaviorVerified,
      externalOutcomeRequired,
      localSignalPercent: percent(localSignalVerified, total),
      localBehaviorPercent: percent(localBehaviorVerified, total),
    },
  };
}

export function renderVerificationLedgerMarkdown(ledger: VerificationLedger): string {
  const lines = [
    '# GoodVibes Verification Ledger',
    '',
    `Generated: ${ledger.generatedAt}`,
    '',
    '| Area | Total | Local verification signal | Local behavior | External outcome required | Notes |',
    '|---|---:|---:|---:|---:|---|',
    ...ledger.areas.map((area) => [
      `| ${area.area}`,
      area.total,
      area.localSignalVerified,
      area.localBehaviorVerified,
      area.externalOutcomeRequired,
      area.notes,
    ].join(' | ') + ' |'),
    '',
    '## Totals',
    '',
    `- Total inventory items: ${ledger.totals.total}`,
    `- Local verification signal: ${ledger.totals.localSignalVerified} (${ledger.totals.localSignalPercent}%)`,
    `- Local behavior verified: ${ledger.totals.localBehaviorVerified} (${ledger.totals.localBehaviorPercent}%)`,
    `- External outcome required: ${ledger.totals.externalOutcomeRequired}`,
    '',
    'Local verification signal means the item can be exercised through schema, routing, persistence, render, readiness, daemon, CLI, or real-state checks without relying on an external SaaS/device outcome.',
    'Local behavior verified means the behavior can be completed locally with in-process, CLI, daemon, tmux, or real persisted state.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}
