import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_SCHEMA, ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { getOperatorContract } from '@pellux/goodvibes-contracts';
import { buildSettingGroups } from '@/input/settings-modal-data.ts';
import { CommandRegistry, type CommandContext } from '@/input/command-registry.ts';
import { registerProfileRuntimeCommands, type ProfileCommandDeps } from '@/input/commands/profile-runtime.ts';
import type { OperatorRpc } from '@/input/commands/operator-rpc.ts';
import {
  collectFieldLabels,
  renderProfileDocument,
  renderProfileProvenance,
  renderProfileStatus,
  renderProfileWriteResult,
} from '@/input/commands/profile-render.ts';
import {
  MALFORMED,
  toProfileDocument,
  toProfileProvenanceReport,
  toProfileState,
  toProfileWriteResult,
  type ExactProfileInput,
  type ProfileDocumentView,
  type ProfileInput,
  type ProfileStateView,
  type ProfileVerb,
} from '@/input/commands/profile-types.ts';
import { SETTINGS_CATEGORIES, SETTINGS_CATEGORY_GROUPS } from '@/input/settings-modal-types.ts';
import { CATEGORY_INFO, CATEGORY_LABELS } from '@/renderer/settings-modal-helpers.ts';

// ---------------------------------------------------------------------------
// Fixtures — a realistic populated profile, values chosen so a leak is obvious
// ---------------------------------------------------------------------------

const SHIPPING = '200 Office Way, Lansing, MI 48933, US';
const OLD_SHIPPING = '401 Home St, Lansing, MI 48933, US';
const SISTER_LINE = '- Sarah, sister, sarah@example.com';
const EMAIL = 'owner@example.com';

/** Every value that must never appear outside the rendered answer. */
const SECRET_VALUES = [SHIPPING, OLD_SHIPPING, SISTER_LINE, EMAIL];

const LOADED_STATE = {
  kind: 'loaded',
  path: '/home/owner/.goodvibes/daemon/owner-profile.md',
  exists: true,
  lineCount: 42,
  fieldCount: 3,
  proseLineCount: 2,
  sections: ['Identity', 'Contact', 'Commerce', 'People'],
  invalidFields: [{ fieldId: 'location.timezone', reason: 'expected an IANA time zone' }],
};

const DOCUMENT_RESPONSE = {
  state: LOADED_STATE,
  sections: [
    {
      heading: 'Contact',
      tier: 'closed',
      fields: [
        {
          fieldId: 'contact.email',
          label: 'email',
          value: EMAIL,
          valid: true,
          provenance: { surface: 'tui', date: '2026-07-27', said: 'my email is owner@example.com' },
        },
      ],
      prose: [],
    },
    {
      heading: 'Commerce',
      tier: 'closed',
      fields: [
        { fieldId: 'commerce.shippingAddress', label: 'shipping address', value: SHIPPING, valid: true },
        { fieldId: 'commerce.currency', label: 'currency', value: 'usd!', valid: false, invalidReason: 'expected a 3-letter ISO-4217 code' },
      ],
      prose: [],
    },
    {
      heading: 'People',
      tier: 'closed',
      fields: [],
      prose: [{ lineIndex: 30, section: 'People', text: SISTER_LINE }],
    },
    { heading: 'Places', tier: 'closed', fields: [], prose: [] },
  ],
};

function checkedDocument(): ProfileDocumentView {
  const document = toProfileDocument(DOCUMENT_RESPONSE);
  if (document === MALFORMED) throw new Error('fixture does not match the checked shape');
  return document;
}

function checkedState(raw: unknown): ProfileStateView {
  const state = toProfileState(raw);
  if (state === MALFORMED) throw new Error('fixture does not match the checked shape');
  return state;
}

// ---------------------------------------------------------------------------
// Command harness
// ---------------------------------------------------------------------------

function makeCtx(): CommandContext & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    print: (text: string) => { printed.push(text); },
    platform: { configManager: { get: () => undefined } },
    workspace: {},
  } as unknown as CommandContext & { printed: string[] };
}

interface ScriptedCall { readonly methodId: string; readonly input: Record<string, unknown> }

/**
 * A registry whose `/profile` talks to a scripted daemon rather than a live one,
 * so the response-handling paths (refusal, no-op, disclosure) are exercised end
 * to end instead of only through the renderers.
 */
function makeScriptedRegistry(
  respond: (methodId: string, input: Record<string, unknown>) => unknown,
): { registry: CommandRegistry; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  const deps: ProfileCommandDeps = {
    resolveRpc: () => ({
      available: true,
      sdk: {
        operator: {
          invoke: (methodId: string, input: Record<string, unknown>) => {
            calls.push({ methodId, input });
            return Promise.resolve(respond(methodId, input));
          },
        },
      },
    } as unknown as OperatorRpc),
  };
  const registry = new CommandRegistry();
  registerProfileRuntimeCommands(registry, deps);
  return { registry, calls };
}

function makeRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerProfileRuntimeCommands(registry);
  return registry;
}

// ---------------------------------------------------------------------------
// Registration and argument validation
// ---------------------------------------------------------------------------

