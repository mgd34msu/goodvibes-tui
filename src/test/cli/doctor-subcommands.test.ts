import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { handleDoctorSubcommand } from '../../cli/doctor.ts';
import type { GoodVibesCliOutputFormat } from '@pellux/goodvibes-terminal-shell';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeOptions(root: string, subcommand: string, args: string[], outputFormat: GoodVibesCliOutputFormat = 'text') {
  const configManager = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
  return { configManager, subcommand, args, workingDirectory: root, homeDirectory: root, outputFormat };
}

describe('goodvibes doctor subcommands', () => {
  let root = '';
  beforeEach(() => { root = makeProjectTempDir('gv-doctor'); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('unknown subcommand returns null so the classic doctor renders', async () => {
    const result = await handleDoctorSubcommand(makeOptions(root, 'nonsense', []));
    expect(result).toBeNull();
  });

  test('routing lists the conversation role and its config keys', async () => {
    const result = await handleDoctorSubcommand(makeOptions(root, 'routing', []));
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(0);
    expect(result!.output).toContain('Conversation (main model)');
    expect(result!.output).toContain('provider.model');
    expect(result!.output).toContain('Helper');
    expect(result!.output).toContain('Tool LLM');
  });

  test('explain: read tool in prompt mode is ALLOWED without a prompt', async () => {
    const opts = makeOptions(root, 'explain', ['read', './src/x.ts']);
    opts.configManager.set('permissions.mode', 'prompt');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ALLOW');
    expect(result!.output).toContain('config_policy');
  });

  test('explain: write tool in prompt mode reaches the approval prompt (ASK)', async () => {
    const opts = makeOptions(root, 'explain', ['write', './src/x.ts']);
    opts.configManager.set('permissions.mode', 'prompt');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ASK');
    expect(result!.output).toContain('user_prompt');
    expect(result!.output).toContain('DECIDED HERE');
  });

  test('explain: a shell command in plan mode is DENIED with the plan-mode reason', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', 'build']);
    opts.configManager.set('permissions.mode', 'plan');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: DENY');
    expect(result!.output).toContain('plan_mode');
    // A bare shell command is routed through the exec tool.
    expect(result!.output).toContain('exec');
  });

  test('explain: allow-all mode approves even a destructive command', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', '/tmp/x']);
    opts.configManager.set('permissions.mode', 'allow-all');
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ALLOW');
  });

  test('explain: json output carries the authoritative verdict and layers', async () => {
    const opts = makeOptions(root, 'explain', ['write', './a.ts'], 'json');
    opts.configManager.set('permissions.mode', 'prompt');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    const parsed = JSON.parse(result!.output) as { verdict: string; sourceLayer: string; reasonCode: string };
    expect(parsed.verdict).toBe('ASK');
    expect(parsed.sourceLayer).toBe('user_prompt');
  });

  test('hooks: lists registered hooks with their source and flags an unknown event point', async () => {
    const hooksPath = join(root, 'hooks.json');
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        'Pre:tool:*': [{ name: 'guard', match: 'Pre:tool:*', type: 'command', command: 'echo hi' }],
        'Pre:bogus:thing': [{ name: 'bad', match: 'Pre:bogus:thing', type: 'command', command: 'echo x' }],
      },
    }), 'utf-8');
    const opts = makeOptions(root, 'hooks', []);
    opts.configManager.set('tools.hooksFile', hooksPath);
    const result = await handleDoctorSubcommand(opts);
    expect(result!.exitCode).toBe(1);
    expect(result!.output).toContain('[PASS] Pre:tool:*');
    expect(result!.output).toContain('[FAIL] Pre:bogus:thing');
    expect(result!.output).toContain(hooksPath);
    expect(result!.output).toContain('not a recognized hook event point');
  });

  test('hooks: reports an absent hooks file honestly', async () => {
    const opts = makeOptions(root, 'hooks', []);
    opts.configManager.set('tools.hooksFile', join(root, 'nope.json'));
    const result = await handleDoctorSubcommand(opts);
    expect(result!.exitCode).toBe(0);
    expect(result!.output).toContain('no hooks file present');
  });
});
