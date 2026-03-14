import { logger } from './logger.ts';

/**
 * copyToClipboard - Uses OSC 52 escape sequence to copy text.
 */
export function copyToClipboard(text: string) {
  if (!text) return;
  logger.info('Clipboard: Attempting to copy via OSC 52', { length: text.length });
  try {
    const base64 = Buffer.from(text).toString('base64');
    const sequence = `\x1b]52;c;${base64}\x07`;
    process.stdout.write(sequence);
    logger.info('Clipboard: OSC 52 sequence written');
  } catch (err: unknown) {
    logger.error('Clipboard: OSC 52 copy failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * pasteFromClipboard - Attempts to read from system clipboard using platform tools.
 */
export function pasteFromClipboard(): string {
  try {
    if (process.platform === 'linux') {
      // Try wl-paste (Wayland) then xclip (X11)
      const wl = Bun.spawnSync(['wl-paste', '--no-newline'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 3000,
      });
      if (wl.exitCode === 0 && wl.stdout) {
        return Buffer.from(wl.stdout).toString();
      }
      const xclip = Bun.spawnSync(['xclip', '-selection', 'clipboard', '-o'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 3000,
      });
      if (xclip.exitCode === 0 && xclip.stdout) {
        return Buffer.from(xclip.stdout).toString();
      }
    } else if (process.platform === 'darwin') {
      const pb = Bun.spawnSync(['pbpaste'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 3000,
      });
      if (pb.exitCode === 0 && pb.stdout) {
        return Buffer.from(pb.stdout).toString();
      }
    }
  } catch (err: unknown) {
    logger.error('Clipboard: Paste failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return '';
}
