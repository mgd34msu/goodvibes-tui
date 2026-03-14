import { logger } from './logger.ts';
import { execSync } from 'child_process';

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
  } catch (err: any) {
    logger.error('Clipboard: OSC 52 copy failed', { error: err.message });
  }
}

/**
 * pasteFromClipboard - Attempts to read from system clipboard using platform tools.
 */
export function pasteFromClipboard(): string {
  try {
    if (process.platform === 'linux') {
      // Try wl-paste (Wayland) then xclip (X11)
      try {
        return execSync('wl-paste --no-newline', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      } catch {
        return execSync('xclip -selection clipboard -o', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      }
    } else if (process.platform === 'darwin') {
      return execSync('pbpaste').toString();
    }
  } catch (err: any) {
    logger.error('Clipboard: Paste failed', { error: err.message });
  }
  return '';
}
