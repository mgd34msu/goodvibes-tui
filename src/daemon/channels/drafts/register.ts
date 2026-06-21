import {
  OperatorError,
  createAtRestCipher,
  createDaemonCredentialStore,
  declareOperatorMethods,
} from '../../operator/index.ts';
import type {
  OperatorContext,
  OperatorHandler,
  OperatorMethodDescriptor,
  Unregister,
} from '../../operator/index.ts';
import {
  ALL_DRAFT_STATUSES,
  DEFAULT_DRAFT_LIST_LIMIT,
  DraftSyncStore,
  MAX_DRAFT_LIST_LIMIT,
  WRITABLE_DRAFT_STATUSES,
} from './draft-store.ts';
import type {
  DraftListQuery,
  DraftRecord,
  DraftSaveInput,
  DraftSaveResult,
  DraftStatus,
} from './draft-store.ts';

// ---------------------------------------------------------------------------
// channels.drafts.* operator methods (Draft Sync Backend).
//
//   channels.drafts.list   read-only        scopes ['channels:drafts:read']
//   channels.drafts.get    read-only        scopes ['channels:drafts:read']
//   channels.drafts.save   local mutation   scopes ['channels:drafts:write']
//   channels.drafts.delete local mutation   scopes ['channels:drafts:write']
//
// save/delete are LOCAL state mutations (no external provider effect), so per
// the handoff ("Confirmation / Effect Semantics") they do NOT require
// confirm:true. The daemon still enforces encrypt-at-rest for the body and
// redaction of the webhook in every response (handled by DraftSyncStore).
// ---------------------------------------------------------------------------

const CATEGORY = 'channels';
const READ_SCOPES = ['channels:drafts:read'];
const WRITE_SCOPES = ['channels:drafts:write'];
const BAD_INPUT = 'OPERATOR_INVALID_INPUT';

const writableStatusSet = new Set<string>(WRITABLE_DRAFT_STATUSES);
const allStatusSet = new Set<string>(ALL_DRAFT_STATUSES);

// --- Input validation helpers ----------------------------------------------

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new OperatorError('Request body must be an object.', BAD_INPUT, 400);
  }
  return body as Record<string, unknown>;
}

function optionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new OperatorError(`Field '${field}' must be a string.`, BAD_INPUT, 400);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  const str = optionalString(value, field);
  if (str === undefined || str.length === 0) {
    throw new OperatorError(`Field '${field}' is required.`, BAD_INPUT, 400);
  }
  return str;
}

function optionalTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new OperatorError("Field 'tags' must be an array of strings.", BAD_INPUT, 400);
  }
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new OperatorError("Field 'tags' must contain only strings.", BAD_INPUT, 400);
    }
    tags.push(entry);
  }
  return tags;
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  // Mirror the declared schema exactly: { type:'integer', minimum:1,
  // maximum:MAX_DRAFT_LIST_LIMIT }. A float (e.g. 1.5) or out-of-range value
  // must be rejected with OPERATOR_INVALID_INPUT rather than silently
  // floored/clamped downstream by clampLimit — closing the contract-fidelity
  // gap between the integer schema and the validator.
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new OperatorError("Field 'limit' must be an integer.", BAD_INPUT, 400);
  }
  if (value < 1 || value > MAX_DRAFT_LIST_LIMIT) {
    throw new OperatorError(
      `Field 'limit' must be between 1 and ${MAX_DRAFT_LIST_LIMIT}.`,
      BAD_INPUT,
      400,
    );
  }
  return value;
}

// Strict ISO-8601 date-time: 'YYYY-MM-DDTHH:mm:ss' with optional fractional
// seconds and a 'Z' or '+/-HH:mm' offset. Anchored so loosely-formatted but
// Date.parse-able values (e.g. '2020', 'Jan 1 2020', '2020-1-1') are rejected.
const ISO_8601_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function optionalIso8601(value: unknown, field: string): string | undefined {
  const str = optionalString(value, field);
  if (str === undefined) return undefined;
  // Lets an integrator push the agent's authoritative updatedAt so the sync
  // contract's 'most recent updatedAt wins' conflict model is expressible
  // end-to-end. The stored value is surfaced as DraftRecord.updatedAt, which
  // the contract documents as ISO-8601 (format:'date-time'), so the input must
  // be a strict ISO-8601 date-time — not merely Date.parse-able. We then
  // normalize via Date#toISOString() to guarantee the persisted/returned value
  // is always canonical ISO-8601, honoring the declared date-time format.
  const time = ISO_8601_DATE_TIME.test(str) ? Date.parse(str) : Number.NaN;
  if (Number.isNaN(time)) {
    throw new OperatorError(
      `Field '${field}' must be an ISO-8601 timestamp.`,
      BAD_INPUT,
      400,
    );
  }
  return new Date(time).toISOString();
}

