/**
 * profile-runtime.ts
 *
 * `/profile` — the owner profile in the TUI: what the platform knows about the
 * person who owns it, kept as one hand-editable Markdown file at daemon scope
 * (docs/owner-profile.md).
 *
 * The subcommands exist to make §8.3's three questions answerable here, not just
 * in the agent:
 *
 *   /profile        → profile.read        "what do you know about me?"
 *   /profile where  → profile.provenance  "where did you get that?"
 *   /profile forget → profile.forget      "forget that"
 *
 * plus `set`, `note`, `undo` and `status` so a correction, a note, a recovery
 * and a diagnosis do not require leaving the terminal or hand-editing the file
 * (which remains allowed, and authoritative — §4.5).
 *
 * ## Why it goes over the operator wire
 *
 * Same reason `/principals`, `/ci` and `/checkin` do (see operator-rpc.ts): the
 * `profile.*` family ships in the operator contract and has not been promoted to
 * the in-process `OperatorClient` facade. Surfaces never open the profile file —
 * the daemon is the single writer, which is what makes its rename-based atomic
 * writes sufficient with no lock (§3, §5.4). This command therefore has no file
 * path, no parser and no writer of its own, and could not corrupt the document
 * if it tried.
 *
 * ## Containment
 *
 * Values reach exactly one place: the string handed to `ctx.print`. This module
 * imports no logger, builds no diagnostic payload, and never puts a value in an
 * error message — a failed call renders `describeOperatorRpcError`, which
 * describes the transport, not the content. A write prints the daemon's
 * one-line disclosure and the field names that changed, never the value that was
 * just recorded (§8.2). The `People` section is third-party personal data and is
 * shown only in `/profile show`, i.e. only when the owner asked this surface,
 * this turn, what it knows about him.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { describeOperatorRpcError, getOperatorRpc, type OperatorRpc } from './operator-rpc.ts';
import {
  MALFORMED,
  toProfileDocument,
  toProfileProvenanceReport,
  toProfileState,
  toProfileWriteResult,
  type ExactProfileInput,
  type ProfileInput,
  type ProfileVerb,
  type ProfileWriteVerb,
} from './profile-types.ts';
import {
  PROFILE_TAG,
  collectFieldLabels,
  normalizeFieldToken,
  renderProfileDocument,
  renderProfileProvenance,
  renderProfileStatus,
  renderProfileWriteResult,
} from './profile-render.ts';

/** Which surface is recording a line. Named in the provenance suffix. */
const TUI_SURFACE = 'tui';

const SUBCOMMANDS = ['show', 'where', 'set', 'note', 'forget', 'undo', 'status'] as const;

const USAGE = [
  'Usage: /profile <subcommand>',
  '  /profile [show]                          — what the platform knows about you, by section',
  '  /profile where <field>                   — where that came from: surface, date, your exact words',
  '  /profile set <field> <value>             — record or correct one field',
  '  /profile note [--section <name>] <text>  — add a note (Notes unless you name a section)',
  '  /profile forget <field>                  — delete a field and every retained predecessor',
  '  /profile forget --section <name> <text>  — delete a note, named by its text',
  '  /profile undo <field>                    — put a field\'s most recent superseded value back',
  '  /profile status                          — whether it loaded, from where, what did not validate',
  '',
  '  <field> is a field id such as commerce.shippingAddress, or the label as written',
  '  in the file (e.g. "shipping address") once that field is recorded. /profile show',
  '  prints each field id beside its value.',
  '',
  '  Notes in People, Places, Work and Notes have no field id — forget those with',
  '  --section and the line as /profile show prints it. The leading "-" is optional;',
  '  the rest must match, and if two notes read the same nothing is removed.',
].join('\n');

/**
 * Invoke a `profile.*` verb.
 *
 * The verb id and its input ARE checked against the generated contract, so a
 * misspelled field name or a missing required argument is a compile error here
 * rather than a 400 discovered at runtime.
 *
 * The RESULT is deliberately `unknown`. Widening the method id to `string` at
 * the call site selects the client's generic
 * `invoke<T = unknown>(methodId: string, …)` overload rather than the typed
 * one, because the typed overload's return type is a claim about the wire that
 * nothing enforces: only 5 of the contract's 452 method ids carry a Zod
 * response schema and no `profile.*` verb is one of them (see
 * profile-types.ts). Every response goes through a checker before a renderer
 * reads a property off it.
 */
type ProfileInvoke = <TVerb extends ProfileVerb, TBody extends ProfileInput<TVerb>>(
  methodId: TVerb,
  input: ExactProfileInput<TVerb, TBody>,
) => Promise<unknown>;

/**
 * The rpc resolver, injectable so tests can drive the full command against a
 * scripted daemon instead of a live one. Production always uses
 * {@link getOperatorRpc}.
 */
export interface ProfileCommandDeps {
  readonly resolveRpc: (context: CommandContext) => OperatorRpc;
}

