import { describe, expect, test } from 'bun:test';
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
  type ProfileDocumentView,
  type ProfileStateView,
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

    const second = makeScriptedRegistry(respond);
    await second.registry.get('profile')!.handler(['note', '--section', 'Places', 'gym', 'is', 'the', 'Y'], makeCtx());
    expect(second.calls[0]?.input.section).toBe('Places');
    expect(second.calls[0]?.input.text).toBe('gym is the Y');
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