function parseListStatus(value: unknown): DraftStatus | undefined {
  const str = optionalString(value, 'status');
  if (str === undefined) return undefined;
  if (!allStatusSet.has(str)) {
    throw new OperatorError(
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
    throw new OperatorError(
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
  const title = optionalString(record.title, 'title');
  if (title !== undefined) input.title = title;
  const channel = optionalString(record.channel, 'channel');
  if (channel !== undefined) input.channel = channel;
  const route = optionalString(record.route, 'route');
  if (route !== undefined) input.route = route;
  const webhook = optionalString(record.webhook, 'webhook');
  if (webhook !== undefined) input.webhook = webhook;
  const link = optionalString(record.link, 'link');
  if (link !== undefined) input.link = link;
  const tags = optionalTags(record.tags);
  if (tags !== undefined) input.tags = tags;
  const status = parseSaveStatus(record.status);
  if (status !== undefined) input.status = status;
  const updatedAt = optionalIso8601(record.updatedAt, 'updatedAt');
  if (updatedAt !== undefined) input.updatedAt = updatedAt;
  return input;
}

function parseIdInput(body: unknown): string {
  const record = asRecord(body);
  return requiredString(record.id, 'id');
}

// --- JSON Schemas (catalog metadata) ---------------------------------------

const draftRecordSchema: Record<string, unknown> = {
  type: 'object',
  required: ['id', 'createdAt', 'updatedAt', 'status', 'messageDigest'],
  properties: {
    id: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    status: { type: 'string', enum: [...ALL_DRAFT_STATUSES] },
    title: { type: 'string' },
    messageDigest: { type: 'string' },
    channel: { type: 'string' },
    route: { type: 'string' },
    webhook: { type: 'string', description: "Always '[redacted]' when present." },
    link: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    sentResponseId: { type: 'string' },
    sendError: { type: 'string' },
  },
};

const listInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: [...ALL_DRAFT_STATUSES] },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_DRAFT_LIST_LIMIT,
      default: DEFAULT_DRAFT_LIST_LIMIT,
    },
  },
};

const listOutputSchema: Record<string, unknown> = {
  type: 'object',
  required: ['drafts'],
  properties: { drafts: { type: 'array', items: draftRecordSchema } },
};

const getInputSchema: Record<string, unknown> = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
};

const getOutputSchema: Record<string, unknown> = {
  oneOf: [
    draftRecordSchema,
    {
      type: 'object',
      required: ['notFound', 'id'],
      properties: { notFound: { const: true }, id: { type: 'string' } },
    },
  ],
};

const saveInputSchema: Record<string, unknown> = {
  type: 'object',
  required: ['message'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    message: { type: 'string' },
    channel: { type: 'string' },
    route: { type: 'string' },
    webhook: { type: 'string' },
    link: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: [...WRITABLE_DRAFT_STATUSES] },
    updatedAt: {
      type: 'string',
      format: 'date-time',
      description:
        "Optional caller-supplied last-modified timestamp (ISO-8601). When "
        + "provided it is persisted verbatim, enabling the 'most recent updatedAt "
        + "wins' conflict model; when omitted the daemon stamps server now().",
    },
  },
};

const saveOutputSchema: Record<string, unknown> = {
  type: 'object',
  required: ['id', 'created'],
  properties: { id: { type: 'string' }, created: { type: 'boolean' } },
};

const deleteInputSchema = getInputSchema;

const deleteOutputSchema: Record<string, unknown> = {
  type: 'object',
  required: ['deleted'],
  properties: { deleted: { type: 'boolean' } },
};

// --- Response types ---------------------------------------------------------

interface ListResponse {
  drafts: DraftRecord[];
}

type GetResponse = DraftRecord | { notFound: true; id: string };

// --- Registration -----------------------------------------------------------

export interface RegisterDraftsOptions {
  /** Override the sqlite filename (tests). */
  fileName?: string;
  /** Inject a pre-built store (tests). When provided, no credential store is built. */
  store?: DraftSyncStore;
}

