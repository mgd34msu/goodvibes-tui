/**
 * channels.drafts.* handler surface (Channel Drafts / Draft Sync Backend).
 *
 * Attaches host handlers to the four SDK-registered builtin descriptors:
 *   channels.drafts.list    read:channels      read-only
 *   channels.drafts.get     read:channels      read-only
 *   channels.drafts.save    write:channels     access:admin, confirm-gated
 *   channels.drafts.delete  write:channels     access:admin, dangerous, confirm-gated
 *
 * The SDK owns every id, descriptor, access flag, and I/O schema (auto-
 * registered with handler:undefined). This module NEVER re-declares any of
 * them — it looks each up via catalog.get(id) (inside registerCatalogHandler)
 * and re-registers with the wrapped handler. save/delete are confirm-gated via
 * RegisterHandlerOptions.confirm; the wrapper enforces body.confirm === true
 * AND context.explicitUserRequest === true before the handler runs.
 *
 * SECURITY: the message body is encrypted at rest and NEVER returned (the wire
 * `message` field carries the sha256First(body,12) digest). Webhooks are
 * encrypted at rest and ALWAYS redacted on read; RAW webhook tokens submitted
 * to save are REJECTED — the agent must redact ('[redacted]') or pass a
 * goodvibes://secrets/ reference before transmission.
 */
import type { HandlerContext } from '../context.ts';
import { createAtRestCipher } from '../credentials.ts';
import { HandlerError } from '../errors.ts';
import { registerCatalogHandlers } from '../register.ts';
import type { TypedHandler, Unregister } from '../register.ts';
import {
  ALL_DRAFT_STATUSES,
  DraftSyncStore,
  MAX_DRAFT_LIST_LIMIT,
  WRITABLE_DRAFT_STATUSES,
} from './draft-store.ts';
import type {
  DraftListQuery,
  DraftRecord,
  DraftSaveInput,
  DraftStatus,
} from './draft-store.ts';

const BAD_INPUT = 'INVALID_INPUT';

const LIST_ID = 'channels.drafts.list';
const GET_ID = 'channels.drafts.get';
const SAVE_ID = 'channels.drafts.save';
const DELETE_ID = 'channels.drafts.delete';

const writableStatusSet = new Set<string>(WRITABLE_DRAFT_STATUSES);
const allStatusSet = new Set<string>(ALL_DRAFT_STATUSES);

// --- Input validation helpers ----------------------------------------------

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HandlerError('Request body must be an object.', BAD_INPUT, 400);
  }
  return body as Record<string, unknown>;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new HandlerError(`Field '${field}' must be a string.`, BAD_INPUT, 400);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  const str = optionalString(value, field);
  if (str === undefined || str.length === 0) {
    throw new HandlerError(`Field '${field}' is required.`, BAD_INPUT, 400);
  }
  return str;
}

function optionalTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new HandlerError("Field 'tags' must be an array of strings.", BAD_INPUT, 400);
  }
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new HandlerError("Field 'tags' must contain only strings.", BAD_INPUT, 400);
    }
    tags.push(entry);
  }
  return tags;
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HandlerError("Field 'limit' must be an integer.", BAD_INPUT, 400);
  }
  if (value < 1 || value > MAX_DRAFT_LIST_LIMIT) {
    throw new HandlerError(
      `Field 'limit' must be between 1 and ${MAX_DRAFT_LIST_LIMIT}.`,
      BAD_INPUT,
      400,
    );
  }
  return value;
}

function optionalVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new HandlerError("Field 'version' must be a positive integer.", BAD_INPUT, 400);
  }
  return value;
}

// Strict ISO-8601 date-time. Anchored so loosely-formatted but Date.parse-able
// values (e.g. '2020', 'Jan 1 2020', '2020-1-1') are rejected.
const ISO_8601_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function optionalIso8601(value: unknown, field: string): string | undefined {
  const str = optionalString(value, field);
  if (str === undefined) return undefined;
  const time = ISO_8601_DATE_TIME.test(str) ? Date.parse(str) : Number.NaN;
  if (Number.isNaN(time)) {
    throw new HandlerError(`Field '${field}' must be an ISO-8601 timestamp.`, BAD_INPUT, 400);
  }
  return new Date(time).toISOString();
}

/**
 * Reject RAW webhook tokens submitted to save. The contract requires webhooks
 * to be redacted before transmission; the daemon only stores '[redacted]' or a
 * goodvibes://secrets/ reference (which carries no token material). Any other
 * value bearing a scheme (e.g. an https:// URL with an embedded token) is a raw
 * secret and is rejected outright — never persisted, never logged.
 */
function validateWebhook(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === '' || value === '[redacted]') return value;
  if (value.startsWith('goodvibes://secrets/')) return value;
  if (value.includes('://')) {
    throw new HandlerError(
      "Field 'webhook' must be redacted before transmission: pass '[redacted]' "
        + 'or a goodvibes://secrets/ reference, never a raw webhook URL.',
      'WEBHOOK_REDACTION_REQUIRED',
      400,
    );
  }
  return value;
}

function parseListStatus(value: unknown): DraftStatus | undefined {
  const str = optionalString(value, 'status');
  if (str === undefined) return undefined;
  if (!allStatusSet.has(str)) {
    throw new HandlerError(
      `Field 'status' must be one of: ${ALL_DRAFT_STATUSES.join(', ')}.`,
      BAD_INPUT,
      400,
    );
  }
  return str as DraftStatus;
}

