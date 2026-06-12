/**
 * browser.ts — cross-platform browser launcher utility.
 *
 * Extracted from cli/management.ts so it can be used by input-layer commands
 * without creating an upward cli→input dependency. Lives in utils (Layer 0)
 * and has no imports from shell-UI or entrypoint layers.
 */

import { spawn } from 'node:child_process';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

/**
 * Open the given URL in the user's default browser.
 * Returns a status string (success or error description).
 * Does not throw — errors are returned as a descriptive string.
 */
export function openBrowser(url: string): string {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => {});
    child.unref();
    return 'browser open requested';
  } catch (error) {
    return `browser open failed: ${summarizeError(error)}`;
  }
}
