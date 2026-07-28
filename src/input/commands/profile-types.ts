/**
 * profile-types.ts
 *
 * Response shapes for the owner-profile control-plane verbs (`profile.*`), and
 * the runtime checks that turn an untyped daemon response into one of them.
 *
 * ## The shapes come from the contract, not from a copy of it
 *
 * Every type below is derived from `OperatorMethodOutput<'profile.…'>` — the
 * types generated from the SDK's own output schemas
 * (`platform/control-plane/method-catalog-owner-profile.ts`). Nothing here
 * restates a field name, so this file cannot drift from the contract: if a
 * verb's shape changes, the checkers stop compiling against it.
 *
 * ## Why the responses are still checked at runtime
 *
 * A generated type is a compile-time claim about what the wire *should* carry,
 * and nothing enforces it at runtime here. The operator client's
 * `validateResponses` defaults on, but it only validates method ids with a
 * matching exported Zod schema and `buildSchemaRegistry` silently skips the
 * rest. Measured against the installed contracts package: 5 of 452 method ids
 * have one, and no `profile.*` verb is among them. So response validation is
 * not a safety net this command can lean on — for these verbs or for most
 * others.
 *
 * So a daemon on a different version — or a 200 from something that is not this
 * daemon at all — would otherwise reach a renderer and throw on a missing array,
 * which in a slash command means a stack trace instead of an answer. Each `toX`
 * function does the cast to `Record<string, unknown>` in ONE place, checks every
 * property a renderer will read, and returns {@link MALFORMED} when anything is
 * off. The command then prints an honest "this build does not recognise that
 * response" line.
 *
 * A malformed *member* fails the whole response rather than being filtered out.
 * Silently dropping a section or a line the checker did not recognise would be
 * the same failure §4.4 forbids in the parser: content disappearing without
 * anyone being told.
 */
import type { OperatorMethodInput, OperatorMethodOutput } from '@pellux/goodvibes-sdk';

/** Returned by every checker when the response does not match the contract. */
export const MALFORMED: unique symbol = Symbol('malformed-profile-response');
export type Checked<T> = T | typeof MALFORMED;

/** The verbs this command calls. Typing the ids is what types the inputs. */
export type ProfileReadVerb = 'profile.read' | 'profile.provenance' | 'profile.status';
export type ProfileWriteVerb = 'profile.set' | 'profile.append' | 'profile.forget' | 'profile.undo';
export type ProfileVerb = ProfileReadVerb | ProfileWriteVerb;

/** The contract's own input shape for a verb, so a wrong field name will not compile. */
export type ProfileInput<TVerb extends ProfileVerb> = OperatorMethodInput<TVerb>;

/**
 * Every key of every member of a union. `keyof` on a union yields only the keys
 * the members SHARE, so a union target would be checked against that
 * intersection and would wave through a key belonging to a sibling verb.
 */
type UnionKeys<T> = T extends unknown ? keyof T : never;

/**
 * Reject a key the contract does not declare, including on a body that is not a
 * fresh object literal.
 *
 * Typing a parameter as the contract input is NOT sufficient on its own:
 * TypeScript applies excess-property checking only to fresh literals, so
 * `const body = { …, lineIndex: 3 }; invoke('profile.forget', body)` compiles
 * clean while the identical keys written inline are an error. Verified against
 * this very command, not assumed.
 *
 * That is not hypothetical — `profile.forget` really did retire `lineIndex`,
 * and a body built one line earlier would have carried it silently past a
 * correctly typed parameter. Seeding inline literals proves only the cases
 * someone thought to seed; this closes the shape.
 *
 * Intersecting the parameter with this maps every undeclared key to `never`, so
 * no real value satisfies it however the object was built. Distributed over the
 * target union via {@link UnionKeys} so each member is checked rather than only
 * the keys they have in common.
 */
export type NoExcessKeys<TBody, TShape> = Record<Exclude<keyof TBody, UnionKeys<TShape>>, never>;

/** A body that conforms to a verb's declared input and carries nothing extra. */
export type ExactProfileInput<TVerb extends ProfileVerb, TBody> =
  TBody & NoExcessKeys<TBody, ProfileInput<TVerb>>;

/** What `profile.read` answers: the whole document, by section. */
export type ProfileDocumentView = OperatorMethodOutput<'profile.read'>;

/**
 * Load state — what `profile.status` answers, and the `state` half of a read.
 *
 * `kind` is `loaded` | `unavailable` | `disabled`. The counts belong to
 * `loaded` and `reason` to `unavailable`. There is no value property anywhere
 * in this shape, which is what makes the status output safe to show in a
 * diagnostic context (§11.3).
 */
export type ProfileStateView = OperatorMethodOutput<'profile.status'>;

/** What `profile.provenance` answers for one field. */
export type ProfileProvenanceReportView = OperatorMethodOutput<'profile.provenance'>;

/** What every write verb answers. `ok: false` always carries a reason. */
export type ProfileWriteResultView = OperatorMethodOutput<'profile.set'>;

