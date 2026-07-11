import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import {
  scaffoldCapabilityBundleManifest,
  computeSha256,
  buildMarketplaceIndexEntry,
  serializeMarketplaceIndex,
  type PinnedMarketplaceIndex,
} from '@pellux/goodvibes-sdk/platform/runtime/ecosystem';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { handlePluginCommand } from '../../cli/plugin-command.ts';
import type { CliCommandRuntime } from '../../cli/types.ts';

function makeRuntime(root: string, args: readonly string[]): CliCommandRuntime {
  const configManager = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
  return {
    cli: parseGoodVibesCli(args, 'goodvibes'),
    configManager,
    workingDirectory: root,
    homeDirectory: root,
  };
}

describe('goodvibes plugin bundles', () => {
  let root = '';
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'goodvibes-plugin-bundles-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('install refuses when --sha256 is missing (never an unpinned install path)', async () => {
    const manifestPath = join(root, 'bundle.json');
    writeFileSync(manifestPath, JSON.stringify(scaffoldCapabilityBundleManifest('demo-bundle')), 'utf-8');
    const result = await handlePluginCommand(makeRuntime(root, ['plugin', 'bundles', 'install', manifestPath]));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('the pin is required');
  });

  test('install refuses on a SHA-256 mismatch, and does not persist the bundle', async () => {
    const manifestPath = join(root, 'bundle.json');
    writeFileSync(manifestPath, JSON.stringify(scaffoldCapabilityBundleManifest('demo-bundle')), 'utf-8');
    const wrongPin = '0'.repeat(64);
    const result = await handlePluginCommand(makeRuntime(root, ['plugin', 'bundles', 'install', manifestPath, '--sha256', wrongPin, '--yes']));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Refused');

    const listResult = await handlePluginCommand(makeRuntime(root, ['plugin', 'bundles', 'list']));
    expect(listResult.output).toContain('No capability bundles installed');
  });

  test('install with a correct pin previews without --yes, then commits with --yes', async () => {
    const manifest = scaffoldCapabilityBundleManifest('demo-bundle');
    const manifestPath = join(root, 'bundle.json');
    const bytes = JSON.stringify(manifest);
    writeFileSync(manifestPath, bytes, 'utf-8');
    const pin = computeSha256(new TextEncoder().encode(bytes));

    const preview = await handlePluginCommand(makeRuntime(root, ['plugin', 'bundles', 'install', manifestPath, '--sha256', pin]));
    expect(preview.exitCode).toBe(0);
    expect(preview.output).toContain('preview');
    const previewList = await handlePluginCommand(makeRuntime(root, ['plugin', 'bundles', 'list']));
    expect(previewList.output).toContain('No capability bundles installed');

    const committed = await handlePluginCommand(makeRuntime(root, ['plugin', 'bundles', 'install', manifestPath, '--sha256', pin, '--yes']));
    expect(committed.exitCode).toBe(0);
    expect(committed.output).toContain('Installed');
    const finalList = await handlePluginCommand(makeRuntime(root, ['plugin', 'bundles', 'list']));
    expect(finalList.output).toContain('demo-bundle');
  });

  test('browse lists a governed marketplace index (name, capability summary, pin)', async () => {
    const manifest = scaffoldCapabilityBundleManifest('demo-bundle');
    const bytes = JSON.stringify(manifest);
    const pin = computeSha256(new TextEncoder().encode(bytes));
    const entry = buildMarketplaceIndexEntry(manifest, { kind: 'file', location: 'bundle.json', sha256: pin });
    const index: PinnedMarketplaceIndex = { version: 1, bundles: [entry] };
    const indexPath = join(root, 'index.json');
    writeFileSync(indexPath, serializeMarketplaceIndex(index), 'utf-8');

    const result = await handlePluginCommand(makeRuntime(root, ['plugin', 'bundles', 'browse', indexPath]));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('demo-bundle');
    expect(result.output).toContain(`pin: sha256:${pin}`);
  });

  test('browse refuses a marketplace index with a missing pin', async () => {
    const indexPath = join(root, 'bad-index.json');
    writeFileSync(indexPath, JSON.stringify({ version: 1, bundles: [{ id: 'x', name: 'X', version: '1.0.0', kind: 'plugin', summary: 's' }] }), 'utf-8');
    const result = await handlePluginCommand(makeRuntime(root, ['plugin', 'bundles', 'browse', indexPath]));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('refused');
  });
});
