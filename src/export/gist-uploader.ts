// ---------------------------------------------------------------------------
// gist-uploader, upload export content to a GitHub Gist
// ---------------------------------------------------------------------------
//
// Architecture: UploadTarget interface with a single GistUploadTarget
// implementation. Future targets (HTTP PUT, Pastebin, etc.) implement
// UploadTarget without changing the caller in share-runtime.
//
// Token resolution:
//   1. serviceRegistry.resolveAuth('github'), standard service registry path
//      (configured via .goodvibes/tui/services.json with tokenKey: GITHUB_TOKEN)
//   2. process.env.GITHUB_TOKEN fallback
//   3. No token → honest guidance; no upload.
//
// Privacy: Gist is created as secret=true (unlisted, not private, anyone with
// the URL can view it).
// ---------------------------------------------------------------------------

import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export type UploadResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * UploadTarget, interface for pluggable export upload backends.
 * Future HTTP PUT / other targets implement this.
 */
export interface UploadTarget {
  upload(content: string, filename: string): Promise<UploadResult>;
}

export interface GistUploaderOptions {
  /**
   * GitHub PAT with `gist` scope. If not provided the uploader will try
   * process.env.GITHUB_TOKEN then return an error with guidance.
   */
  token?: string;
  /** Description shown on the Gist page. Defaults to filename. */
  description?: string;
}

/**
 * resolveGithubToken, try auth header map then env var.
 * Returns undefined when no token is available.
 */
export function resolveGithubToken(
  authHeaders: Record<string, string> | null | undefined,
): string | undefined {
  if (authHeaders) {
    // Service registry returns { Authorization: 'Bearer <token>' } for bearer type
    const authHeader = authHeaders['Authorization'] ?? authHeaders['authorization'];
    if (authHeader) {
      const match = /^Bearer (.+)$/.exec(authHeader);
      if (match?.[1]) return match[1];
    }
    // Fallback: raw token value under any key that contains 'token'
    for (const [key, val] of Object.entries(authHeaders)) {
      if (key.toLowerCase().includes('token') && val) return val;
    }
  }
  // Env var fallback
  const envToken = process.env['GITHUB_TOKEN'];
  return envToken || undefined;
}

/**
 * GistUploadTarget, uploads content to a secret (unlisted) GitHub Gist.
 */
export class GistUploadTarget implements UploadTarget {
  private readonly token: string;
  private readonly description: string;

  constructor(token: string, description?: string) {
    this.token = token;
    this.description = description ?? 'GoodVibes session export';
  }

  async upload(content: string, filename: string): Promise<UploadResult> {
    const body = JSON.stringify({
      description: this.description,
      public: false, // secret gist: unlisted, not private
      files: {
        [filename]: { content },
      },
    });

    let response: Response;
    try {
      response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body,
      });
    } catch (fetchErr: unknown) {
      const msg = summarizeError(fetchErr);
      return { ok: false, error: `Network error: ${msg}` };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        error: `GitHub API error ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, error: 'GitHub API returned non-JSON response' };
    }

    const gistUrl = (json as Record<string, unknown>)['html_url'];
    if (typeof gistUrl !== 'string') {
      return { ok: false, error: 'GitHub API response missing html_url field' };
    }

    return { ok: true, url: gistUrl };
  }
}

/**
 * noTokenGuidance, message printed when no GitHub PAT is found.
 */
export const NO_TOKEN_GUIDANCE = [
  'No GitHub token found for --upload.',
  'To enable Gist upload, configure a GitHub service entry:',
  '  /services import .goodvibes/tui/services.json  (if already configured)',
  'Or set the GITHUB_TOKEN environment variable to a PAT with the `gist` scope.',
  'Token is sent to api.github.com only. Gists are secret (unlisted, not private).',
].join('\n');