/** One `## ` section, with the tier its content belongs to. */
export type ProfileSectionView = ProfileDocumentView['sections'][number];
/** One mechanical field. `valid: false` still carries the value — see §4.3. */
export type ProfileFieldView = ProfileSectionView['fields'][number];
/** One prose line, preserved as written. */
export type ProfileLineView = ProfileSectionView['prose'][number];
/** Where a line came from: which surface, when, and the owner's exact words. */
export type ProfileProvenanceView = NonNullable<ProfileFieldView['provenance']>;
/** A mechanical value that did not validate, and why. Never fails the file. */
export type ProfileInvalidFieldView = NonNullable<ProfileStateView['invalidFields']>[number];
/** A retained `<!-- was: … -->` predecessor, so a wrong correction is recoverable. */
export type ProfileSupersededView = ProfileProvenanceReportView['superseded'][number];
/** One thing a write did. Names the field; never repeats the value. */
export type ProfileChangeView = ProfileWriteResultView['changes'][number];

/**
 * Compile-time proof of two things this file assumes: that all four write verbs
 * really do answer one shape, and that `profile.status` really is the same
 * `state` a read carries.
 *
 * One write checker serves four verbs and `toProfileState` checks both the
 * status response and a read's `state`. If the contract ever splits them,
 * `Exact` collapses to `never` and this assignment stops compiling, rather than
 * the difference going unnoticed until a response renders wrong.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const PROFILE_CONTRACT_SHAPES_AGREE: Exact<OperatorMethodOutput<'profile.append'>, ProfileWriteResultView>
  & Exact<OperatorMethodOutput<'profile.forget'>, ProfileWriteResultView>
  & Exact<OperatorMethodOutput<'profile.undo'>, ProfileWriteResultView>
  & Exact<ProfileDocumentView['state'], ProfileStateView> = true;

// ---------------------------------------------------------------------------
// Primitive checks
// ---------------------------------------------------------------------------

/** The single place an untyped response is narrowed to an indexable object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as unknown as Record<string, unknown>;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Absent and null both mean "not supplied"; anything else must be a string. */
function optionalString(value: unknown): Checked<string | undefined> {
  if (value === undefined || value === null) return undefined;
  return isString(value) ? value : MALFORMED;
}

function optionalBoolean(value: unknown): Checked<boolean | undefined> {
  if (value === undefined || value === null) return undefined;
  return isBoolean(value) ? value : MALFORMED;
}

function optionalNumber(value: unknown): Checked<number | undefined> {
  if (value === undefined || value === null) return undefined;
  return isFiniteNumber(value) ? value : MALFORMED;
}

/** An array whose every member checks out, or MALFORMED. Never a filtered subset. */
function checkedArray<T>(value: unknown, check: (entry: unknown) => Checked<T>): Checked<T[]> {
  if (!Array.isArray(value)) return MALFORMED;
  const out: T[] = [];
  for (const entry of value) {
    const parsed = check(entry);
    if (parsed === MALFORMED) return MALFORMED;
    out.push(parsed);
  }
  return out;
}

function checkedStringArray(value: unknown): Checked<string[]> {
  return checkedArray(value, (entry) => (isString(entry) ? entry : MALFORMED));
}

// ---------------------------------------------------------------------------
// Response checks
// ---------------------------------------------------------------------------

function toProvenance(value: unknown): Checked<ProfileProvenanceView | undefined> {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  if (!record) return MALFORMED;
  const { surface, date, said } = record;
  if (!isString(surface) || !isString(date) || !isString(said)) return MALFORMED;
  return { surface, date, said };
}

function toLine(value: unknown): Checked<ProfileLineView> {
  const record = asRecord(value);
  if (!record) return MALFORMED;
  const { lineIndex, section, text } = record;
  if (!isFiniteNumber(lineIndex) || !isString(section) || !isString(text)) return MALFORMED;
  const provenance = toProvenance(record.provenance);
  if (provenance === MALFORMED) return MALFORMED;
  return { lineIndex, section, text, ...(provenance ? { provenance } : {}) };
}

function toField(value: unknown): Checked<ProfileFieldView> {
  const record = asRecord(value);
  if (!record) return MALFORMED;
  const { fieldId, label, value: fieldValue, valid } = record;
  if (!isString(fieldId) || !isString(label) || !isString(fieldValue) || !isBoolean(valid)) return MALFORMED;
  const invalidReason = optionalString(record.invalidReason);
  if (invalidReason === MALFORMED) return MALFORMED;
  const provenance = toProvenance(record.provenance);
  if (provenance === MALFORMED) return MALFORMED;
  return {
    fieldId,
    label,
    value: fieldValue,
    valid,
    ...(invalidReason === undefined ? {} : { invalidReason }),
    ...(provenance ? { provenance } : {}),
  };
}

function toSection(value: unknown): Checked<ProfileSectionView> {
  const record = asRecord(value);
  if (!record) return MALFORMED;
  const { heading, tier } = record;
  if (!isString(heading) || !isString(tier)) return MALFORMED;
  const fields = checkedArray(record.fields, toField);
  if (fields === MALFORMED) return MALFORMED;
  const prose = checkedArray(record.prose, toLine);
  if (prose === MALFORMED) return MALFORMED;
  return { heading, tier, fields, prose };
}