const DEFAULT_DEPS: ProfileCommandDeps = { resolveRpc: getOperatorRpc };

function unrecognizedResponse(verb: string): string {
  return `${PROFILE_TAG} the daemon answered ${verb} with a response this build does not recognise — it is probably running a different platform version. Nothing was read or written.`;
}

/**
 * Resolve what the owner typed to a field id.
 *
 * A dotted token is already an id and is passed through untouched. A bare label
 * ("shipping address") is matched against the labels in the live `profile.read`
 * response — deliberately NOT against a copy of the SDK's field registry, which
 * would be a second list to keep in step with the first. A label that matches
 * nothing is passed through unchanged so the daemon answers with its own message
 * naming what is wrong, rather than this command guessing.
 */
async function resolveFieldToken(
  invoke: ProfileInvoke,
  token: string,
  print: (text: string) => void,
): Promise<string | null> {
  if (token.includes('.')) return token;
  let raw: unknown;
  try {
    raw = await invoke('profile.read', {});
  } catch {
    return token;
  }
  const document = toProfileDocument(raw);
  if (document === MALFORMED) return token;
  const matches = collectFieldLabels(document).get(normalizeFieldToken(token));
  if (!matches || matches.length === 0) return token;
  if (matches.length === 1) return matches[0] ?? token;
  print(`${PROFILE_TAG} "${token}" matches more than one field: ${matches.join(', ')}. Use the full field id.`);
  return null;
}

async function runShow(invoke: ProfileInvoke, print: (text: string) => void): Promise<void> {
  try {
    const document = toProfileDocument(await invoke('profile.read', {}));
    print(document === MALFORMED ? unrecognizedResponse('profile.read') : renderProfileDocument(document));
  } catch (error) {
    print(`${PROFILE_TAG} ${describeOperatorRpcError(error)}`);
  }
}

async function runStatus(invoke: ProfileInvoke, print: (text: string) => void): Promise<void> {
  try {
    const state = toProfileState(await invoke('profile.status', {}));
    print(state === MALFORMED ? unrecognizedResponse('profile.status') : renderProfileStatus(state));
  } catch (error) {
    print(`${PROFILE_TAG} ${describeOperatorRpcError(error)}`);
  }
}

async function runWhere(invoke: ProfileInvoke, token: string, print: (text: string) => void): Promise<void> {
  const fieldId = await resolveFieldToken(invoke, token, print);
  if (fieldId === null) return;
  try {
    const report = toProfileProvenanceReport(await invoke('profile.provenance', { fieldId }));
    print(report === MALFORMED ? unrecognizedResponse('profile.provenance') : renderProfileProvenance(report));
  } catch (error) {
    print(`${PROFILE_TAG} ${describeOperatorRpcError(error)}`);
  }
}

/**
 * Run one write verb and render what it actually did.
 *
 * The response is the only source of the outcome line: a refusal prints the
 * daemon's reason and a no-op prints "nothing changed", so a `/profile forget`
 * for something that was not recorded can never come back as a success (§9.2).
 */
async function runWrite<TVerb extends ProfileWriteVerb, TBody extends ProfileInput<TVerb>>(
  invoke: ProfileInvoke,
  verb: TVerb,
  input: ExactProfileInput<TVerb, TBody>,
  print: (text: string) => void,
): Promise<void> {
  try {
    const result = toProfileWriteResult(await invoke(verb, input));
    print(result === MALFORMED ? unrecognizedResponse(verb) : renderProfileWriteResult(result));
  } catch (error) {
    print(`${PROFILE_TAG} ${describeOperatorRpcError(error)}`);
  }
}

/**
 * `--section <name>` followed by free text, shared by `/profile note` and
 * `/profile forget`. Section defaults to Notes, which is only meaningful for
 * `note` — `forget` calls this solely when `--section` was given.
 */
function parseSectionArgs(args: readonly string[]): { section: string; text: string } {
  if (args[1] === '--section' && typeof args[2] === 'string' && args[2].length > 0) {
    return { section: args[2], text: args.slice(3).join(' ').trim() };
  }
  return { section: 'Notes', text: args.slice(1).join(' ').trim() };
}

