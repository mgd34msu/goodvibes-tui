import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { allowTerminalWrite } from '../runtime/terminal-output-guard.ts';

/**
 * copyToClipboard - Uses OSC 52 escape sequence to copy text to the terminal clipboard.
 * Terminal-specific: only works in terminals that support OSC 52.
 */
export function copyToClipboard(text: string) {
  if (!text) return;
  logger.info('Clipboard: Attempting to copy via OSC 52', { length: text.length });
  try {
    const base64 = Buffer.from(text).toString('base64');
    const sequence = `\x1b]52;c;${base64}\x07`;
    allowTerminalWrite(() => process.stdout.write(sequence));
    logger.info('Clipboard: OSC 52 sequence written');
  } catch (err: unknown) {
    logger.error('Clipboard: OSC 52 copy failed', { error: summarizeError(err) });
  }
}

export { pasteFromClipboard, pasteImageFromClipboard, MIN_IMAGE_BYTES } from '@pellux/goodvibes-sdk/platform/utils';