function toInvalidField(value: unknown): Checked<ProfileInvalidFieldView> {
  const record = asRecord(value);
  if (!record) return MALFORMED;
  const { fieldId, reason } = record;
  if (!isString(fieldId) || !isString(reason)) return MALFORMED;
  return { fieldId, reason };
}

/** `profile.status`, and the `state` half of `profile.read`. */
export function toProfileState(value: unknown): Checked<ProfileStateView> {
  const record = asRecord(value);
  if (!record) return MALFORMED;
  const { kind, path } = record;
  if (!isString(kind) || !isString(path)) return MALFORMED;
  const exists = optionalBoolean(record.exists);
  if (exists === MALFORMED) return MALFORMED;
  const lineCount = optionalNumber(record.lineCount);
  if (lineCount === MALFORMED) return MALFORMED;
  const fieldCount = optionalNumber(record.fieldCount);
  if (fieldCount === MALFORMED) return MALFORMED;
  const proseLineCount = optionalNumber(record.proseLineCount);
  if (proseLineCount === MALFORMED) return MALFORMED;
  const reason = optionalString(record.reason);
  if (reason === MALFORMED) return MALFORMED;
  const sections = record.sections === undefined || record.sections === null
    ? undefined
    : checkedStringArray(record.sections);
  if (sections === MALFORMED) return MALFORMED;
  const invalidFields = record.invalidFields === undefined || record.invalidFields === null
    ? undefined
    : checkedArray(record.invalidFields, toInvalidField);
  if (invalidFields === MALFORMED) return MALFORMED;
  return {
    kind,
    path,
    ...(exists === undefined ? {} : { exists }),
    ...(lineCount === undefined ? {} : { lineCount }),
    ...(fieldCount === undefined ? {} : { fieldCount }),
    ...(proseLineCount === undefined ? {} : { proseLineCount }),
    ...(sections === undefined ? {} : { sections }),
    ...(invalidFields === undefined ? {} : { invalidFields }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** `profile.read`. */
export function toProfileDocument(value: unknown): Checked<ProfileDocumentView> {
  const record = asRecord(value);
  if (!record) return MALFORMED;
  const state = toProfileState(record.state);
  if (state === MALFORMED) return MALFORMED;
  const sections = checkedArray(record.sections, toSection);
  if (sections === MALFORMED) return MALFORMED;
  return { state, sections };
}

function toSuperseded(value: unknown): Checked<ProfileSupersededView> {
  const record = asRecord(value);
  if (!record) return MALFORMED;
  const { lineIndex, fieldId, section, text, value: supersededValue, supersededOn, previousLine } = record;
  if (
    !isFiniteNumber(lineIndex)
    || !isString(fieldId)
    || !isString(section)
    || !isString(text)
    || !isString(supersededValue)
    || !isString(supersededOn)
    || !isString(previousLine)
  ) return MALFORMED;
  const provenance = toProvenance(record.provenance);
  if (provenance === MALFORMED) return MALFORMED;
  return {
    lineIndex,
    fieldId,
    section,
    text,
    value: supersededValue,
    supersededOn,
    previousLine,
    ...(provenance ? { provenance } : {}),
  };
}

/** `profile.provenance`. */
export function toProfileProvenanceReport(value: unknown): Checked<ProfileProvenanceReportView> {
  const record = asRecord(value);
  if (!record) return MALFORMED;
  const { fieldId, present, handEdited } = record;
  if (!isString(fieldId) || !isBoolean(present) || !isBoolean(handEdited)) return MALFORMED;
  const provenance = toProvenance(record.provenance);
  if (provenance === MALFORMED) return MALFORMED;
  const superseded = checkedArray(record.superseded, toSuperseded);
  if (superseded === MALFORMED) return MALFORMED;
  return { fieldId, present, handEdited, ...(provenance ? { provenance } : {}), superseded };
}

function toChange(value: unknown): Checked<ProfileChangeView> {
  const record = asRecord(value);
  if (!record) return MALFORMED;
  const { kind, section, label, superseded } = record;
  if (!isString(kind) || !isString(section) || !isString(label) || !isBoolean(superseded)) return MALFORMED;
  const fieldId = optionalString(record.fieldId);
  if (fieldId === MALFORMED) return MALFORMED;
  return { kind, section, label, superseded, ...(fieldId === undefined ? {} : { fieldId }) };
}

/** `profile.set`, `profile.append`, `profile.forget`, `profile.undo`. */
export function toProfileWriteResult(value: unknown): Checked<ProfileWriteResultView> {
  const record = asRecord(value);
  if (!record) return MALFORMED;
  const { ok, disclosure } = record;
  if (!isBoolean(ok) || !isString(disclosure)) return MALFORMED;
  const reason = optionalString(record.reason);
  if (reason === MALFORMED) return MALFORMED;
  const changes = checkedArray(record.changes, toChange);
  if (changes === MALFORMED) return MALFORMED;
  return { ok, disclosure, changes, ...(reason === undefined ? {} : { reason }) };
}
