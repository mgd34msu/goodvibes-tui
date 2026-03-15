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

/**
 * pasteImageFromClipboard - Attempts to read image data from system clipboard.
 * Returns base64-encoded image data and mediaType, or null if no image is available.
 */
export function pasteImageFromClipboard(): { data: string; mediaType: string } | null {
  try {
    if (process.platform === 'linux') {
      // Try wl-paste for Wayland (image/png)
      const wl = Bun.spawnSync(['wl-paste', '--type', 'image/png', '--no-newline'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 3000,
      });
      if (wl.exitCode === 0 && wl.stdout) {
        const wlBuf = Buffer.from(wl.stdout);
        if (wlBuf.length > 100) {
          return { data: wlBuf.toString('base64'), mediaType: 'image/png' };
        }
      }
      // Try xclip for X11
      const xclip = Bun.spawnSync(['xclip', '-selection', 'clipboard', '-t', 'image/png', '-o'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 3000,
      });
      if (xclip.exitCode === 0 && xclip.stdout) {
        const xclipBuf = Buffer.from(xclip.stdout);
        if (xclipBuf.length > 100) {
          return { data: xclipBuf.toString('base64'), mediaType: 'image/png' };
        }
      }
    } else if (process.platform === 'darwin') {
      // macOS: try pngpaste
      const pp = Bun.spawnSync(['pngpaste', '-'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 3000,
      });
      if (pp.exitCode === 0 && pp.stdout) {
        const ppBuf = Buffer.from(pp.stdout);
        if (ppBuf.length > 100) {
          return { data: ppBuf.toString('base64'), mediaType: 'image/png' };
        }
      }
    }
  } catch {
    // Clipboard image access failed — not a fatal error
  }
  return null;
}
