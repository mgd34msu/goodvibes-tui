import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { isFeatureConfigEnabled } from '@pellux/goodvibes-terminal-shell';
import {
  applyRuntimeConfigDefault,
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeCommandEndpointFlagOverrides,
  applyRuntimeFeatureFlagOverrides,
  handleGoodVibesCliCommand,
  parseCliFlags,
  parseGoodVibesCli,
  renderGoodVibesCommandHelp,
  renderGoodVibesHelp,
} from '../cli-flags.ts';
import { makeProjectTempDir } from './helpers/project-temp.ts';

async function captureGoodVibesCliCommand(args: readonly string[], configManager: ConfigManager, root: string) {
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { logs.push(String(value)); };
    const result = await handleGoodVibesCliCommand({
      cli: parseGoodVibesCli(args),
      configManager,
      workingDirectory: root,
      homeDirectory: root,
    });
    return { result, output: logs.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

function featureFlagState(configManager: ConfigManager, flagId: string): unknown {
  // Enablement lives on each feature's domain settings key now.
  return isFeatureConfigEnabled(configManager, flagId) ? 'enabled' : 'disabled';
}

describe('parseCliFlags', () => {
  // ---------------------------------------------------------------------------
  // --daemon-home
  // ---------------------------------------------------------------------------

  test('parses --daemon-home=<path>', () => {
    const flags = parseCliFlags(['--daemon-home=/custom/home']);
    expect(flags.daemonHome).toBe('/custom/home');
  });

  test('parses --working-dir=<path>', () => {
    const flags = parseCliFlags(['--working-dir=/custom/workspace']);
    expect(flags.workingDir).toBe('/custom/workspace');
  });

  test('parses both --daemon-home and --working-dir together', () => {
    const flags = parseCliFlags([
      '--daemon-home=/home/daemon',
      '--working-dir=/home/workspace',
    ]);
    expect(flags.daemonHome).toBe('/home/daemon');
    expect(flags.workingDir).toBe('/home/workspace');
  });

  // ---------------------------------------------------------------------------
  // Env var precedence (flags win, env is fallback)
  // ---------------------------------------------------------------------------
  // parseCliFlags itself does not read env vars, it only returns parsed flag
  // values. The caller (daemon/cli.ts main()) is responsible for setting env
  // vars from the returned flags and then calling resolveDaemonCliOwnership()
  // which reads the env vars with ?? fallback. These tests confirm the flag
  // parser returns correct values so the caller can honour the precedence:
  //   flag > GOODVIBES_DAEMON_HOME env > homedir()
  //   flag > GOODVIBES_WORKING_DIR env > process.cwd()

  test('env GOODVIBES_DAEMON_HOME is the fallback when flag absent', () => {
    // The parser returns undefined when the flag is absent; the caller reads
    // process.env['GOODVIBES_DAEMON_HOME'] as the fallback instead.
    const flags = parseCliFlags([]);
    expect(flags.daemonHome).toBeUndefined();
  });

  test('env GOODVIBES_WORKING_DIR is the fallback when flag absent', () => {
    const flags = parseCliFlags([]);
    expect(flags.workingDir).toBeUndefined();
  });

  test('flag overrides env for daemon-home; flag present, env set', () => {
    // Verify the flag value takes precedence: parser returns the flag value,
    // the caller writes it to env before resolveDaemonCliOwnership() is called.
    const savedEnv = process.env['GOODVIBES_DAEMON_HOME'];
    try {
      process.env['GOODVIBES_DAEMON_HOME'] = '/from/env';
      const flags = parseCliFlags(['--daemon-home=/from/flag']);
      // Flag value returned; caller will overwrite the env var with this.
      expect(flags.daemonHome).toBe('/from/flag');
    } finally {
      if (savedEnv === undefined) {
        delete process.env['GOODVIBES_DAEMON_HOME'];
      } else {
        process.env['GOODVIBES_DAEMON_HOME'] = savedEnv;
      }
    }
  });

  test('flag overrides env for working-dir; flag present, env set', () => {
    const savedEnv = process.env['GOODVIBES_WORKING_DIR'];
    try {
      process.env['GOODVIBES_WORKING_DIR'] = '/from/env';
      const flags = parseCliFlags(['--working-dir=/from/flag']);
      expect(flags.workingDir).toBe('/from/flag');
    } finally {
      if (savedEnv === undefined) {
        delete process.env['GOODVIBES_WORKING_DIR'];
      } else {
        process.env['GOODVIBES_WORKING_DIR'] = savedEnv;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Help text contains precedence note
  // ---------------------------------------------------------------------------

  test('help text includes --daemon-home and --working-dir with precedence note', () => {
    const flags = parseCliFlags(['--help']);
    const helpOutput = renderGoodVibesHelp('goodvibes');
    expect(flags.help).toBe(true);
    expect(helpOutput).toContain('--daemon-home <dir>');
    expect(helpOutput).toContain('--working-dir <dir>');
    expect(helpOutput).toContain('--output <format>');
    expect(helpOutput).toContain('status');
    expect(helpOutput).toContain('onboarding');
  });

  test('command-specific help describes the selected command surface', () => {
    const parsed = parseGoodVibesCli(['providers', '--help']);
    const helpOutput = renderGoodVibesCommandHelp(parsed.rawCommand ?? parsed.command, 'goodvibes');

    expect(parsed.command).toBe('providers');
    expect(parsed.flags.help).toBe(true);
    expect(helpOutput).toContain('GoodVibes providers');
    expect(helpOutput).toContain('providers inspect <provider>');
    expect(helpOutput).not.toContain('Usage: goodvibes [OPTIONS] [PROMPT]');
  });

  // ---------------------------------------------------------------------------
  // Other flags still parse correctly
  // ---------------------------------------------------------------------------

  test('parses --provider and --model alongside new flags', () => {
    const flags = parseCliFlags([
      '--provider', 'openai',
      '--model', 'gpt-4o',
      '--daemon-home=/tmp/dh',
      '--working-dir=/tmp/wd',
    ]);
    expect(flags.provider).toBe('openai');
    expect(flags.model).toBe('gpt-4o');
    expect(flags.daemonHome).toBe('/tmp/dh');
    expect(flags.workingDir).toBe('/tmp/wd');
  });

  test('infers provider from provider:model format in --model', () => {
    const flags = parseCliFlags(['--model', 'inception:mercury-2']);
    expect(flags.model).toBe('inception:mercury-2');
    expect(flags.provider).toBe('inception');
  });

  test('returns all undefined when no flags are provided', () => {
    const flags = parseCliFlags([]);
    expect(flags.provider).toBeUndefined();
    expect(flags.model).toBeUndefined();
    expect(flags.daemonHome).toBeUndefined();
    expect(flags.workingDir).toBeUndefined();
  });

  test('parses core command surface and prompt aliases', () => {
    const run = parseGoodVibesCli(['run', '--output', 'json', 'write tests']);
    expect(run.command).toBe('run');
    expect(run.flags.outputFormat).toBe('json');
    expect(run.flags.prompt).toBe('write tests');

    const onboarding = parseGoodVibesCli(['setup', 'status']);
    expect(onboarding.command).toBe('onboarding');
    expect(onboarding.commandArgs).toEqual(['status']);

    const listener = parseGoodVibesCli(['listener', 'test']);
    expect(listener.command).toBe('listener');
    expect(listener.commandArgs).toEqual(['test']);
  });

  test('passes command-specific options through to command handlers', () => {
    const auth = parseGoodVibesCli(['auth', 'add-user', 'alice', '--password-stdin', '--role', 'admin']);
    expect(auth.errors).toEqual([]);
    expect(auth.command).toBe('auth');
    expect(auth.commandArgs).toEqual(['add-user', 'alice', '--password-stdin', '--role', 'admin']);

    const subscription = parseGoodVibesCli(['subscription', 'login', 'openai', 'start', '--manual']);
    expect(subscription.errors).toEqual([]);
    expect(subscription.commandArgs).toEqual(['login', 'openai', 'start', '--manual']);
  });

  test('parses GoodVibes-specific command names', () => {
    for (const command of ['surfaces', 'control-plane', 'support-bundle', 'remote', 'bridge', 'service'] as const) {
      expect(parseGoodVibesCli([command]).command).toBe(command);
    }
  });

  test('bundle/bundles remain backward-compat aliases for support-bundle', () => {
    expect(parseGoodVibesCli(['bundle']).command).toBe('support-bundle');
    expect(parseGoodVibesCli(['bundles']).command).toBe('support-bundle');
  });

  test('parses --cd, --no-alt-screen, completion, and port flags', () => {
    const flags = parseGoodVibesCli([
      'serve',
      '--cd',
      '/workspace',
      '--no-alt-screen',
      '--hostname',
      '0.0.0.0',
      '--port',
      '3421',
    ]);

    expect(flags.command).toBe('serve');
    expect(flags.flags.workingDir).toBe('/workspace');
    expect(flags.flags.noAltScreen).toBe(true);
    expect(flags.flags.hostname).toBe('0.0.0.0');
    expect(flags.flags.port).toBe(3421);
  });

  test('parses optional resume values and keeps -c reserved for config overrides', () => {
    const resumeLatest = parseGoodVibesCli(['--resume']);
    expect(resumeLatest.errors).toEqual([]);
    expect(resumeLatest.flags.resume).toBe('latest');

    const resumeTarget = parseGoodVibesCli(['--resume', 'session-123']);
    expect(resumeTarget.errors).toEqual([]);
    expect(resumeTarget.flags.resume).toBe('session-123');

    const config = parseGoodVibesCli(['-c', 'behavior.autoApprove=true']);
    expect(config.errors).toEqual([]);
    expect(config.flags.configOverrides).toEqual(['behavior.autoApprove=true']);
    expect(config.flags.continueLast).toBe(false);
  });

  test('applies config overrides for the current process without persisting settings', () => {
    const root = makeProjectTempDir('goodvibes-cli-config');
    const configDir = join(root, '.goodvibes', 'tui');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir: root });

    const errors = applyRuntimeConfigOverrides(configManager, [
      'controlPlane.port=4567',
      'behavior.autoApprove=true',
    ]);
    applyRuntimeConfigValue(configManager, 'provider.model', 'openai:gpt-5.2');
    const featureErrors = applyRuntimeFeatureFlagOverrides(configManager, {
      enableFeatures: ['output-schema-fingerprint'],
      disableFeatures: ['agent-passive-knowledge-injection'],
    });

    expect(errors).toEqual([]);
    expect(featureErrors).toEqual([]);
    expect(configManager.get('controlPlane.port')).toBe(4567);
    expect(configManager.get('behavior.autoApprove')).toBe(true);
    expect(configManager.get('provider.model')).toBe('openai:gpt-5.2');
    // Feature overrides land on the real domain settings keys.
    expect(configManager.get('tools.outputSchemaFingerprints')).toBe(true);
    expect(configManager.get('agents.passiveInjection.knowledge')).toBe(false);
    expect(existsSync(join(configDir, 'settings.json'))).toBe(false);

    const reloaded = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir: root });
    expect(reloaded.get('controlPlane.port')).toBe(3421);
    expect(reloaded.get('behavior.autoApprove')).toBe(false);
    expect(reloaded.get('provider.model')).not.toBe('openai:gpt-5.2');
    expect(reloaded.get('tools.outputSchemaFingerprints')).toBe(false);
    expect(reloaded.get('agents.passiveInjection.knowledge')).toBe(true);
  });

  test('feature overrides report capabilities with no off switch and unknown ids', () => {
    const root = makeProjectTempDir('goodvibes-cli-feature-errors');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, '.goodvibes', 'tui'), workingDir: root });
    const featureErrors = applyRuntimeFeatureFlagOverrides(configManager, {
      enableFeatures: ['no-such-feature'],
      disableFeatures: ['fetch-sanitization'],
    });
    expect(featureErrors.length).toBe(2);
    expect(featureErrors[0]).toContain('unknown feature id');
    expect(featureErrors[1]).toContain('no off switch');
  });

  test('applies endpoint flags for CLI commands without persisting settings', () => {
    const root = makeProjectTempDir('goodvibes-cli-endpoint');
    const configDir = join(root, '.goodvibes', 'tui');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir: root });
    const cli = parseGoodVibesCli(['web', '--hostname', '0.0.0.0', '--port', '4568']);

    const errors = applyRuntimeCommandEndpointFlagOverrides(configManager, cli.command, cli.flags);

    expect(errors).toEqual([]);
    expect(configManager.get('web.hostMode')).toBe('network');
    expect(configManager.get('web.host')).toBe('0.0.0.0');
    expect(configManager.get('web.port')).toBe(4568);
    expect(existsSync(join(configDir, 'settings.json'))).toBe(false);
  });

  test('surface enable commands apply managed-service and LAN defaults', async () => {
    const root = makeProjectTempDir('goodvibes-cli-surface-web');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    const cli = parseGoodVibesCli(['surfaces', 'enable', 'web']);
    const originalLog = console.log;
    try {
      console.log = () => {};
      const result = await handleGoodVibesCliCommand({
        cli,
        configManager,
        workingDirectory: root,
        homeDirectory: root,
      });
      expect(result).toEqual({ handled: true, exitCode: 0 });
    } finally {
      console.log = originalLog;
    }

    expect(configManager.get('web.enabled')).toBe(true);
    expect(configManager.get('web.hostMode')).toBe('network');
    expect(configManager.get('web.host')).toBe('0.0.0.0');
    expect(configManager.get('controlPlane.enabled')).toBe(true);
    expect(configManager.get('controlPlane.hostMode')).toBe('network');
    expect(configManager.get('controlPlane.allowRemote')).toBe(true);
    expect(configManager.get('daemon.enabled')).toBe(true);
    expect(configManager.get('service.enabled')).toBe(true);
    expect(configManager.get('service.autostart')).toBe(true);
    expect(configManager.get('service.restartOnFailure')).toBe(true);
    expect(featureFlagState(configManager, 'control-plane-gateway')).toBe('enabled');
    expect(featureFlagState(configManager, 'service-management')).toBe('enabled');
    expect(featureFlagState(configManager, 'web-surface')).toBe('enabled');
  });

  test('surface enable respects explicit local host overrides', async () => {
    const root = makeProjectTempDir('goodvibes-cli-surface-local-web');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    const cli = parseGoodVibesCli(['surfaces', 'enable', 'web', '--hostname', '127.0.0.1', '--port', '4568']);
    const originalLog = console.log;
    try {
      console.log = () => {};
      const result = await handleGoodVibesCliCommand({
        cli,
        configManager,
        workingDirectory: root,
        homeDirectory: root,
      });
      expect(result).toEqual({ handled: true, exitCode: 0 });
    } finally {
      console.log = originalLog;
    }

    expect(configManager.get('web.enabled')).toBe(true);
    expect(configManager.get('web.hostMode')).toBe('local');
    expect(configManager.get('web.host')).toBe('127.0.0.1');
    expect(configManager.get('web.port')).toBe(4568);
    expect(configManager.get('controlPlane.hostMode')).toBe('local');
    expect(configManager.get('controlPlane.allowRemote')).toBe(false);
  });

  test('external surface enable commands turn on listener service posture', async () => {
    const root = makeProjectTempDir('goodvibes-cli-surface-slack');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    const cli = parseGoodVibesCli(['surfaces', 'enable', 'slack']);
    const originalLog = console.log;
    try {
      console.log = () => {};
      const result = await handleGoodVibesCliCommand({
        cli,
        configManager,
        workingDirectory: root,
        homeDirectory: root,
      });
      expect(result).toEqual({ handled: true, exitCode: 0 });
    } finally {
      console.log = originalLog;
    }

    expect(configManager.get('surfaces.slack.enabled')).toBe(true);
    expect(configManager.get('danger.httpListener')).toBe(true);
    expect(configManager.get('httpListener.hostMode')).toBe('network');
    expect(configManager.get('httpListener.host')).toBe('0.0.0.0');
    expect(configManager.get('service.enabled')).toBe(true);
    expect(configManager.get('service.autostart')).toBe(true);
    expect(configManager.get('service.restartOnFailure')).toBe(true);
    expect(featureFlagState(configManager, 'control-plane-gateway')).toBe('enabled');
    expect(featureFlagState(configManager, 'service-management')).toBe('enabled');
    expect(featureFlagState(configManager, 'route-binding')).toBe('enabled');
    expect(featureFlagState(configManager, 'delivery-engine')).toBe('enabled');
    expect(featureFlagState(configManager, 'slack-surface')).toBe('enabled');
  });

  test('listener test reports readiness issues for network webhook posture', async () => {
    const root = makeProjectTempDir('goodvibes-cli-listener-readiness');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    configManager.setDynamic('danger.httpListener', true);
    configManager.setDynamic('httpListener.hostMode', 'network');
    configManager.setDynamic('httpListener.host', '0.0.0.0');
    configManager.setDynamic('service.enabled', false);
    configManager.setDynamic('service.autostart', false);
    configManager.setDynamic('service.restartOnFailure', false);
    configManager.setDynamic('surfaces.slack.enabled', true);

    const text = await captureGoodVibesCliCommand(['listener', 'test'], configManager, root);
    expect(text.result).toEqual({ handled: true, exitCode: 1 });
    expect(text.output).toContain('bind posture: Local Network');
    expect(text.output).toContain('readiness: needs attention');
    expect(text.output).toContain('HTTP listener is enabled but service mode is off.');
    expect(text.output).toContain('Network-facing listener has no local auth user store.');
    expect(text.output).toContain('Slack is enabled but missing surfaces.slack.signingSecret, surfaces.slack.botToken.');

    const json = await captureGoodVibesCliCommand(['listener', 'test', '--json'], configManager, root);
    expect(json.result).toEqual({ handled: true, exitCode: 1 });
    const parsed = JSON.parse(json.output) as { issues: string[]; posture: { kind: string }; surfaces: Array<{ id: string; ready: boolean }> };
    expect(parsed.posture.kind).toBe('local-network');
    expect(parsed.issues).toContain('HTTP listener is enabled but service mode is off.');
    expect(parsed.surfaces.find((surface) => surface.id === 'slack')?.ready).toBe(false);
  });

  test('surfaces check returns failure when enabled surfaces are not ready', async () => {
    const root = makeProjectTempDir('goodvibes-cli-surfaces-check');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    configManager.setDynamic('danger.httpListener', true);
    configManager.setDynamic('surfaces.slack.enabled', true);

    const text = await captureGoodVibesCliCommand(['surfaces', 'check'], configManager, root);
    expect(text.result).toEqual({ handled: true, exitCode: 1 });
    expect(text.output).toContain('Readiness: needs attention');
    expect(text.output).toContain('Slack is enabled but missing surfaces.slack.signingSecret, surfaces.slack.botToken.');

    const json = await captureGoodVibesCliCommand(['surfaces', 'check', '--json'], configManager, root);
    expect(json.result).toEqual({ handled: true, exitCode: 1 });
    const parsed = JSON.parse(json.output) as { readinessIssues: string[] };
    expect(parsed.readinessIssues.some((issue) => issue.includes('Slack is enabled but missing'))).toBe(true);
  });

  test('surfaces check reports disabled feature gates for configured surfaces', async () => {
    const root = makeProjectTempDir('goodvibes-cli-surfaces-feature-gates');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    configManager.setDynamic('danger.httpListener', true);
    configManager.setDynamic('surfaces.ntfy.enabled', true);
    configManager.setDynamic('surfaces.ntfy.baseUrl', 'https://ntfy.example.test');
    configManager.setDynamic('surfaces.ntfy.topic', 'goodvibes');
    configManager.setDynamic('surfaces.ntfy.chatTopic', 'custom-chat');
    configManager.setDynamic('surfaces.ntfy.agentTopic', 'custom-agent');
    configManager.setDynamic('surfaces.ntfy.remoteTopic', 'custom-remote');
    // The channel capabilities ship ON; switch two required ones off through
    // their domain settings keys so the gate report has something honest to say.
    configManager.setDynamic('controlPlane.gateway', false);
    configManager.setDynamic('integrations.deliveryTracking', false);

    const text = await captureGoodVibesCliCommand(['surfaces', 'check', 'ntfy'], configManager, root);
    expect(text.result).toEqual({ handled: true, exitCode: 1 });
    // User-facing text names the canonical domain settings keys the user can set,
    // not the internal gate ids ('control-plane-gateway' / 'delivery-engine').
    expect(text.output).toContain('ntfy is enabled but these settings are off:');
    expect(text.output).toContain('controlPlane.gateway');
    expect(text.output).toContain('integrations.deliveryTracking');
    expect(text.output).not.toContain('control-plane-gateway');
    expect(text.output).not.toContain('delivery-engine');
    expect(text.output).toContain('chat: custom-chat');
    expect(text.output).toContain('agent: custom-agent');
    expect(text.output).toContain('daemon-only remote: custom-remote');
    expect(text.output).not.toContain('Web surface is enabled');
  });

  test('bundle inspect resolves relative paths from the GoodVibes working directory', async () => {
    const root = makeProjectTempDir('goodvibes-cli-bundle');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    const bundlePath = join(root, 'support-bundle.json');
    writeFileSync(bundlePath, JSON.stringify({
      type: 'goodvibes.setup',
      version: 1,
      capturedAt: 0,
      config: { web: { enabled: true } },
    }), 'utf-8');
    const cli = parseGoodVibesCli(['bundle', 'inspect', 'support-bundle.json']);
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      const result = await handleGoodVibesCliCommand({
        cli,
        configManager,
        workingDirectory: root,
        homeDirectory: root,
      });
      expect(result).toEqual({ handled: true, exitCode: 0 });
    } finally {
      console.log = originalLog;
    }

    expect(logs.join('\n')).toContain(`path: ${bundlePath}`);
  });

  test('bundle export redacts secret config values and import skips redacted sentinels', async () => {
    const root = makeProjectTempDir('goodvibes-cli-bundle-redaction');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    configManager.setDynamic('surfaces.slack.signingSecret', 'slack-secret-value');
    configManager.setDynamic('surfaces.slack.botToken', 'xoxb-secret-value');
    configManager.setDynamic('surfaces.slack.defaultChannel', 'goodvibes-alerts');
    const logPath = join(root, '.goodvibes', 'tui', 'service', 'manual.log');
    mkdirSync(join(root, '.goodvibes', 'tui', 'service'), { recursive: true });
    writeFileSync(logPath, 'failed with slack-secret-value and xoxb-secret-value\n', 'utf-8');
    configManager.setDynamic('service.logPath', logPath);

    const exported = await captureGoodVibesCliCommand(['bundle', 'export', 'support-bundle.json'], configManager, root);
    expect(exported.result).toEqual({ handled: true, exitCode: 0 });
    const raw = readFileSync(join(root, 'support-bundle.json'), 'utf-8');
    expect(raw).not.toContain('slack-secret-value');
    expect(raw).not.toContain('xoxb-secret-value');
    expect(raw).toContain('<redacted>');
    const bundle = JSON.parse(raw) as {
      config: { surfaces: { slack: { signingSecret: string; botToken: string; defaultChannel: string } } };
      redaction: { redactedConfigPaths: string[] };
      diagnostics: { service: { issues: string[] } };
    };
    expect(bundle.config.surfaces.slack.signingSecret).toBe('<redacted>');
    expect(bundle.config.surfaces.slack.botToken).toBe('<redacted>');
    expect(bundle.config.surfaces.slack.defaultChannel).toBe('goodvibes-alerts');
    expect(bundle.redaction.redactedConfigPaths).toContain('surfaces.slack.signingSecret');
    expect(bundle.diagnostics.service.issues).toBeArray();

    const importRoot = makeProjectTempDir('goodvibes-cli-bundle-import');
    const importedConfig = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(importRoot, '.goodvibes', 'tui'),
      workingDir: importRoot,
    });
    const imported = await captureGoodVibesCliCommand(['bundle', 'import', join(root, 'support-bundle.json')], importedConfig, importRoot);
    expect(imported.result).toEqual({ handled: true, exitCode: 0 });
    expect(imported.output).toContain('redacted values skipped');
    expect(importedConfig.get('surfaces.slack.signingSecret')).toBe('');
    expect(importedConfig.get('surfaces.slack.botToken')).toBe('');
    expect(importedConfig.get('surfaces.slack.defaultChannel')).toBe('goodvibes-alerts');
  });

  test('service check reports lifecycle posture with failing readiness exit code', async () => {
    const root = makeProjectTempDir('goodvibes-cli-service-check');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    configManager.setDynamic('service.enabled', true);
    configManager.setDynamic('service.autostart', true);
    configManager.setDynamic('service.restartOnFailure', true);
    configManager.setDynamic('service.platform', 'manual');
    configManager.setDynamic('controlPlane.enabled', true);

    const text = await captureGoodVibesCliCommand(['service', 'check'], configManager, root);
    expect(text.result).toEqual({ handled: true, exitCode: 1 });
    expect(text.output).toContain('GoodVibes service');
    expect(text.output).toContain('Readiness: needs attention');
    expect(text.output).toContain('Service mode is enabled but no platform service definition is installed.');

    const json = await captureGoodVibesCliCommand(['service', 'check', '--json'], configManager, root);
    expect(json.result).toEqual({ handled: true, exitCode: 1 });
    const parsed = JSON.parse(json.output) as { managed: { installed: boolean }; endpoints: Array<{ id: string }>; issues: string[] };
    expect(parsed.managed.installed).toBe(false);
    expect(parsed.endpoints.some((endpoint) => endpoint.id === 'controlPlane')).toBe(true);
    expect(parsed.issues).toContain('Service mode is enabled but no platform service definition is installed.');
  });

  test('control-plane status returns readiness failures for enabled unreachable network posture', async () => {
    const root = makeProjectTempDir('goodvibes-cli-control-plane-check');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    configManager.setDynamic('controlPlane.enabled', true);
    configManager.setDynamic('controlPlane.hostMode', 'network');
    configManager.setDynamic('controlPlane.host', '0.0.0.0');
    configManager.setDynamic('service.enabled', false);

    const text = await captureGoodVibesCliCommand(['control-plane', 'status'], configManager, root);
    expect(text.result).toEqual({ handled: true, exitCode: 1 });
    expect(text.output).toContain('bind posture: Local Network');
    expect(text.output).toContain('readiness: needs attention');
    expect(text.output).toContain('Control plane is enabled but service mode is off.');
    expect(text.output).toContain('Network-facing control plane has no local auth user store.');

    const json = await captureGoodVibesCliCommand(['control-plane', 'status', '--json'], configManager, root);
    expect(json.result).toEqual({ handled: true, exitCode: 1 });
    const parsed = JSON.parse(json.output) as { posture: { kind: string }; issues: string[] };
    expect(parsed.posture.kind).toBe('local-network');
    expect(parsed.issues).toContain('Control plane is enabled but service mode is off.');
  });

  test('providers and models commands surface setup posture through CLI output', async () => {
    const root = makeProjectTempDir('goodvibes-cli-provider-posture');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });

    const providersText = await captureGoodVibesCliCommand(['providers', 'inspect', 'openai-subscriber'], configManager, root);
    expect(providersText.result).toEqual({ handled: true, exitCode: 0 });
    expect(providersText.output).toContain('setup: Subscription');

    const providersJson = await captureGoodVibesCliCommand(['providers', 'inspect', 'openai-subscriber', '--json'], configManager, root);
    expect(providersJson.result).toEqual({ handled: true, exitCode: 0 });
    expect((JSON.parse(providersJson.output) as { setup: { setupClass: string } }).setup.setupClass).toBe('subscription');

    const modelsText = await captureGoodVibesCliCommand(['models', 'current'], configManager, root);
    expect(modelsText.result).toEqual({ handled: true, exitCode: 0 });
    expect(modelsText.output).toContain('setup:');
    expect(modelsText.output).toContain('provider configured:');

    const modelsJson = await captureGoodVibesCliCommand(['models', 'current', '--json'], configManager, root);
    expect(modelsJson.result).toEqual({ handled: true, exitCode: 0 });
    expect((JSON.parse(modelsJson.output) as { setup: { setupClass: string } }).setup.setupClass).toBeString();
  });

  test('secrets test redacts resolved secret values in text and json output', async () => {
    const root = makeProjectTempDir('goodvibes-cli-secret-redaction');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    const secretValue = 'gv-sensitive-value-that-must-not-print';
    const previousSecretValue = process.env.GV_CLI_SECRET_REDACTION;
    process.env.GV_CLI_SECRET_REDACTION = secretValue;

    try {
      const text = await captureGoodVibesCliCommand(['secrets', 'test', 'goodvibes://secrets/env/GV_CLI_SECRET_REDACTION'], configManager, root);
      expect(text.result).toEqual({ handled: true, exitCode: 0 });
      expect(text.output).toContain('resolved <redacted>');
      expect(text.output).not.toContain(secretValue);

      const json = await captureGoodVibesCliCommand(['secrets', 'test', 'goodvibes://secrets/env/GV_CLI_SECRET_REDACTION', '--json'], configManager, root);
      expect(json.result).toEqual({ handled: true, exitCode: 0 });
      expect(json.output).not.toContain(secretValue);
      expect(JSON.parse(json.output)).toEqual({
        ref: 'env:GV_CLI_SECRET_REDACTION',
        resolved: true,
      });
    } finally {
      if (previousSecretValue === undefined) delete process.env.GV_CLI_SECRET_REDACTION;
      else process.env.GV_CLI_SECRET_REDACTION = previousSecretValue;
    }
  });

  test('rejects invalid runtime config overrides', () => {
    const root = makeProjectTempDir('goodvibes-cli-config-invalid');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });

    const errors = applyRuntimeConfigOverrides(configManager, [
      'controlPlane.port=99999',
      'not.real=true',
    ]);

    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('Invalid --config controlPlane.port=99999');
    expect(errors[1]).toContain('Unknown config key: not.real');
    expect(configManager.get('controlPlane.port')).toBe(3421);
  });

  // ---------------------------------------------------------------------------
  // applyRuntimeConfigDefault, persisted-value precedence
  // ---------------------------------------------------------------------------

  test('applyRuntimeConfigDefault: respects explicit false in global settings file', () => {
    const root = makeProjectTempDir('goodvibes-config-default-global');
    const configDir = join(root, '.goodvibes', 'tui');
    mkdirSync(configDir, { recursive: true });
    // Write explicit false for display.showTokenSpeed to global settings file.
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ display: { showTokenSpeed: false } }), 'utf-8');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir: root });

    // Attempt to apply a TUI default of true, user's explicit false must win.
    applyRuntimeConfigDefault(configManager, 'display.showTokenSpeed', true);

    expect(configManager.get('display.showTokenSpeed')).toBe(false);
  });

  test('applyRuntimeConfigDefault: respects explicit false in project settings file when global file lacks the key', () => {
    // Use separate directories so global and project config paths are distinct.
    const globalRoot = makeProjectTempDir('goodvibes-config-default-global-dir');
    const projectRoot = makeProjectTempDir('goodvibes-config-default-project-dir');
    // Global configDir is in globalRoot, no settings file there (key absent globally).
    const configDir = join(globalRoot, '.goodvibes', 'tui');
    // Project config is at projectRoot/.goodvibes/tui/settings.json.
    const projectConfigDir = join(projectRoot, '.goodvibes', 'tui');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'settings.json'), JSON.stringify({ display: { showTokenSpeed: false } }), 'utf-8');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir: projectRoot });

    // Attempt to apply a TUI default of true, project-scoped explicit false must win.
    applyRuntimeConfigDefault(configManager, 'display.showTokenSpeed', true);

    expect(configManager.get('display.showTokenSpeed')).toBe(false);
  });

  test('applyRuntimeConfigDefault: applies default when key absent from both global and project files', () => {
    const root = makeProjectTempDir('goodvibes-config-default-absent');
    const configDir = join(root, '.goodvibes', 'tui');
    // Neither global nor project settings file contains display.showTokenSpeed.
    // No files written, clean install scenario.
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir: root });

    // SDK default is false; TUI default is true, the TUI default must be applied.
    applyRuntimeConfigDefault(configManager, 'display.showTokenSpeed', true);

    expect(configManager.get('display.showTokenSpeed')).toBe(true);
    // Must not have written a settings file to disk.
    expect(existsSync(join(configDir, 'settings.json'))).toBe(false);
  });

  test('applyRuntimeConfigDefault: corrupt global settings file does not block project file; explicit false respected', () => {
    // Construct ConfigManager with valid files first so the SDK initialises cleanly,
    // then overwrite the global settings file with malformed JSON to simulate on-disk
    // corruption that occurs after startup. applyRuntimeConfigDefault reads the raw
    // file directly, so the per-path isolation must handle the parse failure without
    // abandoning the project file check.
    const globalRoot = makeProjectTempDir('goodvibes-config-default-corrupt-global');
    const projectRoot = makeProjectTempDir('goodvibes-config-default-corrupt-global-proj');
    const configDir = join(globalRoot, '.goodvibes', 'tui');
    const projectConfigDir = join(projectRoot, '.goodvibes', 'tui');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectConfigDir, { recursive: true });
    // Construct with a valid (empty) global file so the SDK initialises cleanly.
    writeFileSync(join(configDir, 'settings.json'), '{}', 'utf-8');
    // Project file explicitly sets the key to false.
    writeFileSync(join(projectConfigDir, 'settings.json'), JSON.stringify({ display: { showTokenSpeed: false } }), 'utf-8');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir: projectRoot });
    // Now corrupt the global file on disk after construction.
    writeFileSync(join(configDir, 'settings.json'), '{not valid json', 'utf-8');

    applyRuntimeConfigDefault(configManager, 'display.showTokenSpeed', true);

    // User's explicit false in the project file must win even though the global file is corrupt.
    expect(configManager.get('display.showTokenSpeed')).toBe(false);
  });

  test('applyRuntimeConfigDefault: corrupt project settings file does not block global file; explicit false respected', () => {
    // Construct ConfigManager with valid files first so the SDK initialises cleanly,
    // then overwrite the project settings file with malformed JSON to simulate on-disk
    // corruption after startup. The global file explicitly sets the key to false:
    // the per-path isolation must still find and respect it.
    const globalRoot = makeProjectTempDir('goodvibes-config-default-corrupt-project');
    const projectRoot = makeProjectTempDir('goodvibes-config-default-corrupt-project-proj');
    const configDir = join(globalRoot, '.goodvibes', 'tui');
    const projectConfigDir = join(projectRoot, '.goodvibes', 'tui');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectConfigDir, { recursive: true });
    // Global file explicitly sets the key to false.
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ display: { showTokenSpeed: false } }), 'utf-8');
    // Construct with a valid (empty) project file so the SDK initialises cleanly.
    writeFileSync(join(projectConfigDir, 'settings.json'), '{}', 'utf-8');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir: projectRoot });
    // Now corrupt the project file on disk after construction.
    writeFileSync(join(projectConfigDir, 'settings.json'), '{not valid json', 'utf-8');

    applyRuntimeConfigDefault(configManager, 'display.showTokenSpeed', true);

    // User's explicit false in the global file must win even though the project file is corrupt.
    expect(configManager.get('display.showTokenSpeed')).toBe(false);
  });
});
