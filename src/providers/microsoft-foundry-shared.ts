export function normalizeFoundryEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    parsed.search = '';
    parsed.hash = '';
    const normalizedPath = parsed.pathname.replace(/\/openai(?:$|\/).*/i, '').replace(/\/+$/, '');
    return `${parsed.origin}${normalizedPath && normalizedPath !== '/' ? normalizedPath : ''}`;
  } catch {
    const withoutQuery = trimmed.replace(/[?#].*$/, '').replace(/\/+$/, '');
    return withoutQuery.replace(/\/openai(?:$|\/).*/i, '');
  }
}

export function buildFoundryV1BaseUrl(endpoint: string): string {
  const base = normalizeFoundryEndpoint(endpoint);
  return base.endsWith('/openai/v1') ? base : `${base}/openai/v1`;
}
