import { describe, test, expect } from 'bun:test';
import { createHmac } from 'crypto';
import { GitHubIntegration } from '@pellux/goodvibes-sdk/platform/integrations/github';
import type { GitHubWebhookEvent } from '@pellux/goodvibes-sdk/platform/integrations/github';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignature(payload: string, secret: string): string {
  const hmac = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return `sha256=${hmac}`;
}

function makeHeaders(event: string, extra: Record<string, string> = {}): Headers {
  const h = new Headers({ 'x-github-event': event });
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

// ---------------------------------------------------------------------------
// verifySignature
// ---------------------------------------------------------------------------

describe('GitHubIntegration.verifySignature', () => {
  const SECRET = 'test-webhook-secret';
  const PAYLOAD = JSON.stringify({ action: 'opened' });

  test('returns true for a valid signature', () => {
    const sig = makeSignature(PAYLOAD, SECRET);
    expect(GitHubIntegration.verifySignature(PAYLOAD, sig, SECRET)).toBe(true);
  });

  test('returns false for an invalid signature (wrong secret)', () => {
    const sig = makeSignature(PAYLOAD, 'wrong-secret');
    expect(GitHubIntegration.verifySignature(PAYLOAD, sig, SECRET)).toBe(false);
  });

  test('returns false for a tampered payload', () => {
    const sig = makeSignature(PAYLOAD, SECRET);
    expect(GitHubIntegration.verifySignature('{"action":"closed"}', sig, SECRET)).toBe(false);
  });

  test('returns false when signature is missing sha256= prefix', () => {
    const raw = createHmac('sha256', SECRET).update(PAYLOAD, 'utf8').digest('hex');
    expect(GitHubIntegration.verifySignature(PAYLOAD, raw, SECRET)).toBe(false);
  });

  test('returns false for empty signature', () => {
    expect(GitHubIntegration.verifySignature(PAYLOAD, '', SECRET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseEvent
// ---------------------------------------------------------------------------

describe('GitHubIntegration.parseEvent', () => {
  test('extracts type from x-github-event header', () => {
    const headers = makeHeaders('pull_request');
    const body = { action: 'opened' };
    const event = GitHubIntegration.parseEvent(headers, body);
    expect(event.type).toBe('pull_request');
    expect(event.action).toBe('opened');
    expect(event.payload).toBe(body);
  });

  test('falls back to "unknown" when header is missing', () => {
    const headers = new Headers();
    const event = GitHubIntegration.parseEvent(headers, {});
    expect(event.type).toBe('unknown');
  });

  test('uses empty string for action when not a string', () => {
    const headers = makeHeaders('issues');
    const event = GitHubIntegration.parseEvent(headers, { action: 42 });
    expect(event.action).toBe('');
  });

  test('parses push event', () => {
    const headers = makeHeaders('push');
    const body = { ref: 'refs/heads/main', commits: [] };
    const event = GitHubIntegration.parseEvent(headers, body);
    expect(event.type).toBe('push');
    expect(event.action).toBe('');
  });

  test('parses check_run event', () => {
    const headers = makeHeaders('check_run');
    const body = { action: 'completed' };
    const event = GitHubIntegration.parseEvent(headers, body);
    expect(event.type).toBe('check_run');
    expect(event.action).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// eventToPrompt
// ---------------------------------------------------------------------------

describe('GitHubIntegration.eventToPrompt', () => {
  test('returns null for unsupported event type', () => {
    const event: GitHubWebhookEvent = { type: 'deployment', action: 'created', payload: {} };
    expect(GitHubIntegration.eventToPrompt(event)).toBeNull();
  });

  test('returns null for unknown event type', () => {
    const event: GitHubWebhookEvent = { type: 'unknown', action: '', payload: {} };
    expect(GitHubIntegration.eventToPrompt(event)).toBeNull();
  });

  describe('pull_request', () => {
    const basePayload = {
      action: 'opened',
      pull_request: {
        number: 42,
        title: 'Fix the thing',
        body: 'Fixes a bug',
        diff_url: 'https://github.com/owner/repo/pull/42.diff',
        base: { ref: 'main' },
        head: { ref: 'fix/thing' },
      },
      repository: { full_name: 'owner/repo' },
    };

    test('returns a prompt for opened PR', () => {
      const event: GitHubWebhookEvent = { type: 'pull_request', action: 'opened', payload: basePayload };
      const prompt = GitHubIntegration.eventToPrompt(event);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('PR #42');
      expect(prompt).toContain('Fix the thing');
      expect(prompt).toContain('owner/repo');
    });

    test('returns a prompt for synchronize action', () => {
      const event: GitHubWebhookEvent = {
        type: 'pull_request',
        action: 'synchronize',
        payload: { ...basePayload, action: 'synchronize' },
      };
      const prompt = GitHubIntegration.eventToPrompt(event);
      expect(prompt).not.toBeNull();
    });

    test('returns a prompt for review_requested action', () => {
      const event: GitHubWebhookEvent = {
        type: 'pull_request',
        action: 'review_requested',
        payload: { ...basePayload, action: 'review_requested' },
      };
      const prompt = GitHubIntegration.eventToPrompt(event);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('review requested');
    });

    test('returns null for unhandled PR action (closed)', () => {
      const event: GitHubWebhookEvent = { type: 'pull_request', action: 'closed', payload: basePayload };
      expect(GitHubIntegration.eventToPrompt(event)).toBeNull();
    });

    test('returns null when pull_request payload is missing', () => {
      const event: GitHubWebhookEvent = {
        type: 'pull_request',
        action: 'opened',
        payload: { action: 'opened', repository: { full_name: 'owner/repo' } },
      };
      expect(GitHubIntegration.eventToPrompt(event)).toBeNull();
    });
  });

  describe('issues', () => {
    const basePayload = {
      action: 'opened',
      issue: {
        number: 7,
        title: 'Something is broken',
        body: 'It crashes on startup',
        labels: [{ name: 'bug' }],
      },
      repository: { full_name: 'owner/repo' },
    };

    test('returns a prompt for opened issue', () => {
      const event: GitHubWebhookEvent = { type: 'issues', action: 'opened', payload: basePayload };
      const prompt = GitHubIntegration.eventToPrompt(event);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('Issue #7');
      expect(prompt).toContain('Something is broken');
      expect(prompt).toContain('bug');
    });

    test('returns null for unhandled issue action (labeled)', () => {
      const event: GitHubWebhookEvent = { type: 'issues', action: 'labeled', payload: basePayload };
      expect(GitHubIntegration.eventToPrompt(event)).toBeNull();
    });
  });

  describe('check_run', () => {
    test('returns a prompt for failed completed check_run', () => {
      const payload = {
        action: 'completed',
        check_run: {
          name: 'CI / typecheck',
          conclusion: 'failure',
          head_sha: 'abcdef1234567890',
          details_url: 'https://github.com/owner/repo/actions/runs/1',
          output: { summary: 'Type errors found' },
        },
        repository: { full_name: 'owner/repo' },
      };
      const event: GitHubWebhookEvent = { type: 'check_run', action: 'completed', payload };
      const prompt = GitHubIntegration.eventToPrompt(event);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('CI / typecheck');
      expect(prompt).toContain('owner/repo');
    });

    test('returns null for successful check_run', () => {
      const payload = {
        action: 'completed',
        check_run: { name: 'CI', conclusion: 'success', head_sha: 'abc', output: {} },
        repository: { full_name: 'owner/repo' },
      };
      const event: GitHubWebhookEvent = { type: 'check_run', action: 'completed', payload };
      expect(GitHubIntegration.eventToPrompt(event)).toBeNull();
    });

    test('returns null for non-completed check_run action', () => {
      const event: GitHubWebhookEvent = { type: 'check_run', action: 'created', payload: {} };
      expect(GitHubIntegration.eventToPrompt(event)).toBeNull();
    });
  });

  describe('push', () => {
    test('returns a prompt for push to main', () => {
      const payload = {
        ref: 'refs/heads/main',
        commits: [
          { id: 'abc12345', message: 'feat: add feature' },
          { id: 'def67890', message: 'fix: correct bug' },
        ],
        repository: { full_name: 'owner/repo' },
      };
      const event: GitHubWebhookEvent = { type: 'push', action: '', payload };
      const prompt = GitHubIntegration.eventToPrompt(event);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('refs/heads/main');
      expect(prompt).toContain('abc12345');
    });

    test('returns null for push to non-main branch', () => {
      const payload = {
        ref: 'refs/heads/feature/my-feature',
        commits: [],
        repository: { full_name: 'owner/repo' },
      };
      const event: GitHubWebhookEvent = { type: 'push', action: '', payload };
      expect(GitHubIntegration.eventToPrompt(event)).toBeNull();
    });
  });

  describe('issue_comment', () => {
    test('returns a prompt when comment mentions @goodvibes', () => {
      const payload = {
        action: 'created',
        comment: { body: 'Hey @goodvibes can you review this?' },
        issue: { number: 12, pull_request: {} },
        repository: { full_name: 'owner/repo' },
      };
      const event: GitHubWebhookEvent = { type: 'issue_comment', action: 'created', payload };
      const prompt = GitHubIntegration.eventToPrompt(event);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('PR');
      expect(prompt).toContain('#12');
    });

    test('returns null when comment does not mention bot', () => {
      const payload = {
        action: 'created',
        comment: { body: 'Just a regular comment' },
        issue: { number: 12 },
        repository: { full_name: 'owner/repo' },
      };
      const event: GitHubWebhookEvent = { type: 'issue_comment', action: 'created', payload };
      expect(GitHubIntegration.eventToPrompt(event)).toBeNull();
    });

    test('returns null for non-created action', () => {
      const event: GitHubWebhookEvent = { type: 'issue_comment', action: 'deleted', payload: {} };
      expect(GitHubIntegration.eventToPrompt(event)).toBeNull();
    });
  });
});
