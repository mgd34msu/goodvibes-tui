// ---------------------------------------------------------------------------
// Daemon-internal triage surface REGISTRATION.
//
// Registers the internal methods inbox.triage.list and inbox.triage.tag with
// transport ['internal'] ONLY — deliberately NOT 'ws'. This keeps them OFF the
// agent-facing WS method list while remaining invocable by the inbox poller
// internally. Access is 'operator'.
//
// If these are ever promoted to agent-facing methods, their IDs must move to a
// separate handoff (per the contract); they must not be added to 'ws' here.
// ---------------------------------------------------------------------------

import {
  OperatorError,
  declareOperatorMethods,
  type InboundChannelItem,
  type OperatorContext,
  type SurfaceRegister,
  type Unregister,
} from '../operator/index.ts';
import { runInboxTriage, type RunInboxTriageOptions } from './pipeline.ts';
import { createTriageTagger, type TriageTaggerOptions } from './tagger.ts';
import type { TriageLabel } from './scorer.ts';

export const TRIAGE_METHOD_IDS = {
  // Internal step name per the handoff contract (line 612): the scoring step is
  // 'inbox.triage.list' (it lists scored items), the mutation step is
  // 'inbox.triage.tag'. These are non-published, transport ['internal'] only.
  list: 'inbox.triage.list',
  tag: 'inbox.triage.tag',
} as const;

const SCORE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: { type: 'object' },
      description: 'InboundChannelItem[] to score.',
    },
    persist: {
      type: 'boolean',
      description:
        'Omit or set true to persist triageScore/triageTags to the inbox triage store; set false to dry-run (compute scores only, no write).',
    },
  },
};

const SCORE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['items', 'scored', 'persisted'],
  properties: {
    scored: { type: 'number' },
    persisted: { type: 'number' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          triage: {
            type: 'object',
            properties: {
              triageScore: { type: 'number' },
              triageLabel: { type: 'string', enum: ['spam', 'priority', 'normal'] },
              triageTags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

// NOTE: `confirm` is deliberately ABSENT from this advertised schema. Per the
// operator-confirm-contract-fidelity pattern, confirmed methods must NOT
// advertise `confirm` in their inputSchema; enforcement is body-level via
// assertConfirmed (register-helper.ts), which reads body.confirm from the raw
// untyped invocation body. Keeping it out of the schema makes this an exact
// match to the handoff Input contract instead of a strict superset.
const TAG_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['item'],
  additionalProperties: false,
  properties: {
    item: { type: 'object', description: 'InboundChannelItem to tag provider-side.' },
    tags: { type: 'array', items: { type: 'string' } },
    label: { type: 'string', enum: ['spam', 'priority', 'normal'] },
  },
};

const TAG_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['surface', 'itemId', 'appliedTags', 'skipped'],
  properties: {
    surface: { type: 'string' },
    itemId: { type: 'string' },
    appliedTags: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'boolean' },
    reason: { type: 'string' },
  },
};

interface ScoreBody {
  items?: unknown;
  persist?: unknown;
}

interface TagBody {
  item?: unknown;
  tags?: unknown;
  label?: unknown;
  confirm?: unknown;
}

function asInboundItems(value: unknown): InboundChannelItem[] {
  if (!Array.isArray(value)) {
    throw new OperatorError('`items` must be an array of inbound items.', 'TRIAGE_INVALID_INPUT', 400);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new OperatorError(`items[${index}] is not an object.`, 'TRIAGE_INVALID_INPUT', 400);
    }
    const item = entry as Partial<InboundChannelItem>;
    if (typeof item.id !== 'string' || typeof item.surface !== 'string') {
      throw new OperatorError(
        `items[${index}] requires string id and surface.`,
        'TRIAGE_INVALID_INPUT',
        400,
      );
    }
    return item as InboundChannelItem;
  });
}

function asInboundItem(value: unknown): InboundChannelItem {
  const [item] = asInboundItems([value]);
  return item!;
}

export interface RegisterTriageOptions {
  pipeline?: RunInboxTriageOptions;
  tagger?: TriageTaggerOptions;
}

/**
 * SurfaceRegister for the daemon-internal triage surface.
 *
 * Wiring contract: the daemon integration layer (services.ts, the single
 * allowed edit site there) calls `registerTriageMethods(ctx)` once with the
 * OperatorContext and retains the returned Unregister for teardown. For the
 * full poll -> score -> persist -> list enrichment loop the contract relies on,
 * compose it via `registerTriagedInbox` (see ./integration.ts), which is
 * directly exercised by the integration test.
 */
export function createTriageRegister(options: RegisterTriageOptions = {}): SurfaceRegister {
  return (ctx: OperatorContext): Unregister => {
    const tagger = createTriageTagger(ctx, options.tagger);

    return declareOperatorMethods(ctx, [
      {
        descriptor: {
          id: TRIAGE_METHOD_IDS.list,
          title: 'Inbox Triage — List (score)',
          description:
            'Daemon-internal: score inbound items for spam/priority and optionally persist triageScore/triageTags.',
          category: 'inbox',
          source: 'daemon',
          access: 'operator',
          transport: ['internal'],
          scopes: ['inbox:triage'],
          effect: 'local-state-mutation',
          inputSchema: SCORE_INPUT_SCHEMA,
          outputSchema: SCORE_OUTPUT_SCHEMA,
        },
        handler: async (input) => {
          const body = (input.body ?? {}) as ScoreBody;
          const items = asInboundItems(body.items);
          const dryRun = body.persist === false;
          return runInboxTriage(items, ctx, { ...options.pipeline, dryRun });
        },
      },
      {
        descriptor: {
          id: TRIAGE_METHOD_IDS.tag,
          title: 'Inbox Triage — Tag',
          description:
            'Daemon-internal: apply a triage label back on the provider side (IMAP flag / Slack or Discord reaction).',
          category: 'inbox',
          source: 'daemon',
          access: 'operator',
          transport: ['internal'],
          scopes: ['inbox:triage', 'inbox:triage:write'],
          effect: 'confirmed-connected-host-state',
          confirm: true,
          inputSchema: TAG_INPUT_SCHEMA,
          outputSchema: TAG_OUTPUT_SCHEMA,
        },
        handler: async (input) => {
          const body = (input.body ?? {}) as TagBody;
          const item = asInboundItem(body.item);
          const tags = Array.isArray(body.tags)
            ? body.tags.filter((t): t is string => typeof t === 'string')
            : undefined;
          const label =
            typeof body.label === 'string' ? (body.label as TriageLabel) : undefined;
          return tagger.applyTags({
            item,
            tags,
            label,
            // confirm:true is enforced by the declareOperatorMethod guard before
            // we reach here; mirror both flags into the tagger for defense-in-depth.
            confirm: body.confirm === true,
            explicitUserRequest: input.context.explicitUserRequest === true,
          });
        },
      },
    ]);
  };
}

/**
 * Default SurfaceRegister export. Integration may import either this `register`
 * or `registerTriageMethods` (alias) and call it with the OperatorContext.
 */
export const register: SurfaceRegister = createTriageRegister();

/** Named alias matching the integration contract (registerTriageMethods). */
export const registerTriageMethods: SurfaceRegister = register;
