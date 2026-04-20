import { describe, expect, test } from 'bun:test';
import { parseCliFlags } from '../cli-flags.ts';

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
    let helpOutput = '';
    const originalLog: typeof console.log = console.log;
    const originalExit: typeof process.exit = process.exit;
    console.log = ((msg: string) => { helpOutput = msg; }) as typeof console.log;
    // Prevent process.exit from terminating the test runner
    process.exit = ((_code?: number | string): never => undefined as never) as typeof process.exit;
    try {
      parseCliFlags(['--help']);
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }
    expect(helpOutput).toContain('--daemon-home=');
    expect(helpOutput).toContain('--working-dir=');
    expect(helpOutput).toContain('precedence:');
    expect(helpOutput).toContain('GOODVIBES_DAEMON_HOME');
    expect(helpOutput).toContain('GOODVIBES_WORKING_DIR');
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
});
