import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubWebhookEvent {
  /** GitHub event type from X-GitHub-Event header (e.g. 'pull_request', 'issues') */
  type: string;
  /** Action field from the payload (e.g. 'opened', 'synchronize') */
  action: string;
  /** Raw webhook payload */
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GitHubIntegration
// ---------------------------------------------------------------------------

/**
 * GitHubIntegration — HMAC verification, event parsing, prompt generation,
 * and outbound GitHub API calls (comments, reviews).
 */
export class GitHubIntegration {
  /**
   * Verify an HMAC-SHA256 webhook signature.
   * GitHub sends: X-Hub-Signature-256: sha256=<hex>
   */
  static verifySignature(payload: string, signature: string, secret: string): boolean {
    if (!signature.startsWith('sha256=')) return false;
    const sig = signature.slice('sha256='.length);
    const expected = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
    if (sig.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  }

  /**
   * Parse a GitHub webhook payload into a structured event.
   * The event type comes from the X-GitHub-Event header.
   */
  static parseEvent(headers: Headers, body: Record<string, unknown>): GitHubWebhookEvent {
    const type = headers.get('x-github-event') ?? 'unknown';
    const action = typeof body.action === 'string' ? body.action : '';
    return { type, action, payload: body };
  }

  /**
   * Convert a GitHub webhook event into an agent prompt.
   * Returns null if the event does not warrant agent action.
   */
  static eventToPrompt(event: GitHubWebhookEvent): string | null {
    const { type, action, payload } = event;

    switch (type) {
      case 'pull_request': {
        if (!['opened', 'synchronize', 'review_requested'].includes(action)) return null;
        const pr = payload.pull_request as Record<string, unknown> | undefined;
        const repo = (payload.repository as Record<string, unknown> | undefined);
        if (!pr || !repo) return null;

        const prNumber = pr.number as number;
        const prTitle = pr.title as string;
        const prBody = (pr.body as string | null) ?? '';
        const baseBranch = (pr.base as Record<string, unknown>)?.ref as string;
        const headBranch = (pr.head as Record<string, unknown>)?.ref as string;
        const repoFullName = repo.full_name as string;
        const diffUrl = pr.diff_url as string;

        return [
          `GitHub Pull Request ${action === 'review_requested' ? 'review requested' : action} on ${repoFullName}.`,
          `PR #${prNumber}: "${prTitle}"`,
          `Base: ${baseBranch} ← Head: ${headBranch}`,
          prBody ? `Description:\n${prBody}` : '',
          `Diff URL: ${diffUrl}`,
          '',
          'Please review this pull request:',
          '- Check for correctness, logic errors, and edge cases',
          '- Identify potential security issues',
          '- Suggest improvements to code quality and readability',
          '- Note any missing tests or documentation',
          `After analysis, post a review comment on PR #${prNumber} of ${repoFullName}.`,
        ].filter(Boolean).join('\n');
      }

      case 'issues': {
        if (!['opened', 'assigned'].includes(action)) return null;
        const issue = payload.issue as Record<string, unknown> | undefined;
        const repo = (payload.repository as Record<string, unknown> | undefined);
        if (!issue || !repo) return null;

        const issueNumber = issue.number as number;
        const issueTitle = issue.title as string;
        const issueBody = (issue.body as string | null) ?? '';
        const repoFullName = repo.full_name as string;
        const labels = Array.isArray(issue.labels)
          ? (issue.labels as Array<Record<string, unknown>>).map((l) => l.name as string).join(', ')
          : '';

        return [
          `GitHub Issue ${action} on ${repoFullName}.`,
          `Issue #${issueNumber}: "${issueTitle}"`,
          labels ? `Labels: ${labels}` : '',
          issueBody ? `Description:\n${issueBody}` : '',
          '',
          'Please analyze this issue and suggest an implementation approach:',
          '- Identify relevant files and code areas',
          '- Outline a solution strategy',
          '- Note any potential complications or dependencies',
          `Post a comment on issue #${issueNumber} of ${repoFullName} with your analysis.`,
        ].filter(Boolean).join('\n');
      }

      case 'check_run': {
        if (action !== 'completed') return null;
        const checkRun = payload.check_run as Record<string, unknown> | undefined;
        if (!checkRun || checkRun.conclusion !== 'failure') return null;
        const repo = (payload.repository as Record<string, unknown> | undefined);
        if (!repo) return null;

        const checkName = checkRun.name as string;
        const detailsUrl = checkRun.details_url as string | undefined;
        const headSha = (checkRun.head_sha as string | undefined)?.slice(0, 8);
        const repoFullName = repo.full_name as string;
        const output = checkRun.output as Record<string, unknown> | undefined;
        const summary = (output?.summary as string | null) ?? '';

        return [
          `CI check "${checkName}" failed on ${repoFullName} at commit ${headSha}.`,
          summary ? `Summary:\n${summary}` : '',
          detailsUrl ? `Details: ${detailsUrl}` : '',
          '',
          'Please analyze this CI failure:',
          '- Identify the root cause of the failure',
          '- Suggest fixes',
          '- Check if related code changes could have introduced this failure',
        ].filter(Boolean).join('\n');
      }

      case 'check_suite': {
        if (action !== 'completed') return null;
        const suite = payload.check_suite as Record<string, unknown> | undefined;
        if (!suite || suite.conclusion !== 'failure') return null;
        const repo = (payload.repository as Record<string, unknown> | undefined);
        if (!repo) return null;

        const repoFullName = repo.full_name as string;
        const headSha = (suite.head_sha as string | undefined)?.slice(0, 8);
        const headBranch = suite.head_branch as string | undefined;

        return [
          `CI check suite failed on ${repoFullName}${headBranch ? ` (branch: ${headBranch})` : ''} at commit ${headSha}.`,
          '',
          'Please analyze the CI failure and identify what caused the check suite to fail.',
        ].filter(Boolean).join('\n');
      }

      case 'push': {
        const ref = payload.ref as string | undefined;
        if (!ref || !['refs/heads/main', 'refs/heads/master'].includes(ref)) return null;
        const repo = (payload.repository as Record<string, unknown> | undefined);
        if (!repo) return null;

        const repoFullName = repo.full_name as string;
        const commits = Array.isArray(payload.commits)
          ? (payload.commits as Array<Record<string, unknown>>)
          : [];
        const commitMessages = commits
          .slice(0, 20)
          .map((c) => `- ${c.id as string | undefined ? (c.id as string).slice(0, 8) : '?'}: ${c.message as string}`)
          .join('\n');

        return [
          `New commits pushed to ${ref} on ${repoFullName}.`,
          commits.length > 0 ? `Commits:\n${commitMessages}` : '',
          '',
          'Please generate a changelog entry for these commits:',
          '- Group changes by type (feat, fix, chore, docs, etc.)',
          '- Write user-facing descriptions',
          '- Highlight breaking changes if any',
        ].filter(Boolean).join('\n');
      }

      case 'issue_comment': {
        if (action !== 'created') return null;
        const comment = payload.comment as Record<string, unknown> | undefined;
        const issue = payload.issue as Record<string, unknown> | undefined;
        const repo = (payload.repository as Record<string, unknown> | undefined);
        if (!comment || !issue || !repo) return null;

        const body = (comment.body as string | null) ?? '';
        // Only respond to comments mentioning the bot
        if (!body.includes('@bot') && !body.includes('@goodvibes')) return null;

        const issueNumber = issue.number as number;
        const repoFullName = repo.full_name as string;
        const isPR = Boolean(issue.pull_request);

        return [
          `Bot mention in ${isPR ? 'PR' : 'issue'} #${issueNumber} on ${repoFullName}.`,
          `Comment:\n${body}`,
          '',
          'Please respond to this comment. Address the specific request or question raised.',
          `Post your response as a comment on ${isPR ? 'PR' : 'issue'} #${issueNumber} of ${repoFullName}.`,
        ].filter(Boolean).join('\n');
      }

      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Outbound GitHub API
  // -------------------------------------------------------------------------

  /**
   * Post a comment on a pull request.
   */
  async postPRComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    token: string,
  ): Promise<void> {
    await this.githubPost(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      { body },
      token,
    );
  }

  /**
   * Post a review on a pull request.
   */
  async postPRReview(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
    token: string,
  ): Promise<void> {
    await this.githubPost(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      { body, event },
      token,
    );
  }

  /**
   * Post a comment on an issue.
   */
  async postIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
    token: string,
  ): Promise<void> {
    await this.githubPost(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body },
      token,
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async githubPost(
    url: string,
    data: Record<string, unknown>,
    token: string,
  ): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('GitHubIntegration: API request failed', {
        url,
        status: res.status,
        body: text.slice(0, 500),
      });
      throw new Error(`GitHub API error ${res.status}: ${text.slice(0, 200)}`);
    }
  }
}
