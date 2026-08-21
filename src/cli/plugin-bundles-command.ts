import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  parseMarketplaceIndex,
  fetchAndVerifyBundle,
  validateCapabilityBundleManifest,
  planBundleActivation,
  BundlePinRefusal,
  type PinnedMarketplaceIndexEntry,
  type CapabilityBundleManifest,
  type BundleActivationPlan,
} from '@pellux/goodvibes-sdk/platform/runtime/ecosystem';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { CliCommandOutput, CliCommandRuntime } from '@pellux/goodvibes-terminal-shell';

// ---------------------------------------------------------------------------
// `goodvibes plugin bundles browse|install|list`, the capability-bundle
// marketplace surface. Extends the existing plugin-command.ts family with the
// SDK's SHA-256-pinned bundle distribution (platform/runtime/ecosystem):
// parseMarketplaceIndex, fetchAndVerifyBundle, planBundleActivation. There is
// deliberately NO flag that bypasses a pin mismatch, `install` either
// verifies or refuses; `--yes` only confirms an ALREADY-verified activation
// plan, it never substitutes for the pin.
// ---------------------------------------------------------------------------

interface InstalledBundleRecord {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: CapabilityBundleManifest['kind'];
  readonly source: { readonly kind: 'file' | 'url'; readonly location: string; readonly sha256: string };
  readonly capabilities: BundleActivationPlan['capabilityManifest'];
  readonly quarantine: BundleActivationPlan['quarantine'];
  readonly installedAt: number;
}

function installedBundlesPath(runtime: CliCommandRuntime): string {
  return join(runtime.homeDirectory, '.goodvibes', 'bundles', 'installed.json');
}

function readInstalledBundles(runtime: CliCommandRuntime): InstalledBundleRecord[] {
  const path = installedBundlesPath(runtime);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as InstalledBundleRecord[]) : [];
  } catch {
    return [];
  }
}

