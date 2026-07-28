import { afterEach, beforeEach, describe, test, expect } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelPolicyManager } from '@pellux/goodvibes-sdk/platform/channels';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('ChannelPolicyManager', () => {
  let root = '';

  beforeEach(() => {
    root = makeProjectTempDir('goodvibes-channel-policy');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function createManager(): ChannelPolicyManager {
    return new ChannelPolicyManager({
      storePath: join(root, '.goodvibes', 'tui', 'channels', 'policies.json'),
    });
  }

  test('applies group-specific overrides on top of the surface policy', async () => {
    const manager = createManager();

    await manager.upsertPolicy('webhook', {
      requireMention: false,
      allowedCommands: ['/default'],
      groupPolicies: [{
        id: 'group-alpha',
        groupId: 'alpha',
        requireMention: true,
        allowedCommands: ['/group'],
      }],
    });

    const blocked = await manager.evaluateIngress({
      surface: 'webhook',
      groupId: 'alpha',
      conversationKind: 'channel',
      text: '/default test',
      mentioned: false,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('mention-required');
    expect(blocked.matchedGroupPolicy?.id).toBe('group-alpha');

    const allowed = await manager.evaluateIngress({
      surface: 'webhook',
      groupId: 'alpha',
      conversationKind: 'channel',
      text: '/group test',
      mentioned: true,
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.matchedGroupPolicy?.id).toBe('group-alpha');
  });

  test('enforces conversation kind toggles and group allowlists', async () => {
    const manager = createManager();

    await manager.upsertPolicy('slack', {
      allowDirectMessages: false,
      allowGroupMessages: true,
      allowThreadMessages: false,
      allowlistGroupIds: ['group-1'],
    });

    const direct = await manager.evaluateIngress({
      surface: 'slack',
      conversationKind: 'direct',
      text: '/status',
      mentioned: true,
    });
    expect(direct.allowed).toBe(false);
    expect(direct.reason).toBe('direct-messages-disabled');

    const missingGroup = await manager.evaluateIngress({
      surface: 'slack',
      conversationKind: 'channel',
      text: '/status',
      mentioned: true,
    });
    expect(missingGroup.allowed).toBe(false);
    expect(missingGroup.reason).toBe('missing-group-identity');

    const thread = await manager.evaluateIngress({
      surface: 'slack',
      conversationKind: 'thread',
      groupId: 'group-1',
      text: '/status',
      mentioned: true,
    });
    expect(thread.allowed).toBe(false);
    expect(thread.reason).toBe('thread-messages-disabled');

    const channel = await manager.evaluateIngress({
      surface: 'slack',
      conversationKind: 'channel',
      groupId: 'group-1',
      text: '/status',
      mentioned: true,
    });
    expect(channel.allowed).toBe(true);

    const audit = manager.listAudit(10);
    expect(audit.some((entry) => entry.groupId === 'group-1' && entry.conversationKind === 'channel')).toBe(true);
  });

  test('allows authorized control commands to bypass mention gating when configured', async () => {
    const manager = createManager();

    await manager.upsertPolicy('discord', {
      requireMention: true,
      allowTextCommandsWithoutMention: true,
      allowedCommands: ['status'],
    });

    const allowed = await manager.evaluateIngress({
      surface: 'discord',
      conversationKind: 'channel',
      groupId: 'ops',
      text: 'status run-123',
      mentioned: false,
      hasAnyMention: false,
      controlCommand: 'status',
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.effectiveRequireMention).toBe(true);
    expect(allowed.effectiveAllowedCommands).toEqual(['status']);

    const blocked = await manager.evaluateIngress({
      surface: 'discord',
      conversationKind: 'channel',
      groupId: 'ops',
      text: 'retry run-123',
      mentioned: false,
      hasAnyMention: false,
      controlCommand: 'retry',
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('mention-required');
  });

  test('requires an explicit store owner', () => {
    expect(() => new ChannelPolicyManager({})).toThrow('ChannelPolicyManager requires an explicit store or storePath');
  });
});