describe('/profile command', () => {
  test('registers as "profile" without colliding with /profile-sync', () => {
    const registry = makeRegistry();
    expect(registry.get('profile')).toBeDefined();
    expect(registry.get('profile')!.name).toBe('profile');
  });

  test('unknown subcommand prints usage without touching the operator connection', async () => {
    const ctx = makeCtx();
    await makeRegistry().get('profile')!.handler(['bogus'], ctx);
    expect(ctx.printed.join('\n')).toContain('Usage: /profile <subcommand>');
  });

  test('where/forget/undo without a field print usage', async () => {
    for (const sub of ['where', 'forget', 'undo']) {
      const ctx = makeCtx();
      await makeRegistry().get('profile')!.handler([sub], ctx);
      expect(ctx.printed.join('\n')).toBe(`Usage: /profile ${sub} <field>`);
    }
  });

  test('set without a value prints usage', async () => {
    const ctx = makeCtx();
    await makeRegistry().get('profile')!.handler(['set', 'commerce.shippingAddress'], ctx);
    expect(ctx.printed.join('\n')).toBe('Usage: /profile set <field> <value>');
  });

  test('note without text prints usage', async () => {
    const ctx = makeCtx();
    await makeRegistry().get('profile')!.handler(['note'], ctx);
    expect(ctx.printed.join('\n')).toBe('Usage: /profile note [--section <name>] <text>');
  });

  test('bare /profile is honestly unavailable without a reachable control-plane base URL', async () => {
    const ctx = makeCtx();
    await makeRegistry().get('profile')!.handler([], ctx);
    expect(ctx.printed.join('\n')).toContain('no control-plane base URL is configured');
  });
});

// ---------------------------------------------------------------------------
// forget: a no-op is never reported as a success (design §9.2)
// ---------------------------------------------------------------------------

describe('/profile forget on a field that is not recorded', () => {
  const REFUSAL = 'Your profile has no shipping address recorded, so there was nothing to forget.';

  test('reports that it was not there, and never claims success', async () => {
    const ctx = makeCtx();
    const { registry, calls } = makeScriptedRegistry((methodId) => {
      if (methodId === 'profile.forget') {
        return { ok: false, reason: REFUSAL, changes: [], disclosure: '' };
      }
      throw new Error(`unexpected call: ${methodId}`);
    });
    await registry.get('profile')!.handler(['forget', 'commerce.shippingAddress'], ctx);

    const output = ctx.printed.join('\n');
    expect(output).toContain(REFUSAL);
    expect(output).not.toMatch(/\bNoted\b/);
    expect(output).not.toMatch(/\bremoved\b/i);
    expect(output).not.toMatch(/\bdeleted\b/i);
    expect(output).not.toMatch(/\bdone\b/i);
    expect(calls.map((call) => call.methodId)).toEqual(['profile.forget']);
    expect(calls[0]?.input.authority).toBe('owner-direct');
  });

  test('renderProfileWriteResult refuses to synthesise a receipt over ok:false', () => {
    const result = toProfileWriteResult({ ok: false, reason: REFUSAL, changes: [], disclosure: '' });
    expect(result).not.toBe(MALFORMED);
    const text = renderProfileWriteResult(result as Exclude<typeof result, typeof MALFORMED>);
    expect(text).toContain(REFUSAL);
    expect(text).not.toContain('Noted');
  });

  test('an ok:true response with no changes still does not read as a success', () => {
    const result = toProfileWriteResult({ ok: true, reason: null, changes: [], disclosure: '' });
    expect(result).not.toBe(MALFORMED);
    const text = renderProfileWriteResult(result as Exclude<typeof result, typeof MALFORMED>);
    expect(text).toContain('nothing changed');
    expect(text).not.toContain('Noted');
  });

  test('a real deletion reports the daemon\'s own one-line disclosure', () => {
    const result = toProfileWriteResult({
      ok: true,
      reason: null,
      changes: [{ kind: 'forget', fieldId: 'commerce.shippingAddress', section: 'Commerce', label: 'shipping address', superseded: false }],
      disclosure: 'Noted — removed your shipping address in your profile.',
    });
    expect(result).not.toBe(MALFORMED);
    const text = renderProfileWriteResult(result as Exclude<typeof result, typeof MALFORMED>);
    expect(text).toContain('Noted — removed your shipping address in your profile.');
    expect(text).toContain('commerce.shippingAddress');
  });
});

// ---------------------------------------------------------------------------
// Disclosure on write (§8.2): printed, and never with the value in it
// ---------------------------------------------------------------------------

