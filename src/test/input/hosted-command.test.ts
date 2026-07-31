/**
 * hosted-command.test.ts — the `/hosted` surface: what it says, and what it
 * refuses to say.
 *
 * The command's job is to put the daemon's own answers in front of a person
 * without editorialising them. So what is pinned here is the wording that
 * carries a fact: the detach sentence names the policy AND where the policy
 * came from, an unattached terminal says so rather than showing a blank status,
 * and the flag parsing keeps "no override" distinct from "kill" — because a
 * session with no override follows the setting, which is a different thing from
 * one pinned to the setting's current value.
 */
import { describe, test, expect } from 'bun:test';
import {
  readDetachOverride,
  renderHostedRecordLine,
  renderHostedStatus,
} from '../../input/commands/hosted-runtime.ts';
import { HostedSessionFeed } from '../../panels/hosted-session-feed.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerHostedRuntimeCommands } from '../../input/commands/hosted-runtime.ts';
import type { HostedSessionRecord } from '@pellux/goodvibes-sdk/platform/hosted-sessions';

function makeRecord(overrides: Partial<HostedSessionRecord> = {}): HostedSessionRecord {
  return {
    id: 'hosted-1',
    workspaceRoot: '/tmp/w',
    title: 'the hosted one',
    status: 'idle',
    detachPolicy: null,
    effectiveDetachPolicy: 'kill',
    attachedClients: [],
    createdAt: 1,
    updatedAt: 2,
    turnCount: 4,
    messageCount: 9,
    restoredFromDisk: false,
    ...overrides,
  };
}

describe('/hosted', () => {
  test('it registers under a name and description the palette can show', () => {
    const registry = new CommandRegistry();
    registerHostedRuntimeCommands(registry);
    const command = registry.get('hosted');
    expect(command).toBeDefined();
    expect(command!.description.length).toBeGreaterThan(20);
    expect(command!.usage).toContain('attach');
  });

  test('an unattached terminal says so and names the two ways in', () => {
    const status = renderHostedStatus(new HostedSessionFeed());
    expect(status).toContain('No hosted session is attached');
    expect(status).toContain('/hosted new');
    expect(status).toContain('/hosted list');
  });

  test('an attached terminal reports the record\'s facts, including what leaving would do', () => {
    const feed = new HostedSessionFeed();
    feed.attach(makeRecord(), []);
    feed.setStreaming(true);
    const status = renderHostedStatus(feed);

    expect(status).toContain('hosted-1');
    expect(status).toContain('4 turn(s), 9 message(s)');
    expect(status).toContain('leaving ends it (kill, from the hostedSessions.detachPolicy setting)');
    expect(status).toContain('live event stream open');
    expect(status).toContain('no tool call is running');
  });

  test('a missing stream is reported with its reason, not as a working one', () => {
    const feed = new HostedSessionFeed();
    feed.attach(makeRecord(), []);
    feed.setStreaming(false, 'the daemon would not open an event stream');
    expect(renderHostedStatus(feed)).toContain('no live stream — the daemon would not open an event stream');
  });

  test('a list row states the status, the id, the detach effect and who is attached', () => {
    const line = renderHostedRecordLine(makeRecord({ attachedClients: ['tui-a', 'tui-b'] }), 0);
    expect(line).toContain('1. the hosted one [idle]');
    expect(line).toContain('id hosted-1');
    expect(line).toContain('leaving ends it (kill');
    expect(line).toContain('attached: tui-a, tui-b');
  });

  test('a terminated row carries the reason it ended rather than just vanishing from view', () => {
    const line = renderHostedRecordLine(makeRecord({ status: 'terminated', terminatedReason: 'detached' }), 2);
    expect(line).toContain('3. the hosted one [terminated] — ended: detached');
  });

  test('no flag means "follow the setting", which is not the same as --kill', () => {
    expect(readDetachOverride(['write', 'a', 'test'])).toEqual({ policy: undefined, rest: ['write', 'a', 'test'] });
    expect(readDetachOverride(['--survive', 'write', 'a', 'test'])).toEqual({ policy: 'survive', rest: ['write', 'a', 'test'] });
    expect(readDetachOverride(['write', '--kill'])).toEqual({ policy: 'kill', rest: ['write'] });
    // Last flag wins, and the prompt is never eaten by the parse.
    expect(readDetachOverride(['--survive', 'x', '--kill'])).toEqual({ policy: 'kill', rest: ['x'] });
  });
});
