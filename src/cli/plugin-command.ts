import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverPlugins } from '../plugins/loader.ts';
import { validateManifestV2 } from '@/runtime/index.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { CliCommandOutput, CliCommandRuntime } from './types.ts';
import { handlePluginBundlesCommand } from './plugin-bundles-command.ts';

// ---------------------------------------------------------------------------
// `goodvibes plugin init` / `plugin validate` — scaffold and check plugins
// against the SAME classic loader the running TUI uses (PluginManager wraps
// discoverPlugins from @pellux/goodvibes-sdk/platform/plugins). The pass/fail
// verdict is the real loader's acceptance: we run discoverPlugins against the
// target directory (isolated from the operator's own plugin folders) and check
// whether it accepts the directory. Reasons for a rejected manifest are sourced
// from the SDK's validateManifestV2 (string|null) plus observable file facts —
// no second manifest schema is defined here.
// ---------------------------------------------------------------------------

interface PluginValidation {
  readonly ok: boolean;
  readonly path: string;
  readonly reasons: readonly string[];
  readonly manifestName?: string;
  readonly manifestVersion?: string;
}

/** A base directory whose standard plugin folders do not exist, so discoverPlugins
 * only considers the target's parent (passed via additionalDirectories). */
function isolatedBase(): string {
  return join(tmpdir(), '__goodvibes_plugin_validate_isolate__');
}

function validatePluginDirectory(dirPath: string): PluginValidation {
  const resolved = resolve(dirPath);
  if (!existsSync(resolved)) {
    return { ok: false, path: resolved, reasons: ['directory not found.'] };
  }
  const manifestPath = join(resolved, 'manifest.json');

  // Authoritative verdict: the real classic loader's discovery scan.
  const base = isolatedBase();
  const discovered = discoverPlugins({
    cwd: base,
    homeDir: base,
    additionalDirectories: [dirname(resolved)],
  });
  const match = discovered.find((plugin) => resolve(plugin.pluginDir) === resolved);
  if (match) {
    return {
      ok: true,
      path: resolved,
      reasons: [],
      manifestName: match.manifest.name,
      manifestVersion: match.manifest.version,
    };
  }

  // Rejected — explain why, delegating field checks to the SDK validator.
  const reasons: string[] = [];
  if (!existsSync(manifestPath)) {
    reasons.push('manifest.json not found in the plugin directory.');
    return { ok: false, path: resolved, reasons };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (error) {
    reasons.push(`manifest.json is not valid JSON — ${summarizeError(error)}`);
    return { ok: false, path: resolved, reasons };
  }
  const fieldReason = validateManifestV2(manifest);
  if (fieldReason) {
    reasons.push(fieldReason);
  } else {
    reasons.push('the plugin loader did not accept this directory — if "main" is set it must be a relative path.');
  }
  return { ok: false, path: resolved, reasons };
}

function renderValidation(result: PluginValidation, json: boolean): CliCommandOutput {
  if (json) {
    return { output: JSON.stringify(result, null, 2), exitCode: result.ok ? 0 : 1 };
  }
  const lines = ['GoodVibes plugin validation', `  path: ${result.path}`];
  if (result.ok) {
    lines.push(`  PASS  ${result.manifestName} v${result.manifestVersion} — the plugin loader accepts this directory.`);
  } else {
    lines.push('  FAIL  the plugin loader rejects this directory:');
    for (const reason of result.reasons) lines.push(`    - ${reason}`);
  }
  return { output: lines.join('\n'), exitCode: result.ok ? 0 : 1 };
}

const ENTRY_FILE_CONTENTS = `// Minimal GoodVibes plugin entry point.
// The loader calls init(api) once after the plugin is loaded.
export function init(api) {
  // Register commands, tools, or hooks through the sandboxed api here.
  void api;
}
`;

function handlePluginInit(runtime: CliCommandRuntime): CliCommandOutput {
  const json = runtime.cli.flags.outputFormat === 'json';
  const name = runtime.cli.commandArgs[1];
  if (!name) {
    return { output: 'Usage: goodvibes plugin init <name> [directory]', exitCode: 2 };
  }
  const dirArg = runtime.cli.commandArgs[2];
  const targetDir = dirArg
    ? resolve(dirArg)
    : join(runtime.workingDirectory, '.goodvibes', 'plugins', name);
  const manifestPath = join(targetDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    return {
      output: json
        ? JSON.stringify({ ok: false, path: targetDir, reason: 'a plugin already exists here' }, null, 2)
        : `A plugin already exists at ${targetDir} (manifest.json present). Choose another name or directory.`,
      exitCode: 1,
    };
  }

  const manifest = {
    name,
    version: '0.1.0',
    description: `${name} plugin`,
    main: 'index.js',
  };
  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    writeFileSync(join(targetDir, 'index.js'), ENTRY_FILE_CONTENTS, 'utf-8');
  } catch (error) {
    return {
      output: json
        ? JSON.stringify({ ok: false, path: targetDir, reason: summarizeError(error) }, null, 2)
        : `Failed to scaffold plugin at ${targetDir} — ${summarizeError(error)}`,
      exitCode: 1,
    };
  }

  // Prove the freshly scaffolded plugin passes our own validation path.
  const validation = validatePluginDirectory(targetDir);
  if (json) {
    return {
      output: JSON.stringify({ ok: validation.ok, path: targetDir, created: ['manifest.json', 'index.js'], validation }, null, 2),
      exitCode: validation.ok ? 0 : 1,
    };
  }
  const lines = [
    `Scaffolded plugin "${name}" at ${targetDir}`,
    '  created: manifest.json, index.js',
    validation.ok
      ? '  validation: PASS — the plugin loader accepts this directory.'
      : `  validation: FAIL — ${validation.reasons.join('; ')}`,
    `  next: run "goodvibes plugin validate ${targetDir}" or restart the TUI to load it.`,
  ];
  return { output: lines.join('\n'), exitCode: validation.ok ? 0 : 1 };
}

export async function handlePluginCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const json = runtime.cli.flags.outputFormat === 'json';
  const [sub] = runtime.cli.commandArgs;
  if (sub === 'init') {
    return handlePluginInit(runtime);
  }
  if (sub === 'validate') {
    const target = runtime.cli.commandArgs[1];
    if (!target) {
      return { output: 'Usage: goodvibes plugin validate <path>', exitCode: 2 };
    }
    return renderValidation(validatePluginDirectory(target), json);
  }
  if (sub === 'bundles') {
    return handlePluginBundlesCommand(runtime, runtime.cli.commandArgs.slice(1));
  }
  return { output: 'Usage: goodvibes plugin [init <name> [directory]|validate <path>|bundles browse|install|list]', exitCode: 2 };
}
