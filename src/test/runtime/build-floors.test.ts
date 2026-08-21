/**
 * build-floors.test.ts, the two build floors this terminal and the daemon hold
 * against each other.
 *
 * Forward (the daemon's floor on this client): a daemon that announces a floor
 * above this build latches the guard, says so once, and the guard then refuses
 * shared-session work for the rest of the process lifetime.
 *
 * Reverse (this client's floor on the daemon): a daemon below
 * TUI_DAEMON_BUILD_FLOOR is named in one sentence carrying both versions, and
 * the sentence is not repeated on every reconnect against the same old daemon.
 *
 * The comparison itself is the SDK's; what is pinned here is this process's own
 * state, the latch, the buffered-until-attached notice, and the announce-once.
 */
import { describe, expect, test } from 'bun:test';
import {
  ClientBuildGuard,
  DaemonBuildFloor,
  TUI_DAEMON_BUILD_FLOOR,
} from '../../runtime/client/build-floors.ts';
import type { ClientCompatibilityVerdict } from '@pellux/goodvibes-sdk/platform/control-plane';

describe('ClientBuildGuard', () => {
  test('a build above the daemon floor keeps taking shared-session work, silently', () => {
    const guard = new ClientBuildGuard({ clientVersion: '1.28.0' });
    const said: ClientCompatibilityVerdict[] = [];
    guard.onRestartRequired((verdict) => said.push(verdict));

    expect(guard.observeFloor('1.27.0').status).toBe('ok');
    expect(guard.maySharedSessionWork()).toBe(true);
    expect(said).toEqual([]);
  });

  test('a daemon that announces no floor is not asking for anything', () => {
    const guard = new ClientBuildGuard({ clientVersion: '1.0.0' });
    expect(guard.observeFloor(undefined).status).toBe('ok');
    expect(guard.maySharedSessionWork()).toBe(true);
  });

  test('a build below the floor stops taking shared-session work and says so once', () => {
    const guard = new ClientBuildGuard({ clientVersion: '1.20.0' });
    const said: ClientCompatibilityVerdict[] = [];
    guard.onRestartRequired((verdict) => said.push(verdict));

    const verdict = guard.observeFloor('1.28.0');
    expect(verdict.status).toBe('restart-required');
    expect(verdict.message).toContain('1.20.0');
    expect(verdict.message).toContain('1.28.0');
    expect(guard.maySharedSessionWork()).toBe(false);

    // Every later read of the same floor is the same news, said once.
    guard.observeFloor('1.28.0');
    guard.observeFloor('1.28.0');
    expect(said).toHaveLength(1);
  });

  test('the latch holds when a later read cannot see the header at all', () => {
    const guard = new ClientBuildGuard({ clientVersion: '1.20.0' });
    guard.observeFloor('1.28.0');
    expect(guard.maySharedSessionWork()).toBe(false);

    // A restarted or truncated daemon response announcing nothing must not
    // silently re-enable work under superseded rules.
    expect(guard.observeFloor(undefined).status).toBe('restart-required');
    expect(guard.maySharedSessionWork()).toBe(false);
  });

  test('a refusal reached before the notice surface attaches is delivered on attach', () => {
    const guard = new ClientBuildGuard({ clientVersion: '1.20.0' });
    guard.observeFloor('1.28.0');

    const said: ClientCompatibilityVerdict[] = [];
    guard.onRestartRequired((verdict) => said.push(verdict));
    expect(said).toHaveLength(1);
    expect(said[0]!.status).toBe('restart-required');

    // And it is not said a second time once the sink is live.
    guard.observeFloor('1.28.0');
    expect(said).toHaveLength(1);
  });

  test('a build that reports no version cannot be checked, and is not assumed current', () => {
    const guard = new ClientBuildGuard({ clientVersion: '' });
    expect(guard.observeFloor('1.28.0').status).toBe('unknown');
    // 'unknown' is a warning, not a refusal: the daemon has not said this build
    // is too old, only that it could not be read.
    expect(guard.maySharedSessionWork()).toBe(true);
  });
});

describe('DaemonBuildFloor', () => {
  const floor = () => new DaemonBuildFloor('1.28.0');

  test('a daemon at or above the floor is adopted with nothing said', () => {
    const check = floor();
    const verdict = check.evaluate({ status: 'running', version: '1.28.0' }, 'http://127.0.0.1:3421');
    expect(verdict.status).toBe('ok');
    expect(check.noticeFor(verdict)).toBeNull();
  });

  test('a daemon below the floor is named with both versions and the fix', () => {
    const check = floor();
    const verdict = check.evaluate({ status: 'running', version: '1.27.1' }, 'http://192.168.1.9:3421');
    expect(verdict.status).toBe('daemon-update-required');
    const notice = check.noticeFor(verdict);
    expect(notice).toContain('http://192.168.1.9:3421');
    expect(notice).toContain('1.27.1');
    expect(notice).toContain('1.28.0');
    expect(notice).toContain('update the daemon');
  });

  test('a reconnect loop against one old daemon states the problem once', () => {
    const check = floor();
    const verdict = check.evaluate({ status: 'running', version: '1.27.1' }, 'http://127.0.0.1:3421');
    expect(check.noticeFor(verdict)).not.toBeNull();
    expect(check.noticeFor(check.evaluate({ status: 'running', version: '1.27.1' }, 'http://127.0.0.1:3421'))).toBeNull();
  });

  test('a daemon updated while this terminal runs is adopted, and can be refused again if it moves back', () => {
    const check = floor();
    check.noticeFor(check.evaluate({ status: 'running', version: '1.27.1' }, 'd'));

    const updated = check.evaluate({ status: 'running', version: '1.29.0' }, 'd');
    expect(updated.status).toBe('ok');
    expect(check.noticeFor(updated)).toBeNull();

    // The sentence is sayable again, because the situation genuinely changed.
    const rolledBack = check.evaluate({ status: 'running', version: '1.27.1' }, 'd');
    expect(check.noticeFor(rolledBack)).not.toBeNull();
  });

  test('a status body with no readable version cannot be checked, and says so', () => {
    const check = floor();
    const verdict = check.evaluate({ status: 'running' }, 'http://127.0.0.1:3421');
    expect(verdict.status).toBe('unknown');
    expect(check.noticeFor(verdict)).toContain('did not report a version');
  });

  test('the shipped floor is the daemon release this terminal became a client of', () => {
    expect(TUI_DAEMON_BUILD_FLOOR).toBe('1.28.0');
    const check = new DaemonBuildFloor();
    expect(check.evaluate({ version: '1.28.0' }, 'd').status).toBe('ok');
    expect(check.evaluate({ version: '1.27.9' }, 'd').status).toBe('daemon-update-required');
  });
});
