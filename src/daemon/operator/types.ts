import { createHash } from 'node:crypto';
import type {
  GatewayMethodCatalog,
  GatewayMethodAccess,
  GatewayMethodSource,
  GatewayMethodTransport,
} from '@pellux/goodvibes-sdk/platform/control-plane';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { SecretsManager } from '../../config/secrets.ts';

// ---------------------------------------------------------------------------
// Access / transport / effect vocabularies
// ---------------------------------------------------------------------------

export type OperatorAccess = 'public' | 'authenticated' | 'operator';
export type OperatorTransport = 'ws' | 'internal' | 'http';
export type OperatorEffect =
  | 'read-only'
  | 'read-only-network'
  | 'confirmed-effect'
  | 'confirmed-connected-host-state'
  | 'local-state-mutation';

// ---------------------------------------------------------------------------
// Method descriptor
//
// Matches catalog.register() descriptor (services.ts survey). The SDK catalog
// has NO confirmationRequired / effect fields — confirmation is application-level
// via request body `confirm:true`. The `effect` and `confirm` fields below are
// metadata-only here; enforcement happens in the handler against body.confirm.
// ---------------------------------------------------------------------------

export interface OperatorMethodDescriptor {
  id: string;
  title: string;
  description: string;
  category: string;
  source?: string; // default 'daemon'
  access: OperatorAccess;
  transport?: OperatorTransport[]; // default ['ws','internal']
  scopes: string[];
  pluginId?: string;
  inputSchema?: Record<string, unknown>; // JSON Schema
  outputSchema?: Record<string, unknown>; // JSON Schema
  effect?: OperatorEffect; // app-level metadata, not sent to catalog
  confirm?: boolean; // when true, handler MUST require body.confirm === true
}

// The exact descriptor shape the SDK catalog.register() accepts
// (GatewayMethodDescriptor). `source`/`access`/`transport` use the SDK's narrow
// unions, so the app-level OperatorAccess 'operator' is mapped to 'admin' and the
// app-level source 'daemon' is mapped to 'builtin' before registration.
export interface CatalogMethodDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly access: GatewayMethodAccess;
  readonly transport: readonly GatewayMethodTransport[];
  readonly scopes: readonly string[];
  readonly pluginId?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Handler / invocation
//
// Matches catalog handler input: async ({ body, context }) => unknown
// ---------------------------------------------------------------------------

export interface OperatorInvocation<TBody = unknown> {
  body: TBody;
  context: { principalId: string; explicitUserRequest?: boolean };
}

export type OperatorHandler<TBody = unknown, TResult = unknown> = (
  input: OperatorInvocation<TBody>,
) => Promise<TResult>;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface OperatorLogger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

// ---------------------------------------------------------------------------
// OperatorContext
//
// Context injected into every surface register() by services.ts (the ONE
// allowed edit there).
// ---------------------------------------------------------------------------

export interface OperatorContext {
  readonly catalog: GatewayMethodCatalog;
  readonly secrets: SecretsManager;
  // Narrow to the read surface actually used by surfaces (get / getCategory).
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly logger: OperatorLogger;
}

export type Unregister = () => void;

// Every surface module's default/contract: register(ctx) => Unregister
// (call to remove all its methods).
export type SurfaceRegister = (ctx: OperatorContext) => Unregister;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OperatorError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'OperatorError';
    this.code = code;
    this.status = status;
  }
}

export const REQUIRE_CONFIRM = 'OPERATOR_CONFIRMATION_REQUIRED';

// ---------------------------------------------------------------------------
// Handoff domain types (shared across surfaces)
// ---------------------------------------------------------------------------

export interface InboundChannelItem {
  id: string;
  surface: string;
  accountId?: string;
  conversationId?: string;
  conversationKind?: 'direct' | 'group' | 'channel' | 'thread' | string;
  fromDigest: string; // sha256First(fromAddress, 16)
  messageDigest: string; // sha256First(messageBody, 12)
  subject?: string;
  snippet?: string;
  receivedAt: string; // ISO-8601
  unread: boolean;
  metadata?: Record<string, unknown>;
}

export interface ChannelRoute {
  id: string;
  surface: string;
  accountId?: string;
  matchKind: 'sender' | 'conversation' | 'keyword' | 'default' | string;
  matchValue: string;
  targetSurface: string;
  targetConversationId?: string;
  priority: number;
  enabled: boolean;
  webhook?: string; // redacted on read via redactWebhook()
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

export interface DraftRecord {
  id: string;
  surface: string;
  accountId?: string;
  conversationId?: string;
  to?: string;
  subject?: string;
  bodyCiphertext: string; // AES-256-GCM, base64(iv|tag|ct) — never plaintext at rest
  status: 'draft' | 'queued' | 'sent' | 'failed' | string;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  metadata?: Record<string, unknown>;
}

export interface CalendarEventSummary {
  id: string;
  calendarId?: string;
  title: string;
  start: string; // ISO-8601
  end: string; // ISO-8601
  allDay?: boolean;
  location?: string;
  organizerDigest?: string; // sha256First(organizer, 16)
  status?: 'confirmed' | 'tentative' | 'cancelled' | string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Digest / redaction conventions (shared pure helpers)
// ---------------------------------------------------------------------------

/** SHA-256 of input, truncated to the first `hexChars` hex characters. */
export function sha256First(input: string, hexChars: number): string {
  const digest = createHash('sha256').update(input, 'utf-8').digest('hex');
  return digest.slice(0, Math.max(0, hexChars));
}

/** Returns '[redacted]' when a value is present, otherwise undefined. */
export function redactWebhook(value?: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : '[redacted]';
}