describe('write disclosure', () => {
  test('/profile set prints the disclosure and never echoes the value back', async () => {
    const ctx = makeCtx();
    const { registry, calls } = makeScriptedRegistry((methodId) => {
      if (methodId === 'profile.set') {
        return {
          ok: true,
          reason: null,
          changes: [{ kind: 'set', fieldId: 'commerce.shippingAddress', section: 'Commerce', label: 'shipping address', superseded: true }],
          disclosure: 'Noted — saved your shipping address to your profile.',
        };
      }
      throw new Error(`unexpected call: ${methodId}`);
    });
    await registry.get('profile')!.handler(['set', 'commerce.shippingAddress', ...SHIPPING.split(' ')], ctx);

    const output = ctx.printed.join('\n');
    expect(output).toContain('Noted — saved your shipping address to your profile.');
    expect(output).not.toContain(SHIPPING);
    expect(output).not.toContain('200 Office Way');

    // The write carries this surface and a verbatim quote of what was typed —
    // layer 3 of the trust gate refuses a write without one (§7).
    const set = calls.find((call) => call.methodId === 'profile.set');
    expect(set?.input.surface).toBe('tui');
    expect(String(set?.input.said ?? '')).toContain('/profile set');
    expect(String(set?.input.said ?? '').length).toBeGreaterThan(0);
    // The write states its authority rather than leaning on the daemon's
    // default — see the authority block below for why that matters.
    expect(set?.input.authority).toBe('owner-direct');
  });

  test('/profile note appends to Notes by default and honours --section', async () => {
    const seen: ScriptedCall[] = [];
    const respond = (methodId: string): unknown => {
      if (methodId !== 'profile.append') throw new Error(`unexpected call: ${methodId}`);
      return {
        ok: true,
        reason: null,
        changes: [{ kind: 'append', fieldId: null, section: 'Notes', label: 'note', superseded: false }],
        disclosure: 'Noted — saved a note under Notes to your profile.',
      };
    };

    const first = makeScriptedRegistry(respond);
    await first.registry.get('profile')!.handler(['note', 'allergic', 'to', 'shellfish'], makeCtx());
    seen.push(...first.calls);
    expect(first.calls[0]?.input.section).toBe('Notes');
    expect(first.calls[0]?.input.text).toBe('allergic to shellfish');
    expect(first.calls[0]?.input.authority).toBe('owner-direct');

    const second = makeScriptedRegistry(respond);
    await second.registry.get('profile')!.handler(['note', '--section', 'Places', 'gym', 'is', 'the', 'Y'], makeCtx());
    expect(second.calls[0]?.input.section).toBe('Places');
    expect(second.calls[0]?.input.text).toBe('gym is the Y');
    expect(second.calls[0]?.input.authority).toBe('owner-direct');
    expect(seen.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Containment (§10, §11.3): nothing reaches a log
// ---------------------------------------------------------------------------

describe('containment', () => {
  /** Capture every console channel a stray debug line could take. */
  async function captureConsole(run: () => Promise<void> | void): Promise<string[]> {
    const captured: string[] = [];
    const channels = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
    const console_ = console as unknown as Record<string, (...args: unknown[]) => void>;
    const originals = new Map<string, (...args: unknown[]) => void>();
    for (const channel of channels) {
      originals.set(channel, console_[channel]!);
      console_[channel] = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    }
    try {
      await run();
    } finally {
      for (const [channel, original] of originals) console_[channel] = original;
    }
    return captured;
  }

  test('rendering the whole profile writes nothing to any console channel', async () => {
    let rendered = '';
    const captured = await captureConsole(() => { rendered = renderProfileDocument(checkedDocument()); });
    expect(captured).toEqual([]);
    // The rendered answer is the one place a value is allowed to be — the owner
    // asked this surface, this turn, what it knows about him.
    expect(rendered).toContain(SHIPPING);
    expect(rendered).toContain(SISTER_LINE);
  });

  test('running /profile show end to end writes no value to any console channel', async () => {
    const ctx = makeCtx();
    const { registry } = makeScriptedRegistry((methodId) => {
      if (methodId === 'profile.read') return DOCUMENT_RESPONSE;
      throw new Error(`unexpected call: ${methodId}`);
    });
    const captured = await captureConsole(async () => {
      await registry.get('profile')!.handler(['show'], ctx);
    });
    const logged = captured.join('\n');
    for (const value of SECRET_VALUES) expect(logged).not.toContain(value);
    expect(captured).toEqual([]);
    expect(ctx.printed.join('\n')).toContain(SHIPPING);
  });

  test('profile.status output carries counts, names and reasons — never a value', () => {
    const text = renderProfileStatus(checkedState(LOADED_STATE));
    for (const value of SECRET_VALUES) expect(text).not.toContain(value);
    expect(text).toContain('/home/owner/.goodvibes/daemon/owner-profile.md');
    expect(text).toContain('location.timezone: expected an IANA time zone');
    expect(text).toContain('fields: 3');
  });

  test('an unreadable profile states the reason instead of rendering an empty profile', () => {
    const state = checkedState({ kind: 'unavailable', path: '/tmp/owner-profile.md', reason: 'not valid UTF-8' });
    const document = toProfileDocument({ state, sections: [] });
    expect(document).not.toBe(MALFORMED);
    const text = renderProfileDocument(document as ProfileDocumentView);
    expect(text).toContain('could not be read');
    expect(text).toContain('not valid UTF-8');
    expect(text).not.toContain('know about you');
  });

  test('a disabled profile says so rather than answering with nothing', () => {
    const document = toProfileDocument({ state: { kind: 'disabled', path: '/tmp/owner-profile.md' }, sections: [] });
    expect(document).not.toBe(MALFORMED);
    expect(renderProfileDocument(document as ProfileDocumentView)).toContain('turned off');
  });
});

// ---------------------------------------------------------------------------
// Authority (§7): every write verb claims owner-direct, none send nothing
//
// `authority` is required on all four write verbs. Checked against the
// installed SDK rather than assumed: `readAuthority` in
// platform/control-plane/routes/owner-profile.js now throws
// INVALID_ARGUMENT when it is absent, and the contract types the field
// non-optional. An earlier build of the same module defaulted an absent value
// to `owner-direct`; this command stated the claim explicitly even then, which
// is why that tightening did not break it.
//
// It matters because for `forget` and `undo` the authority check is the ONLY
// gate: layers 2 and 3 do not apply to a removal, since there is no value to
// check for derivation and no owner utterance to quote. This block is the one
// place that fails if a future edit drops the field from any of the four write
// call sites — the compile-time check below catches the same class earlier
// still, but only for a shape the contract can see.
// ---------------------------------------------------------------------------

describe('every profile write verb claims owner-direct authority', () => {
  const WRITE_RESULT = { ok: true, reason: null, changes: [], disclosure: 'Noted.' };

  test('/profile undo sends authority: owner-direct', async () => {
    const ctx = makeCtx();
    const { registry, calls } = makeScriptedRegistry((methodId) => {
      if (methodId === 'profile.undo') return WRITE_RESULT;
      throw new Error(`unexpected call: ${methodId}`);
    });
    await registry.get('profile')!.handler(['undo', 'commerce.shippingAddress'], ctx);
    expect(calls.map((call) => call.methodId)).toEqual(['profile.undo']);
    expect(calls[0]?.input.fieldId).toBe('commerce.shippingAddress');
    expect(calls[0]?.input.authority).toBe('owner-direct');
  });

  test('set, note, forget and undo each send authority: owner-direct', async () => {
    const scripts: ReadonlyArray<{ args: string[]; verb: string }> = [
      { args: ['set', 'commerce.shippingAddress', '123', 'Main', 'St'], verb: 'profile.set' },
      { args: ['note', 'a', 'note'], verb: 'profile.append' },
      { args: ['forget', 'commerce.shippingAddress'], verb: 'profile.forget' },
      { args: ['undo', 'commerce.shippingAddress'], verb: 'profile.undo' },
    ];
    for (const { args, verb } of scripts) {
      const ctx = makeCtx();
      const { registry, calls } = makeScriptedRegistry((methodId) => {
        if (methodId === verb) return WRITE_RESULT;
        throw new Error(`unexpected call: ${methodId}`);
      });
      await registry.get('profile')!.handler(args, ctx);
      expect(calls.map((call) => call.methodId)).toEqual([verb]);
      expect(calls[0]?.input.authority).toBe('owner-direct');
    }
  });
});

// ---------------------------------------------------------------------------
// The body each write sends conforms to the contract's DECLARED input
//
// Checked against the live operator manifest rather than a hand-written copy of
// it, so this needs no tarball and no one to tell us the contract moved. It
// catches both breaking changes this feature has already had:
//
//   - a field the contract REMOVED (profile.forget lost `lineIndex`) shows up
//     as an undeclared property, because every profile input schema is
//     additionalProperties:false;
//   - a field the contract made REQUIRED (`authority`) shows up as a missing
//     required property.
//
// The compile-time check is stronger and fires earlier, and the block below
// holds it permanently rather than relying on someone re-seeding it. This
// runtime pass is the backstop for the same class in a surface whose wrapper
// does not constrain its input, which is how both changes reached the other two
// surfaces unnoticed.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Compile-time: the body may not carry a key the contract does not declare
//
// These assertions are checked by `tsc -p tsconfig.test.json`, not at runtime.
// Each `@ts-expect-error` FAILS THE BUILD if the error it expects stops
// happening — so unlike seeding a mistake by hand, this cannot quietly rot.
//
// The case that matters is a body built as a VARIABLE. TypeScript applies
// excess-property checking only to fresh object literals, so a correctly typed
// parameter alone accepts `const body = { …, lineIndex: 3 }`. Verified against
// this command before the guard existed: it compiled clean. ExactProfileInput
// closes that by mapping every undeclared key to `never`.
// ---------------------------------------------------------------------------

declare function acceptsExactBody<TVerb extends ProfileVerb, TBody extends ProfileInput<TVerb>>(
  verb: TVerb,
  body: ExactProfileInput<TVerb, TBody>,
): void;

/**
 * Never invoked. `acceptsExactBody` is a `declare`d signature with no runtime
 * body, so this exists purely to be typechecked — calling it would throw.
 * `bun test` does not enforce any of this; `tsc -p tsconfig.test.json` does.
 */
function compileTimePayloadExactness(): void {
  {
    // Bodies deliberately built as variables, never as fresh literals at the
    // call site, because the literal form is already checked by TypeScript and
    // is not the case that regressed.
    const forgetWithRetiredKey = { fieldId: 'commerce.shippingAddress', lineIndex: 3, authority: 'owner-direct' };
    // @ts-expect-error profile.forget retired lineIndex — a position cannot address a line the owner may have moved (§9.2).
    acceptsExactBody('profile.forget', forgetWithRetiredKey);

    const undoMissingAuthority = { fieldId: 'commerce.shippingAddress' };
    // @ts-expect-error authority is required on every write verb; for undo and forget it is the only gate there is (§7).
    acceptsExactBody('profile.undo', undoMissingAuthority);

    const undoWithSiblingVerbKeys = { fieldId: 'x', section: 'People', text: 'a line', authority: 'owner-direct' };
    // @ts-expect-error section/text belong to profile.forget, not profile.undo — keys are checked per verb, not across the family.
    acceptsExactBody('profile.undo', undoWithSiblingVerbKeys);

    const setWithMisspelledKey = { fieldId: 'x', valu: 'y', surface: 'tui', said: 'q', authority: 'owner-direct' };
    // @ts-expect-error `valu` is not `value`.
    acceptsExactBody('profile.set', setWithMisspelledKey);

    // The third construction form, and the one that slipped past every lane. A
    // FRESH literal normally gets excess-property checking, but a spread inside
    // it defeats that check, so correct parameter typing alone accepts a stale
    // key. Both spread shapes are held: a plain spread, and the conditional
    // spread that assembles a body across branches — the latter infers an
    // OPTIONAL property, so it fails against `never` on its `undefined` arm
    // rather than on the value.
    const staleFields = { lineIndex: 3 };
    // @ts-expect-error a spread cannot smuggle a retired key past the declared input.
    acceptsExactBody('profile.forget', { ...staleFields, fieldId: 'x', authority: 'owner-direct' });

    const conditionally: boolean = true;
    // @ts-expect-error nor can a conditional spread, which is the shape the same key survived in elsewhere.
    acceptsExactBody('profile.forget', {
      ...(conditionally ? { lineIndex: 3 } : {}),
      fieldId: 'x',
      authority: 'owner-direct',
    });

    // Positive control: the shapes the command actually sends must still be
    // accepted, so the guard cannot pass by rejecting everything.
    const validForget = { fieldId: 'commerce.shippingAddress', authority: 'owner-direct' };
    acceptsExactBody('profile.forget', validForget);
    const validForgetProse = { section: 'People', text: '- Sarah', authority: 'owner-direct' };
    acceptsExactBody('profile.forget', validForgetProse);
    const validSet = { fieldId: 'x', value: 'y', surface: 'tui', said: 'q', authority: 'owner-direct' };
    acceptsExactBody('profile.set', validSet);
  }
}

describe('compile-time payload exactness', () => {
  test('the exactness assertions are enforced by the test typecheck, not here', () => {
    // Deliberately not called: every assertion in it is a type-level one that
    // `tsc -p tsconfig.test.json` checks. Each `@ts-expect-error` in that body
    // FAILS THE BUILD if the error it expects stops happening, so weakening
    // ExactProfileInput back to plain parameter typing cannot pass silently —
    // verified by doing exactly that, which turned two of the four directives
    // into "Unused '@ts-expect-error' directive" errors.
    expect(typeof compileTimePayloadExactness).toBe('function');
  });
});

describe('write payloads conform to the declared contract input', () => {
  const WRITE_RESULT = { ok: true, reason: null, changes: [], disclosure: 'Noted.' };

  interface DeclaredSchema {
    readonly properties?: Record<string, { readonly type?: string }>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean;
  }

  /** The input schema the operator contract declares for a method id. */
  function declaredInput(methodId: string): DeclaredSchema {
    const method = getOperatorContract().operator.methods.find((entry) => entry.id === methodId);
    if (!method) throw new Error(`${methodId} is not in the operator contract`);
    return (method.inputSchema ?? {}) as DeclaredSchema;
  }

  function expectConforms(methodId: string, body: Record<string, unknown>): void {
    const schema = declaredInput(methodId);
    const properties = schema.properties ?? {};

    // Nothing the contract does not declare. This is the lineIndex class.
    if (schema.additionalProperties === false) {
      const undeclared = Object.keys(body).filter((key) => !(key in properties));
      expect({ methodId, undeclared }).toEqual({ methodId, undeclared: [] });
    }
    // Everything the contract requires. This is the authority class.
    const missing = (schema.required ?? []).filter((key) => !(key in body));
    expect({ methodId, missing }).toEqual({ methodId, missing: [] });

    // And the declared primitive type, where one is given.
    const wrongType = Object.entries(body)
      .filter(([key, value]) => {
        const declaredType = properties[key]?.type;
        return declaredType !== undefined && typeof value !== declaredType;
      })
      .map(([key]) => key);
    expect({ methodId, wrongType }).toEqual({ methodId, wrongType: [] });
  }

  const SCRIPTS: ReadonlyArray<{ args: string[]; verb: string }> = [
    { args: ['set', 'commerce.shippingAddress', '123', 'Main', 'St'], verb: 'profile.set' },
    { args: ['note', 'a', 'note'], verb: 'profile.append' },
    { args: ['forget', 'commerce.shippingAddress'], verb: 'profile.forget' },
    { args: ['undo', 'commerce.shippingAddress'], verb: 'profile.undo' },
  ];

  for (const { args, verb } of SCRIPTS) {
    test(`${verb} sends only declared properties and every required one`, async () => {
      const ctx = makeCtx();
      const { registry, calls } = makeScriptedRegistry((methodId) => {
        if (methodId === verb) return WRITE_RESULT;
        throw new Error(`unexpected call: ${methodId}`);
      });
      await registry.get('profile')!.handler(args, ctx);
      expect(calls).toHaveLength(1);
      expectConforms(verb, calls[0]!.input);
    });
  }

  test('forget --section sends section and text, and no position', async () => {
    const ctx = makeCtx();
    const { registry, calls } = makeScriptedRegistry((methodId) => {
      if (methodId === 'profile.forget') return WRITE_RESULT;
      throw new Error(`unexpected call: ${methodId}`);
    });
    await registry.get('profile')!.handler(
      ['forget', '--section', 'People', '-', 'Sarah,', 'sister,', 'sarah@example.com'],
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.section).toBe('People');
    expect(calls[0]!.input.text).toBe('- Sarah, sister, sarah@example.com');
    expect(calls[0]!.input.fieldId).toBeUndefined();
    expect('lineIndex' in calls[0]!.input).toBe(false);
    expectConforms('profile.forget', calls[0]!.input);
  });

  test('what /profile show prints is exactly what /profile forget needs', async () => {
    // The surface contract this command owns, and the reason it is worth a test:
    // the daemon matches a prose line by its text AS STORED, which includes the
    // `- ` bullet. So the owner must not have to know the file's storage form —
    // he copies the line out of `/profile show` and it works.
    //
    // This is deliberately NOT a pin on the SDK's matching rule. The SDK's
    // owner-profile module is not in the package's `exports` map (144 subpaths,
    // no wildcard, `./platform/owner-profile` absent), so no test in this
    // surface can import `forgetProseByText` to assert against it. What is
    // asserted here is the round trip through this command, which holds
    // whatever the daemon decides to match on: whatever `show` renders is what
    // `forget` transmits.
    const rendered = renderProfileDocument(checkedDocument());
    const shownLine = rendered
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.includes('Sarah'));
    expect(shownLine).toBe(SISTER_LINE);

    // Retyping what he saw, tokenised the way the composer splits it.
    const ctx = makeCtx();
    const { registry, calls } = makeScriptedRegistry((methodId) => {
      if (methodId === 'profile.forget') return WRITE_RESULT;
      throw new Error(`unexpected call: ${methodId}`);
    });
    await registry.get('profile')!.handler(
      ['forget', '--section', 'People', ...shownLine!.split(' ')],
      ctx,
    );
    expect(calls).toHaveLength(1);
    // Byte-identical to the line as stored — no marker added, none stripped.
    expect(calls[0]!.input.text).toBe(SISTER_LINE);
  });

  test('forget --section with no text prints usage and never calls the daemon', async () => {
    const ctx = makeCtx();
    const { registry, calls } = makeScriptedRegistry(() => {
      throw new Error('should not be called');
    });
    await registry.get('profile')!.handler(['forget', '--section', 'People'], ctx);
    expect(ctx.printed.join('\n')).toContain('Usage: /profile forget --section');
    expect(calls).toHaveLength(0);
  });

  test('a note that was already gone reports that, not success', async () => {
    // The daemon answers content-addressed misses honestly; the renderer must
    // pass that through rather than manufacture a receipt (§9.2).
    const ctx = makeCtx();
    const { registry } = makeScriptedRegistry(() => ({
      ok: false,
      reason: 'That line is not in People any more, so nothing was removed.',
      changes: [],
      disclosure: '',
    }));
    await registry.get('profile')!.handler(['forget', '--section', 'People', 'gone', 'already'], ctx);
    const output = ctx.printed.join('\n');
    expect(output).toContain('not in People any more');
    expect(output).not.toMatch(/\bNoted\b/);
    expect(output).not.toMatch(/\bremoved your\b/i);
  });

  test('profile.forget no longer declares lineIndex, so a positional delete cannot be sent', () => {
    // §9.2: the owner is a concurrent writer, so a line index is only valid
    // against the file state that produced it. Asserted against the contract so
    // this test states the rule rather than trusting that nobody sends one.
    const properties = declaredInput('profile.forget').properties ?? {};
    expect('lineIndex' in properties).toBe(false);
    expect('section' in properties).toBe(true);
    expect('text' in properties).toBe(true);
  });

  test('authority is required on every write verb, not optional', () => {
    for (const verb of ['profile.set', 'profile.append', 'profile.forget', 'profile.undo']) {
      expect({ verb, required: declaredInput(verb).required ?? [] })
        .toEqual({ verb, required: expect.arrayContaining(['authority']) });
    }
  });
});

// ---------------------------------------------------------------------------
// Provenance: "where did you get that" (§8.3)
// ---------------------------------------------------------------------------

describe('/profile where', () => {
  test('reports surface, date, verbatim words and every superseded predecessor', () => {
    const report = toProfileProvenanceReport({
      fieldId: 'commerce.shippingAddress',
      present: true,
      handEdited: false,
      provenance: { surface: 'tui', date: '2026-07-27', said: 'ship it to my office instead' },
      superseded: [{
        lineIndex: 18,
        fieldId: 'commerce.shippingAddress',
        section: 'Commerce',
        text: `shipping address: ${OLD_SHIPPING}`,
        value: OLD_SHIPPING,
        supersededOn: '2026-07-27',
        previousLine: `shipping address: ${OLD_SHIPPING} — tui, 2026-07-20, "ship to 401 Home St"`,
        provenance: { surface: 'tui', date: '2026-07-20', said: 'ship to 401 Home St' },
      }],
    });
    expect(report).not.toBe(MALFORMED);
    const text = renderProfileProvenance(report as Exclude<typeof report, typeof MALFORMED>);
    expect(text).toContain('recorded by tui on 2026-07-27');
    expect(text).toContain('"ship it to my office instead"');
    expect(text).toContain(OLD_SHIPPING);
    expect(text).toContain('"ship to 401 Home St"');
  });

  test('a hand-edited line reports that, rather than inventing a source', () => {
    const report = toProfileProvenanceReport({
      fieldId: 'contact.email', present: true, handEdited: true, superseded: [],
    });
    expect(report).not.toBe(MALFORMED);
    const text = renderProfileProvenance(report as Exclude<typeof report, typeof MALFORMED>);
    expect(text).toContain('by hand');
    expect(text).not.toContain('recorded by');
  });

  test('a field that is not recorded says so', () => {
    const report = toProfileProvenanceReport({
      fieldId: 'location.homeAddress', present: false, handEdited: false, superseded: [],
    });
    expect(report).not.toBe(MALFORMED);
    expect(renderProfileProvenance(report as Exclude<typeof report, typeof MALFORMED>))
      .toContain('has no location.homeAddress recorded');
  });

  test('a bare label resolves to its field id through the live document', async () => {
    const ctx = makeCtx();
    const { registry, calls } = makeScriptedRegistry((methodId) => {
      if (methodId === 'profile.read') return DOCUMENT_RESPONSE;
      if (methodId === 'profile.provenance') {
        return { fieldId: 'commerce.shippingAddress', present: true, handEdited: true, superseded: [] };
      }
      throw new Error(`unexpected call: ${methodId}`);
    });
    await registry.get('profile')!.handler(['where', 'shipping', 'address'], ctx);
    // The label map is built from the live response, never from a local copy of
    // the SDK's field registry — so the two can never disagree.
    expect(collectFieldLabels(checkedDocument()).get('shipping address')).toEqual(['commerce.shippingAddress']);
    expect(calls.map((call) => call.methodId)).toEqual(['profile.read', 'profile.provenance']);
    expect(calls[1]?.input.fieldId).toBe('commerce.shippingAddress');
  });

  test('a label that matches nothing is passed through, so the daemon answers', async () => {
    const ctx = makeCtx();
    const { registry, calls } = makeScriptedRegistry((methodId) => {
      if (methodId === 'profile.read') return DOCUMENT_RESPONSE;
      if (methodId === 'profile.provenance') {
        return { fieldId: 'favourite colour', present: false, handEdited: false, superseded: [] };
      }
      throw new Error(`unexpected call: ${methodId}`);
    });
    await registry.get('profile')!.handler(['where', 'favourite', 'colour'], ctx);
    expect(calls[1]?.input.fieldId).toBe('favourite colour');
  });

  test('a dotted field id is passed straight through with no extra read', async () => {
    const ctx = makeCtx();
    const { registry, calls } = makeScriptedRegistry((methodId) => {
      if (methodId === 'profile.provenance') {
        return { fieldId: 'commerce.shippingAddress', present: false, handEdited: false, superseded: [] };
      }
      throw new Error(`unexpected call: ${methodId}`);
    });
    await registry.get('profile')!.handler(['where', 'commerce.shippingAddress'], ctx);
    expect(calls.map((call) => call.methodId)).toEqual(['profile.provenance']);
  });
});

// ---------------------------------------------------------------------------
// Response checking: a malformed daemon response is stated, never thrown
// ---------------------------------------------------------------------------

describe('response checking', () => {
  test('a response missing a required property is refused rather than rendered', () => {
    expect(toProfileDocument(null)).toBe(MALFORMED);
    expect(toProfileDocument({ sections: [] })).toBe(MALFORMED);
    expect(toProfileDocument({ state: LOADED_STATE })).toBe(MALFORMED);
    expect(toProfileWriteResult({ ok: 'yes', changes: [], disclosure: '' })).toBe(MALFORMED);
    expect(toProfileProvenanceReport({ fieldId: 'x', present: true })).toBe(MALFORMED);
    expect(toProfileState({ path: 'x' })).toBe(MALFORMED);
  });

  test('one malformed member fails the whole response — no silent filtering', () => {
    expect(toProfileDocument({
      state: LOADED_STATE,
      sections: [DOCUMENT_RESPONSE.sections[0], { heading: 'Broken' }],
    })).toBe(MALFORMED);
  });

  test('a malformed response is reported as a version mismatch, not a crash', async () => {
    const ctx = makeCtx();
    const { registry } = makeScriptedRegistry(() => ({ unexpected: true }));
    await registry.get('profile')!.handler(['show'], ctx);
    expect(ctx.printed.join('\n')).toContain('does not recognise');
  });

  test('a thrown transport error renders honestly instead of a fabricated empty profile', async () => {
    const ctx = makeCtx();
    const { registry } = makeScriptedRegistry(() => { throw new Error('connection refused'); });
    await registry.get('profile')!.handler(['status'], ctx);
    const output = ctx.printed.join('\n');
    expect(output).toContain('connection refused');
    expect(output).not.toContain('Profile status: loaded');
  });
});

// ---------------------------------------------------------------------------
// Settings registration (§12.1) — the drop that killed push.* and cluster.*
// ---------------------------------------------------------------------------

describe('profile settings category', () => {
  test('"profile" is a settings category, so profile.* keys are not dropped', () => {
    expect(SETTINGS_CATEGORIES).toContain('profile');
  });

  test('"profile" belongs to exactly one group, and that group is Runtime & Data', () => {
    const owning = SETTINGS_CATEGORY_GROUPS.filter((group) => group.categories.includes('profile'));
    expect(owning).toHaveLength(1);
    expect(owning[0]!.label).toBe('Runtime & Data');
  });

  test('the category has a display name and a real description', () => {
    expect(CATEGORY_LABELS.profile).toBe('Owner Profile');
    expect(CATEGORY_INFO.profile.length).toBeGreaterThan(80);
  });
});

// ---------------------------------------------------------------------------
// The keys actually reach the settings workspace
//
// The category union and group membership above are necessary but not
// sufficient: buildSettingGroups guards every push with `if (groups.has(cat))`,
// so this is the test that proves nothing is dropped between CONFIG_SCHEMA and
// the rendered category. push.* and cluster.* each passed a "the category
// exists" check and still vanished; only this one would have caught it.
// ---------------------------------------------------------------------------

describe('profile.* keys reach the settings workspace', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  function makeConfig(): ConfigManager {
    const dir = mkdtempSync(join(tmpdir(), 'gv-owner-profile-settings-'));
    roots.push(dir);
    return new ConfigManager({ workingDir: dir, homeDir: dir, surfaceRoot: 'tui' });
  }

  /** The eight keys design §12 specifies, by name rather than by count. */
  const EXPECTED_KEYS = [
    'profile.enabled',
    'profile.autonomousWrites',
    'profile.discloseWrites',
    'profile.injectOpenTier',
    'profile.discloseClosedTierReads',
    'profile.consumerFallback',
    'profile.reloadThrottleMs',
    'profile.path',
  ] as const;

  test('the SDK schema carries every profile.* key the design specifies', () => {
    const inSchema = new Set(
      CONFIG_SCHEMA.filter((setting) => setting.key.startsWith('profile.')).map((setting) => setting.key),
    );
    for (const key of EXPECTED_KEYS) expect(inSchema.has(key)).toBe(true);
    // No extras: a key here that the design does not name is a drift signal.
    expect(inSchema.size).toBe(EXPECTED_KEYS.length);
  });

  test('every one of them lands in the "profile" category, none dropped', () => {
    const groups = buildSettingGroups(makeConfig());
    const rows = groups.get('profile') ?? [];
    const keysInCategory = new Set(rows.map((entry) => entry.setting.key));
    for (const key of EXPECTED_KEYS) expect(keysInCategory.has(key)).toBe(true);
    expect(rows.length).toBe(EXPECTED_KEYS.length);
  });

  test('the category is not empty, which is what the silent-drop failure looks like', () => {
    const rows = buildSettingGroups(makeConfig()).get('profile') ?? [];
    expect(rows.length).toBeGreaterThan(0);
  });

  test('the rows are real editable settings with types, defaults and descriptions', () => {
    const rows = buildSettingGroups(makeConfig()).get('profile') ?? [];
    for (const row of rows) {
      expect(row.setting.type.length).toBeGreaterThan(0);
      expect(row.setting.description.length).toBeGreaterThan(0);
      expect(row.setting.default).toBeDefined();
      // Nothing is configured in a fresh workspace, so every row reads default.
      expect(row.isDefault).toBe(true);
    }
    // §12's defaults: the feature ships on, not dark.
    const enabled = rows.find((row) => row.setting.key === 'profile.enabled');
    expect(enabled?.currentValue).toBe(true);
    const autonomous = rows.find((row) => row.setting.key === 'profile.autonomousWrites');
    expect(autonomous?.currentValue).toBe(true);
    const disclose = rows.find((row) => row.setting.key === 'profile.discloseWrites');
    expect(disclose?.currentValue).toBe(true);
  });
});
