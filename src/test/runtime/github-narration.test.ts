import { describe, expect, test } from 'bun:test';
import { narrateInboundEvent } from '../../runtime/bootstrap-core.ts';

// ---------------------------------------------------------------------------
// narrateInboundEvent — operator narration of inbound channel events
// ---------------------------------------------------------------------------

describe('narrateInboundEvent', () => {
  test('returns a narration string for a github source event', () => {
    const msg = narrateInboundEvent({
      source: 'github',
      metadata: { surface: 'github', eventType: 'pull_request', eventAction: 'opened' },
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('[GitHub]');
    expect(msg).toContain('pull_request');
    expect(msg).toContain('opened');
  });

  test('returns a narration string for a github source with no eventType', () => {
    const msg = narrateInboundEvent({
      source: 'github',
      metadata: { surface: 'github' },
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('[GitHub]');
  });

  test('returns narration for surface=github in metadata even if source is webhook', () => {
    const msg = narrateInboundEvent({
      source: 'webhook',
      metadata: { surface: 'github', eventType: 'issues', eventAction: 'opened' },
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('[GitHub]');
    expect(msg).toContain('issues');
  });

  test('returns narration for slack surface', () => {
    const msg = narrateInboundEvent({
      source: 'slack',
      metadata: { surface: 'slack' },
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('[Slack]');
  });

  test('returns narration for ntfy-chat source', () => {
    const msg = narrateInboundEvent({
      source: 'ntfy-chat',
      metadata: { surface: 'ntfy', topic: 'goodvibes-chat' },
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('[ntfy]');
    expect(msg).toContain('goodvibes-chat');
  });

  test('returns null for companion source (no operator narration needed)', () => {
    const msg = narrateInboundEvent({
      source: 'companion',
      metadata: undefined,
    });
    expect(msg).toBeNull();
  });

  test('returns null for internal/unknown source', () => {
    const msg = narrateInboundEvent({
      source: 'internal',
      metadata: undefined,
    });
    expect(msg).toBeNull();
  });

  test('returns null when source is empty', () => {
    const msg = narrateInboundEvent({ source: '', metadata: undefined });
    expect(msg).toBeNull();
  });

  test('narrates discord surface', () => {
    const msg = narrateInboundEvent({ source: 'discord', metadata: { surface: 'discord' } });
    expect(msg).not.toBeNull();
    expect(msg).toContain('[Discord]');
  });

  test('narrates homeassistant surface', () => {
    const msg = narrateInboundEvent({ source: 'homeassistant', metadata: { surface: 'homeassistant' } });
    expect(msg).not.toBeNull();
    expect(msg).toContain('[HomeAssistant]');
  });

  test('narrates telegram surface', () => {
    const msg = narrateInboundEvent({ source: 'telegram', metadata: { surface: 'telegram' } });
    expect(msg).not.toBeNull();
    expect(msg).toContain('[Telegram]');
  });

  test('includes PR number when present in github metadata', () => {
    const msg = narrateInboundEvent({
      source: 'github',
      metadata: { surface: 'github', eventType: 'pull_request', eventAction: 'opened', prNumber: 42, repo: 'owner/repo' },
    });
    expect(msg).toContain('PR #42');
    expect(msg).toContain('owner/repo');
  });

  test('includes issue number when present in github metadata', () => {
    const msg = narrateInboundEvent({
      source: 'github',
      metadata: { surface: 'github', eventType: 'issues', eventAction: 'opened', issueNumber: 7, repo: 'owner/repo' },
    });
    expect(msg).toContain('Issue #7');
    expect(msg).toContain('owner/repo');
  });
});