function parseSaveStatus(value: unknown): DraftStatus | undefined {
  const str = optionalString(value, 'status');
  if (str === undefined) return undefined;
  if (!writableStatusSet.has(str)) {
    throw new HandlerError(
      `Field 'status' must be one of: ${WRITABLE_DRAFT_STATUSES.join(', ')}.`,
      BAD_INPUT,
      400,
    );
  }
  return str as DraftStatus;
}

function parseListQuery(body: unknown): DraftListQuery {
  const record = asRecord(body ?? {});
  const query: DraftListQuery = {};
  const status = parseListStatus(record.status);
  if (status !== undefined) query.status = status;
  const limit = optionalLimit(record.limit);
  if (limit !== undefined) query.limit = limit;
  return query;
}

function parseSaveInput(body: unknown): DraftSaveInput {
  const record = asRecord(body);
  const input: DraftSaveInput = {
    message: requiredString(record.message, 'message'),
  };
  const id = optionalString(record.id, 'id');
  if (id !== undefined) input.id = id;
  const version = optionalVersion(record.version);
  if (version !== undefined) input.version = version;
  const title = optionalString(record.title, 'title');
  if (title !== undefined) input.title = title;
  const channel = optionalString(record.channel, 'channel');
  if (channel !== undefined) input.channel = channel;
  const route = optionalString(record.route, 'route');
  if (route !== undefined) input.route = route;
  const webhook = validateWebhook(optionalString(record.webhook, 'webhook'));
  if (webhook !== undefined) input.webhook = webhook;
  const link = optionalString(record.link, 'link');
  if (link !== undefined) input.link = link;
  const tags = optionalTags(record.tags);
  if (tags !== undefined) input.tags = tags;
  const status = parseSaveStatus(record.status);
  if (status !== undefined) input.status = status;
  const createdAt = optionalIso8601(record.createdAt, 'createdAt');
  if (createdAt !== undefined) input.createdAt = createdAt;
  const updatedAt = optionalIso8601(record.updatedAt, 'updatedAt');
  if (updatedAt !== undefined) input.updatedAt = updatedAt;
  return input;
}

/** Both get and delete identify a draft by `draftId` (per the SDK input schema). */
function parseDraftId(body: unknown): string {
  const record = asRecord(body);
  return requiredString(record.draftId, 'draftId');
}

// --- Response shapes (match the SDK output schemas) -------------------------

interface ListResponse {
  drafts: DraftRecord[];
  total: number;
}

/** get: a flat draft (CHANNEL_DRAFT_GET_OUTPUT permits additionalProperties) or a notFound marker. */
type GetResponse = (DraftRecord & { messageDigest: string }) | { notFound: true; id: string };

interface SaveResponse {
  draft: DraftRecord;
  created: boolean;
}

interface DeleteResponse {
  deleted: boolean;
  draftId: string;
}

export interface RegisterDraftsOptions {
  /** Override the sqlite filename (tests). */
  fileName?: string;
  /** Inject a pre-built store (tests). When provided, the caller owns its lifecycle. */
  store?: DraftSyncStore;
}

/**
 * Register the channels.drafts.* handlers against the catalog held by `ctx`.
 * Returns an Unregister that removes all four handlers (and closes the store
 * when this function owns it).
 *
 * The store is created eagerly but initialized lazily on first invocation (the
 * SQLite WASM load is deferred until a draft method is actually called). Every
 * mutating handler persists the store via save() after the mutation so the
 * mirror survives daemon restarts.
 */
export function registerDraftMethods(
  ctx: HandlerContext,
  options: RegisterDraftsOptions = {},
): Unregister {
  const store =
    options.store
    ?? new DraftSyncStore({
      workingDirectory: ctx.workingDirectory,
      cipher: createAtRestCipher(ctx.credentials),
      ...(options.fileName !== undefined ? { fileName: options.fileName } : {}),
    });

  let initPromise: Promise<void> | null = null;
  const ensureInit = (): Promise<void> => {
    if (!initPromise) initPromise = store.init();
    return initPromise;
  };

  const listHandler: TypedHandler<unknown, ListResponse> = async ({ body }) => {
    await ensureInit();
    const query = parseListQuery(body);
    const drafts = store.list(query);
    return { drafts, total: store.count(query.status) };
  };

  const getHandler: TypedHandler<unknown, GetResponse> = async ({ body }) => {
    await ensureInit();
    const id = parseDraftId(body);
    const record = store.get(id);
    if (record === null) return { notFound: true, id };
    // get output permits additional properties — expose messageDigest explicitly
    // alongside the schema-required `message` field (both carry the digest).
    return { ...record, messageDigest: record.message };
  };

  const saveHandler: TypedHandler<unknown, SaveResponse> = async ({ body }) => {
    await ensureInit();
    const input = parseSaveInput(body);
    const result = await store.upsert(input);
    await store.save();
    return result;
  };

  const deleteHandler: TypedHandler<unknown, DeleteResponse> = async ({ body }) => {
    await ensureInit();
    const draftId = parseDraftId(body);
    const deleted = store.delete(draftId);
    if (deleted) await store.save();
    return { deleted, draftId };
  };

  const unregister = registerCatalogHandlers(ctx.catalog, [
    { id: LIST_ID, handler: listHandler as TypedHandler<unknown, unknown> },
    { id: GET_ID, handler: getHandler as TypedHandler<unknown, unknown> },
    {
      id: SAVE_ID,
      handler: saveHandler as TypedHandler<unknown, unknown>,
      options: { confirm: true },
    },
    {
      id: DELETE_ID,
      handler: deleteHandler as TypedHandler<unknown, unknown>,
      options: { confirm: true },
    },
  ]);

  const ownsStore = options.store === undefined;
  return () => {
    unregister();
    if (ownsStore) store.close();
  };
}
