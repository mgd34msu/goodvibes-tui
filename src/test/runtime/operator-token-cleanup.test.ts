import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDaemonCompanionToken, workspaceOperatorTokenCandidates } from '../../runtime/operator-token-cleanup.ts';

describe('workspaceOperatorTokenCandidates', () => {
  test('returns the two legacy workspace-scoped operator-tokens.json paths', () => {
    const candidates = workspaceOperatorTokenCandidates('/repo');
    expect(candidates).toEqual([
      join('/repo', '.goodvibes', 'operator-tokens.json'),
      join('/repo', '.goodvibes', 'tui', 'operator-tokens.json'),
    ]);
  });
});

// External-daemon adoption: resolveDaemonCompanionToken is the single
// place that both the GOODVIBES_DAEMON_TOKEN env-var override (bootstrap.ts)
// and the onboarding wizard's "connect to an existing daemon" paste action
// (handler-onboarding.ts) go through to install a token into
// <daemonHomeDir>/operator-tokens.json.
describe('resolveDaemonCompanionToken', () => {
  const originalEnvToken = process.env.GOODVIBES_DAEMON_TOKEN;
  let root = '';
  let daemonHomeDir = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-operator-token-'));
    daemonHomeDir = join(root, '.goodvibes', 'daemon');
    delete process.env.GOODVIBES_DAEMON_TOKEN;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalEnvToken === undefined) delete process.env.GOODVIBES_DAEMON_TOKEN;
    else process.env.GOODVIBES_DAEMON_TOKEN = originalEnvToken;
  });

  test('with no override and no existing file, mints a fresh token (existing getOrCreateCompanionToken behavior)', () => {
    const record = resolveDaemonCompanionToken(daemonHomeDir);
    expect(record.token.length).toBeGreaterThan(0);
    expect(record.peerId.length).toBeGreaterThan(0);
    expect(existsSync(join(daemonHomeDir, 'operator-tokens.json'))).toBe(true);
  });

  test('with no override, reads back an existing on-disk token unchanged', () => {
    mkdirSync(daemonHomeDir, { recursive: true });
    writeFileSync(
      join(daemonHomeDir, 'operator-tokens.json'),
      JSON.stringify({ token: 'gv_existing', peerId: 'peer-existing', createdAt: 111 }),
    );
    const record = resolveDaemonCompanionToken(daemonHomeDir);
    expect(record).toEqual({ token: 'gv_existing', peerId: 'peer-existing', createdAt: 111 });
  });

  test('GOODVIBES_DAEMON_TOKEN env override writes a fresh file when none exists', () => {
    process.env.GOODVIBES_DAEMON_TOKEN = 'gv_from_env';
    const record = resolveDaemonCompanionToken(daemonHomeDir);
    expect(record.token).toBe('gv_from_env');
    const onDisk = JSON.parse(readFileSync(join(daemonHomeDir, 'operator-tokens.json'), 'utf-8')) as { token: string };
    expect(onDisk.token).toBe('gv_from_env');
  });

  test('GOODVIBES_DAEMON_TOKEN env override replaces a mismatched on-disk token but keeps the existing peerId', () => {
    mkdirSync(daemonHomeDir, { recursive: true });
    writeFileSync(
      join(daemonHomeDir, 'operator-tokens.json'),
      JSON.stringify({ token: 'gv_stale', peerId: 'peer-keep-me', createdAt: 222 }),
    );
    process.env.GOODVIBES_DAEMON_TOKEN = 'gv_from_env';
    const record = resolveDaemonCompanionToken(daemonHomeDir);
    expect(record.token).toBe('gv_from_env');
    expect(record.peerId).toBe('peer-keep-me');
    const onDisk = JSON.parse(readFileSync(join(daemonHomeDir, 'operator-tokens.json'), 'utf-8')) as { token: string; peerId: string };
    expect(onDisk).toEqual(expect.objectContaining({ token: 'gv_from_env', peerId: 'peer-keep-me' }));
  });

  test('GOODVIBES_DAEMON_TOKEN env override is a no-op (no rewrite) when it already matches the on-disk token', () => {
    mkdirSync(daemonHomeDir, { recursive: true });
    writeFileSync(
      join(daemonHomeDir, 'operator-tokens.json'),
      JSON.stringify({ token: 'gv_same', peerId: 'peer-same', createdAt: 333 }),
    );
    process.env.GOODVIBES_DAEMON_TOKEN = 'gv_same';
    const record = resolveDaemonCompanionToken(daemonHomeDir);
    expect(record).toEqual({ token: 'gv_same', peerId: 'peer-same', createdAt: 333 });
  });

  test('an explicit token argument (the onboarding paste action) takes precedence over GOODVIBES_DAEMON_TOKEN', () => {
    process.env.GOODVIBES_DAEMON_TOKEN = 'gv_from_env';
    const record = resolveDaemonCompanionToken(daemonHomeDir, 'gv_pasted_in_wizard');
    expect(record.token).toBe('gv_pasted_in_wizard');
    const onDisk = JSON.parse(readFileSync(join(daemonHomeDir, 'operator-tokens.json'), 'utf-8')) as { token: string };
    expect(onDisk.token).toBe('gv_pasted_in_wizard');
  });
});
