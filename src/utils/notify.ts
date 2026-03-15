/**
 * notifyCompletion - Emit terminal bell and/or desktop notification on turn completion.
 * Non-fatal: all errors are silently swallowed.
 *
 * @param title     - Notification title
 * @param message   - Notification body
 * @param durationMs - Turn duration in milliseconds
 */
/** Escape a string for safe interpolation into an AppleScript string literal. */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function notifyCompletion(title: string, message: string, durationMs: number): void {
  // Terminal bell for responses > 5s
  if (durationMs > 5000) {
    process.stdout.write('\x07');
  }

  // Desktop notification for responses > 30s
  if (durationMs > 30000) {
    try {
      if (process.platform === 'linux') {
        Bun.spawn(['notify-send', title, message], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      } else if (process.platform === 'darwin') {
        const safeTitle = escapeAppleScript(title);
        const safeMessage = escapeAppleScript(message);
        Bun.spawn(
          ['osascript', '-e', `display notification "${safeMessage}" with title "${safeTitle}"`],
          { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        );
      }
    } catch {
      // Non-fatal: notification failure must never crash the app
    }
  }
}
