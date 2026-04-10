import { isIP } from 'node:net';

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 0
    || a >= 224;
}

function mappedIpv4FromIpv6(host: string): string | null {
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!mappedHex) return null;
  const high = Number.parseInt(mappedHex[1]!, 16);
  const low = Number.parseInt(mappedHex[2]!, 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join('.');
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata.google.internal') return true;
  const ipKind = isIP(host);
  if (ipKind === 4) return isPrivateIpv4(host);
  if (ipKind === 6) {
    const mappedIpv4 = mappedIpv4FromIpv6(host);
    if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
    return host === '::1'
      || host.startsWith('fc')
      || host.startsWith('fd')
      || host.startsWith('fe80:')
      || host.startsWith('ff')
      || host === '::'
      || host.startsWith('0:');
  }
  return false;
}

export function validatePublicWebhookUrl(rawUrl: string): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid webhook URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Webhook URL must use https' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Webhook URL must not include credentials' };
  }
  if (isBlockedHostname(parsed.hostname)) {
    return { ok: false, error: 'Webhook URL host is not allowed' };
  }
  return { ok: true, url: parsed.toString() };
}
