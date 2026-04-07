import { spawn } from 'node:child_process';

function spawnDetached(command: string, args: string[]): boolean {
  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function openExternalUrl(url: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    return spawnDetached('open', [url]);
  }

  if (process.platform === 'win32') {
    return spawnDetached('cmd.exe', ['/c', 'start', '', url]);
  }

  if (process.env['WSL_DISTRO_NAME']) {
    if (spawnDetached('wslview', [url])) return true;
    if (spawnDetached('cmd.exe', ['/c', 'start', '', url])) return true;
  }

  return spawnDetached('xdg-open', [url]);
}
