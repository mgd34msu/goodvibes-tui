import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../config/index.ts';
import {
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
  // parseCliFlags itself does not read env vars — it only returns parsed flag
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

  test('flag overrides env for daemon-home — flag present, env set', () => {
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

  test('flag overrides env for working-dir — flag present, env set', () => {
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
    for (const command of ['surfaces', 'control-plane', 'bundle', 'remote', 'bridge'] as const) {
      expect(parseGoodVibesCli([command]).command).toBe(command);
    }
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
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-cli-config-'));
    const configDir = join(root, '.goodvibes', 'tui');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir: root });

    const errors = applyRuntimeConfigOverrides(configManager, [
      'controlPlane.port=4567',
      'behavior.autoApprove=true',
    ]);
    applyRuntimeConfigValue(configManager, 'provider.model', 'openai:gpt-5.2');
    applyRuntimeFeatureFlagOverrides(configManager, {
      enableFeatures: ['output-schema-fingerprint'],
      disableFeatures: ['fetch-sanitization'],
    });

    expect(errors).toEqual([]);
    expect(configManager.get('controlPlane.port')).toBe(4567);
    expect(configManager.get('behavior.autoApprove')).toBe(true);
    expect(configManager.get('provider.model')).toBe('openai:gpt-5.2');
    expect(configManager.getCategory('featureFlags')).toEqual({
      'output-schema-fingerprint': 'enabled',
      'fetch-sanitization': 'disabled',
    });
    expect(existsSync(join(configDir, 'settings.json'))).toBe(false);

    const reloaded = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir: root });
    expect(reloaded.get('controlPlane.port')).toBe(3421);
    expect(reloaded.get('behavior.autoApprove')).toBe(false);
    expect(reloaded.get('provider.model')).not.toBe('openai:gpt-5.2');
    expect(reloaded.getCategory('featureFlags')).toEqual({});
  });

  test('applies endpoint flags for CLI commands without persisting settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-cli-endpoint-'));
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
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-cli-surface-web-'));
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
    expect(configManager.get('danger.daemon')).toBe(true);
    expect(configManager.get('service.enabled')).toBe(true);
    expect(configManager.get('service.autostart')).toBe(true);
    expect(configManager.get('service.restartOnFailure')).toBe(true);
  });

  test('surface enable respects explicit local host overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-cli-surface-local-web-'));
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
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-cli-surface-slack-'));
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
  });

  test('listener test reports readiness issues for network webhook posture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-cli-listener-readiness-'));
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
    expect(text.result).toEqual({ handled: true, exitCode: 0 });
    expect(text.output).toContain('bind posture: Local Network');
    expect(text.output).toContain('readiness: needs attention');
    expect(text.output).toContain('HTTP listener is enabled but service mode is off.');
    expect(text.output).toContain('Network-facing listener has no local auth user store.');
    expect(text.output).toContain('Slack is enabled but missing surfaces.slack.signingSecret, surfaces.slack.botToken.');

    const json = await captureGoodVibesCliCommand(['listener', 'test', '--json'], configManager, root);
    const parsed = JSON.parse(json.output) as { issues: string[]; posture: { kind: string }; surfaces: Array<{ id: string; ready: boolean }> };
    expect(parsed.posture.kind).toBe('local-network');
    expect(parsed.issues).toContain('HTTP listener is enabled but service mode is off.');
    expect(parsed.surfaces.find((surface) => surface.id === 'slack')?.ready).toBe(false);
  });

  test('bundle inspect resolves relative paths from the GoodVibes working directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-cli-bundle-'));
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

  test('providers and models commands surface setup posture through CLI output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-cli-provider-posture-'));
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
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-cli-secret-redaction-'));
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
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-cli-config-invalid-'));
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
});
