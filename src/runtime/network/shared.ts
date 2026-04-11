import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { ConfigManager } from '../../config/manager.ts';

const PEM_EXTENSIONS = new Set(['.pem', '.crt', '.cer']);

export function getGoodVibesRootDir(configManager?: Pick<ConfigManager, 'getControlPlaneConfigDir'> | null): string {
  const configuredDir = configManager?.getControlPlaneConfigDir?.();
  if (!configuredDir) {
    return join(homedir(), '.goodvibes');
  }
  const normalized = resolve(configuredDir);
  return basename(normalized) === 'tui' ? dirname(normalized) : normalized;
}

export function getDefaultCertDirectory(configManager?: Pick<ConfigManager, 'getControlPlaneConfigDir'> | null): string {
  return join(getGoodVibesRootDir(configManager), 'certs');
}

export function getDefaultInboundCertPaths(configManager?: Pick<ConfigManager, 'getControlPlaneConfigDir'> | null): {
  readonly certFile: string;
  readonly keyFile: string;
} {
  const certDir = getDefaultCertDirectory(configManager);
  return {
    certFile: join(certDir, 'fullchain.pem'),
    keyFile: join(certDir, 'privkey.pem'),
  };
}

export function resolvePathFromGoodVibesRoot(
  value: string | null | undefined,
  configManager?: Pick<ConfigManager, 'getControlPlaneConfigDir'> | null,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return isAbsolute(trimmed)
    ? trimmed
    : resolve(getGoodVibesRootDir(configManager), trimmed);
}

export function readPemEntriesFromDirectory(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && PEM_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(path, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

export function extractForwardedClientIp(req: Request, trustProxy: boolean): string | undefined {
  if (!trustProxy) return undefined;
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',').map((value) => value.trim()).find(Boolean);
    if (first) return first;
  }
  const realIp = req.headers.get('x-real-ip')?.trim();
  return realIp ? realIp : undefined;
}

export function inspectPrivateKeyPermissions(path: string): {
  readonly available: boolean;
  readonly safe?: boolean;
  readonly mode?: string;
} {
  if (!existsSync(path) || process.platform === 'win32') {
    return { available: false };
  }
  const stat = statSync(path);
  const mode = stat.mode & 0o777;
  return {
    available: true,
    safe: (mode & 0o077) === 0,
    mode: `0${mode.toString(8)}`,
  };
}
