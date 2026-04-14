export type DaemonErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'billing'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'not_found'
  | 'permission'
  | 'tool'
  | 'config'
  | 'protocol'
  | 'service'
  | 'internal'
  | 'unknown';

export type DaemonErrorSource =
  | 'provider'
  | 'tool'
  | 'transport'
  | 'config'
  | 'permission'
  | 'runtime'
  | 'render'
  | 'acp'
  | 'unknown';

export interface StructuredDaemonErrorBody {
  readonly error: string;
  readonly hint?: string;
  readonly code?: string;
  readonly category?: DaemonErrorCategory;
  readonly source?: DaemonErrorSource;
  readonly recoverable?: boolean;
  readonly status?: number;
  readonly provider?: string;
  readonly operation?: string;
  readonly phase?: string;
  readonly requestId?: string;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly retryAfterMs?: number;
}