function writeInstalledBundles(runtime: CliCommandRuntime, records: readonly InstalledBundleRecord[]): void {
  const path = installedBundlesPath(runtime);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`, 'utf-8');
}

function formatJsonOrText(runtime: CliCommandRuntime, value: unknown, text: string): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}

/** file:// / bare-path vs http(s)://, the only two source kinds this CLI surface accepts (no git ref flag exists yet). */
function inferSourceKind(ref: string): 'file' | 'url' {
  return ref.startsWith('http://') || ref.startsWith('https://') ? 'url' : 'file';
}

async function readIndexBytes(ref: string): Promise<string> {
  if (inferSourceKind(ref) === 'url') {
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`URL '${ref}' returned HTTP ${res.status}`);
    return res.text();
  }
  return readFileSync(ref, 'utf-8');
}

function summarizeCapabilities(summary: PinnedMarketplaceIndexEntry['capabilities']): string {
  const parts = [`tools:${summary.toolCount}`, `hooks:${summary.hookCount}`, `configDomains:${summary.configDomainCount}`, `channels:${summary.channelCount}`];
  if (summary.runtime.length > 0) parts.push(`runtime:${summary.runtime.join('+')}`);
  if (summary.highRisk) parts.push('HIGH-RISK');
  return parts.join(' ');
}

async function handleBrowse(runtime: CliCommandRuntime, ref: string | undefined): Promise<CliCommandOutput> {
  if (!ref) return { output: 'Usage: goodvibes plugin bundles browse <index-url-or-file>', exitCode: 2 };
  let raw: string;
  try {
    raw = await readIndexBytes(ref);
  } catch (error) {
    return { output: `Could not read marketplace index '${ref}': ${summarizeError(error)}`, exitCode: 1 };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { output: `Marketplace index at '${ref}' is not valid JSON: ${summarizeError(error)}`, exitCode: 1 };
  }
  const result = parseMarketplaceIndex(value);
  if (!result.ok) {
    return {
      output: formatJsonOrText(runtime, result, [
        `Marketplace index at '${ref}' was refused (a governed index requires a SHA-256 pin + capability summary on every entry):`,
        ...result.errors.map((e) => `  - ${e}`),
      ].join('\n')),
      exitCode: 1,
    };
  }
  const { bundles } = result.index;
  if (bundles.length === 0) {
    return { output: formatJsonOrText(runtime, result.index, `Marketplace index at '${ref}': no bundles listed.`), exitCode: 0 };
  }
  const lines = [`Marketplace index at '${ref}' (${bundles.length} bundle${bundles.length === 1 ? '' : 's'}):`];
  for (const entry of bundles) {
    lines.push(
      `  ${entry.id}: ${entry.name} v${entry.version} (${entry.kind})`,
      `    ${entry.summary}`,
      `    capabilities: ${summarizeCapabilities(entry.capabilities)}`,
      `    pin: sha256:${entry.source.sha256} (${entry.source.kind}: ${entry.source.location})`,
    );
  }
  return { output: formatJsonOrText(runtime, result.index, lines.join('\n')), exitCode: 0 };
}

/** Render an activation plan (granted capabilities, withheld/quarantined ones) for confirmation. */
function renderPlan(plan: BundleActivationPlan, committed: boolean): string {
  const lines = [
    `${committed ? 'Installed' : 'Activation plan (preview; re-run with --yes to install)'}: ${plan.manifest.id} v${plan.manifest.version} (${plan.manifest.kind})`,
    `  trust tier: ${plan.trustTier}`,
    `  declared runtime capabilities: ${plan.manifest.capabilities.runtime.join(', ') || 'none'}`,
    `  declared tools: ${plan.manifest.capabilities.tools.join(', ') || 'none'}`,
    `  declared hooks: ${plan.manifest.capabilities.hooks.join(', ') || 'none'}`,
    `  declared configDomains: ${plan.manifest.capabilities.configDomains.join(', ') || 'none'}`,
    `  declared channels: ${plan.manifest.capabilities.channels.join(', ') || 'none'}`,
    `  granted capabilities: ${plan.capabilityManifest.granted.join(', ') || 'none'}`,
  ];
  if (plan.quarantine.required) {
    lines.push(
      `  QUARANTINED: yes; ${plan.quarantine.reason ?? 'over-reached its trust tier'}`,
      `  withheld capabilities: ${plan.quarantine.revokedCapabilities.join(', ')}`,
    );
  } else {
    lines.push('  quarantined: no; every declared capability fit the trust tier');
  }
  return lines.join('\n');
}

async function handleInstall(runtime: CliCommandRuntime, ref: string | undefined, sha256: string | undefined): Promise<CliCommandOutput> {
  if (!ref || !sha256) {
    return { output: 'Usage: goodvibes plugin bundles install <ref> --sha256 <pin>  (the pin is required; there is no unpinned install path)', exitCode: 2 };
  }
  const kind = inferSourceKind(ref);
  const source = { kind, location: ref, sha256 } as const;
  let bytes: Uint8Array;
  try {
    const fetched = await fetchAndVerifyBundle(source);
    bytes = fetched.bytes;
  } catch (error) {
    if (error instanceof BundlePinRefusal) {
      return {
        output: formatJsonOrText(runtime, { ok: false, source, verification: error.verification }, `Refused: ${error.message}`),
        exitCode: 1,
      };
    }
    return { output: `Could not fetch bundle from '${ref}': ${summarizeError(error)}`, exitCode: 1 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return { output: `Bundle at '${ref}' is not valid JSON: ${summarizeError(error)}`, exitCode: 1 };
  }
  const validation = validateCapabilityBundleManifest(parsed);
  if (!validation.ok) {
    return {
      output: formatJsonOrText(runtime, validation, [
        `Bundle manifest at '${ref}' was refused:`,
        ...validation.errors.map((e) => `  - ${e}`),
      ].join('\n')),
      exitCode: 1,
    };
  }
  const plan = planBundleActivation(validation.manifest);
  const committed = runtime.cli.flags.yes;
  if (committed) {
    const records = readInstalledBundles(runtime).filter((r) => r.id !== plan.manifest.id);
    records.push({
      id: plan.manifest.id,
      name: plan.manifest.name,
      version: plan.manifest.version,
      kind: plan.manifest.kind,
      source,
      capabilities: plan.capabilityManifest,
      quarantine: plan.quarantine,
      installedAt: Date.now(),
    });
    writeInstalledBundles(runtime, records);
  }
  return { output: formatJsonOrText(runtime, { ok: true, committed, plan }, renderPlan(plan, committed)), exitCode: 0 };
}

function handleList(runtime: CliCommandRuntime): CliCommandOutput {
  const records = readInstalledBundles(runtime);
  if (records.length === 0) {
    return { output: formatJsonOrText(runtime, records, 'No capability bundles installed.'), exitCode: 0 };
  }
  const lines = [`Installed capability bundles (${records.length}):`];
  for (const record of records) {
    lines.push(
      `  ${record.id}: ${record.name} v${record.version} (${record.kind})`,
      `    installedAt: ${new Date(record.installedAt).toISOString()}`,
      `    source: ${record.source.kind}:${record.source.location} (sha256:${record.source.sha256})`,
      `    quarantined: ${record.quarantine.required ? `yes: ${record.quarantine.reason ?? 'over-reached its trust tier'}` : 'no'}`,
    );
  }
  return { output: formatJsonOrText(runtime, records, lines.join('\n')), exitCode: 0 };
}

export async function handlePluginBundlesCommand(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const [sub, ...rest] = args;
  if (sub === 'browse') return handleBrowse(runtime, rest[0]);
  if (sub === 'install') {
    const sha256Index = rest.indexOf('--sha256');
    const sha256 = sha256Index >= 0 ? rest[sha256Index + 1] : undefined;
    const ref = rest.find((token, i) => (sha256Index < 0 || (i !== sha256Index && i !== sha256Index + 1)) && !token.startsWith('-'));
    return handleInstall(runtime, ref, sha256);
  }
  if (sub === 'list') return handleList(runtime);
  return { output: 'Usage: goodvibes plugin bundles browse <index-url-or-file>|install <ref> --sha256 <pin>|list', exitCode: 2 };
}
