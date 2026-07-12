import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_SCHEMA } from '@pellux/goodvibes-sdk/platform/config';
import { FEATURE_SETTINGS } from '@pellux/goodvibes-sdk/platform/runtime/state';
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

/** Settings with real local behavior verification: the authored baseline plus the newly persistence-tested feature-knob keys. */
const SETTINGS_BEHAVIOR_VERIFIED = SETTINGS_BEHAVIOR_BASELINE + FEATURE_KNOB_LOCAL_SETTINGS.length;

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