/**
 * Register the channels.drafts.* operator methods against the catalog in ctx.
 * Returns an Unregister that removes all four methods.
 *
 * The store is created eagerly but initialized lazily on first invocation
 * (SQLite WASM load is deferred until a draft method is actually called). Every
 * mutating handler persists the store via save() after the mutation so the
 * mirror survives daemon restarts.
 */
export function registerDraftsMethods(
  ctx: OperatorContext,
  options: RegisterDraftsOptions = {},
): Unregister {
  const store =
    options.store
    ?? new DraftSyncStore({
      workingDirectory: ctx.workingDirectory,
      cipher: createAtRestCipher(createDaemonCredentialStore(ctx.secrets)),
      ...(options.fileName !== undefined ? { fileName: options.fileName } : {}),
    });

  let initPromise: Promise<void> | null = null;
  const ensureInit = (): Promise<void> => {
    if (!initPromise) initPromise = store.init();
    return initPromise;
  };

  const listHandler: OperatorHandler<unknown, ListResponse> = async ({ body }) => {
    await ensureInit();
    const query = parseListQuery(body);
    return { drafts: store.list(query) };
  };

  const getHandler: OperatorHandler<unknown, GetResponse> = async ({ body }) => {
    await ensureInit();
    const id = parseIdInput(body);
    const record = store.get(id);
    return record ?? { notFound: true, id };
  };

  const saveHandler: OperatorHandler<unknown, DraftSaveResult> = async ({ body }) => {
    await ensureInit();
    const input = parseSaveInput(body);
    const result = await store.upsert(input);
    await store.save();
    return result;
  };

  const deleteHandler: OperatorHandler<unknown, { deleted: boolean }> = async ({ body }) => {
    await ensureInit();
    const id = parseIdInput(body);
    const deleted = store.delete(id);
    if (deleted) await store.save();
    return { deleted };
  };

  const listDescriptor: OperatorMethodDescriptor = {
    id: 'channels.drafts.list',
    title: 'List drafts',
    description:
      'List server-mirrored channel drafts. Bodies are never returned — only a '
      + 'messageDigest. Webhooks are redacted.',
    category: CATEGORY,
    access: 'operator',
    scopes: READ_SCOPES,
    effect: 'read-only',
    inputSchema: listInputSchema,
    outputSchema: listOutputSchema,
  };

  const getDescriptor: OperatorMethodDescriptor = {
    id: 'channels.drafts.get',
    title: 'Get draft',
    description:
      'Fetch a single server-mirrored draft by id. The body is never returned — '
      + 'only a messageDigest. Webhook is redacted. Returns { notFound, id } when absent.',
    category: CATEGORY,
    access: 'operator',
    scopes: READ_SCOPES,
    effect: 'read-only',
    inputSchema: getInputSchema,
    outputSchema: getOutputSchema,
  };

  const saveDescriptor: OperatorMethodDescriptor = {
    id: 'channels.drafts.save',
    title: 'Save draft',
    description:
      'Create or update a server-mirrored draft. The message body is encrypted at '
      + 'rest; the webhook is encrypted and redacted on read. Local state mutation, '
      + 'no confirmation required.',
    category: CATEGORY,
    access: 'operator',
    scopes: WRITE_SCOPES,
    effect: 'local-state-mutation',
    confirm: false,
    inputSchema: saveInputSchema,
    outputSchema: saveOutputSchema,
  };

  const deleteDescriptor: OperatorMethodDescriptor = {
    id: 'channels.drafts.delete',
    title: 'Delete draft',
    description:
      'Delete a server-mirrored draft by id. Local state mutation, no confirmation '
      + 'required.',
    category: CATEGORY,
    access: 'operator',
    scopes: WRITE_SCOPES,
    effect: 'local-state-mutation',
    confirm: false,
    inputSchema: deleteInputSchema,
    outputSchema: deleteOutputSchema,
  };

  const unregisterMethods = declareOperatorMethods(ctx, [
    { descriptor: listDescriptor, handler: listHandler as OperatorHandler<unknown, unknown> },
    { descriptor: getDescriptor, handler: getHandler as OperatorHandler<unknown, unknown> },
    { descriptor: saveDescriptor, handler: saveHandler as OperatorHandler<unknown, unknown> },
    { descriptor: deleteDescriptor, handler: deleteHandler as OperatorHandler<unknown, unknown> },
  ]);

  // Teardown unregisters the methods and — only when this function owns the
  // store — closes it. An injected store is owned by the caller.
  const ownsStore = options.store === undefined;
  return () => {
    unregisterMethods();
    if (ownsStore) store.close();
  };
}