export function registerProfileRuntimeCommands(
  registry: CommandRegistry,
  deps: ProfileCommandDeps = DEFAULT_DEPS,
): void {
  registry.register({
    name: 'profile',
    description: 'What the platform knows about you: read it, correct it, trace where a fact came from, or forget one',
    usage: '[show|where <field>|set <field> <value>|note [--section <name>] <text>|forget <field>|forget --section <name> <text>|undo <field>|status]',
    argsHint: '[show|where|set|note|forget|undo|status]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'show';
      if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
        ctx.print(USAGE);
        return;
      }

      // Validate each subcommand's arguments before touching the connection, so
      // a usage mistake never depends on daemon reachability to be reported.
      //
      // where/forget/undo take the whole remainder as the field, so a label
      // written with a space ("shipping address") works unquoted. `set` cannot
      // do that — everything after the first token is the value — so a label
      // there must be one word, or the field id.
      const fieldToken = sub === 'set' ? args[1] : args.slice(1).join(' ').trim();

      // `/profile forget --section <name> <text>` removes a prose bullet, which
      // is the only way to forget a line in People, Places, Work or Notes —
      // those sections have no mechanical fields at all (§4.3), so without this
      // "forget that" would answer for a shipping address but not for a note
      // about a person. The line is named by its exact text, never by position:
      // the owner edits this file himself, so an index taken from an earlier
      // read may address a different line by the time the delete lands (§9.2).
      const forgetProse = sub === 'forget' && args[1] === '--section' ? parseSectionArgs(args) : null;
      if (forgetProse && forgetProse.text.length === 0) {
        ctx.print('Usage: /profile forget --section <name> <the exact text of the line>');
        return;
      }
      if ((sub === 'where' || sub === 'undo' || (sub === 'forget' && !forgetProse)) && !fieldToken) {
        ctx.print(`Usage: /profile ${sub} <field>`);
        return;
      }
      const setValue = sub === 'set' ? args.slice(2).join(' ').trim() : '';
      if (sub === 'set' && (!fieldToken || setValue.length === 0)) {
        ctx.print('Usage: /profile set <field> <value>');
        return;
      }
      const note = sub === 'note' ? parseSectionArgs(args) : null;
      if (note && note.text.length === 0) {
        ctx.print('Usage: /profile note [--section <name>] <text>');
        return;
      }

      const rpc = deps.resolveRpc(ctx);
      if (!rpc.available) {
        ctx.print(`${PROFILE_TAG} ${rpc.reason}`);
        return;
      }
      // `methodId as string` is what picks the generic overload, so the result
      // stays `unknown` and has to go through a checker — see ProfileInvoke.
      const invoke: ProfileInvoke = (methodId, input) =>
        rpc.sdk.operator.invoke(methodId as string, input as unknown as Record<string, unknown>);
      const print = (text: string): void => { ctx.print(text); };

      if (sub === 'show') {
        await runShow(invoke, print);
        return;
      }
      if (sub === 'status') {
        await runStatus(invoke, print);
        return;
      }
      if (sub === 'where') {
        await runWhere(invoke, fieldToken!, print);
        return;
      }

      if (sub === 'set') {
        const fieldId = await resolveFieldToken(invoke, fieldToken!, print);
        if (fieldId === null) return;
        // `said` is the command as typed. It is a verbatim owner utterance,
        // which is what layer 3 of the trust gate requires (§7) and what makes
        // "where did you get that" answer with something he recognises.
        //
        // `authority: 'owner-direct'` is claimed here, not defaulted by the
        // daemon: every call in this handler runs because the owner typed a
        // `/profile` command into this terminal on his own machine, which is
        // exactly what the owner-direct tier means (docs/owner-profile.md
        // §7). That is the whole justification for the claim, so it is
        // written out once here rather than copied silently to the other
        // three write sites below.
        //
        // The daemon requires it: `readAuthority` refuses an absent value
        // outright. An earlier build defaulted it to owner-direct instead, and
        // stating the claim rather than leaning on that default is precisely
        // why this command kept working when it was tightened. It is the only
        // gate `forget` and `undo` have — layers 2 and 3 do not apply to a
        // removal — so it is not a field to leave to anyone else's default.
        //
        // This surface can hardcode it; the agent must not. The TUI's only
        // input is the owner at his own keyboard, whereas the agent can be
        // handed a purported fact by a page, an email or a channel message and
        // has to state the real source per write.
        await runWrite(invoke, 'profile.set', {
          fieldId,
          value: setValue,
          surface: TUI_SURFACE,
          said: `/profile set ${fieldToken} ${setValue}`,
          authority: 'owner-direct',
        }, print);
        return;
      }

      if (sub === 'note' && note) {
        await runWrite(invoke, 'profile.append', {
          section: note.section,
          text: note.text,
          surface: TUI_SURFACE,
          said: `/profile note ${note.text}`,
          authority: 'owner-direct',
        }, print);
        return;
      }

      if (sub === 'forget') {
        if (forgetProse) {
          await runWrite(invoke, 'profile.forget', {
            section: forgetProse.section,
            text: forgetProse.text,
            authority: 'owner-direct',
          }, print);
          return;
        }
        const fieldId = await resolveFieldToken(invoke, fieldToken!, print);
        if (fieldId === null) return;
        await runWrite(invoke, 'profile.forget', { fieldId, authority: 'owner-direct' }, print);
        return;
      }

      if (sub === 'undo') {
        const fieldId = await resolveFieldToken(invoke, fieldToken!, print);
        if (fieldId === null) return;
        await runWrite(invoke, 'profile.undo', { fieldId, authority: 'owner-direct' }, print);
      }
    },
  });
}
