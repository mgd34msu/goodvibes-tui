import type { FetchSanitizeMode } from './schema.ts';

export interface FetchUrlResult {
  url: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  byteSize?: number;
  content?: string;
  error?: string;
  truncated?: boolean;
  from_cache?: boolean;
  redirected?: boolean;
  final_url?: string;
  duration_ms?: number;
  tokens_used?: number;
  sanitization_tier?: FetchSanitizeMode | 'skipped';
  host_trust_tier?: string;
  metadata?: {
    headers: Record<string, string>;
    redirected: boolean;
    finalUrl: string;
  };
}

export interface FetchOutput {
  success: boolean;
  error?: string;
  results?: FetchUrlResult[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    total_ms?: number;
  };
}

