/**
 * profile-types.ts
 *
 * Response shapes for the owner-profile control-plane verbs (`profile.*`), and
 * the runtime checks that turn an untyped daemon response into one of them.
 *
 * ## Why these live here instead of coming from the SDK
 *
 * The `profile.*` verbs are new (docs/owner-profile.md §11.1) and the installed
 * `@pellux/goodvibes-sdk` predates them, so `OperatorMethodOutput<'profile.read'>`
 * does not exist yet and `sdk.operator.invoke('profile.read', …)` resolves to the
 * generic `invoke<T = unknown>(methodId: string, …)` overload. These interfaces
 * mirror the SDK's own output schemas field for field
 * (`platform/control-plane/method-catalog-owner-profile.ts`) so the two cannot
 * disagree about what a response looks like. When a published SDK exports them,
 * delete the interfaces below and re-export the SDK's — the guards keep working
 * unchanged because they only read properties.
 *
 * ## Why every response is checked rather than cast
 *
 * `invoke` hands back `unknown`. A bare `as` on that would let a daemon on a
 * different version — or a 200 from something that is not this daemon at all —
 * reach the renderer and throw on a missing array, which in a slash command
 * means a stack trace instead of an answer. So each `toX` function does the cast
 * to `Record<string, unknown>` in ONE place, checks every property the renderer
 * will read, and returns {@link MALFORMED} when anything is off. The command
 * then prints an honest "this build does not understand that response" line.
 *
 * A malformed *member* fails the whole response rather than being filtered out.
 * Silently dropping a section or a line the checker did not recognise would be
 * the same failure §4.4 forbids in the parser: content disappearing without
 * anyone being told.
 */

/** Returned by every checker when the response does not match the contract. */
export const MALFORMED: unique symbol = Symbol('malformed-profile-response');
export type Checked<T> = T | typeof MALFORMED;

/** Where a line came from: which surface, when, and the owner's exact words. */
export interface ProfileProvenanceView {
  readonly surface: string;
  readonly date: string;
  readonly said: string;
}

/** One prose line, preserved as written. */
export interface ProfileLineView {
  readonly lineIndex: number;
  readonly section: string;
  readonly text: string;
  readonly provenance?: ProfileProvenanceView;
}

/** One mechanical field. `valid: false` still carries the value — see §4.3. */
export interface ProfileFieldView {
  readonly fieldId: string;
  readonly label: string;
  readonly value: string;
  readonly valid: boolean;
  readonly invalidReason?: string;
  readonly provenance?: ProfileProvenanceView;
}

/** One `## ` section, with the tier its content belongs to. */
export interface ProfileSectionView {
  readonly heading: string;
  readonly tier: string;
  readonly fields: readonly ProfileFieldView[];
  readonly prose: readonly ProfileLineView[];
}

/** A mechanical value that did not validate, and why. Never fails the file. */
export interface ProfileInvalidFieldView {
  readonly fieldId: string;
  readonly reason: string;
}

/**
 * Load state — what `profile.status` answers.
 *
 * `kind` is `loaded` | `unavailable` | `disabled`. The counts belong to
 * `loaded` and `reason` to `unavailable`. There is no value property anywhere
 * in this shape, which is what makes the status output safe to show in a
 * diagnostic context (§11.3).
 */
export interface ProfileStateView {
  readonly kind: string;
  readonly path: string;
  readonly exists?: boolean;
  readonly lineCount?: number;
  readonly fieldCount?: number;
  readonly proseLineCount?: number;
  readonly sections?: readonly string[];
  readonly invalidFields?: readonly ProfileInvalidFieldView[];
  readonly reason?: string;
}

/** What `profile.read` answers: the whole document, by section. */
export interface ProfileDocumentView {
  readonly state: ProfileStateView;
  readonly sections: readonly ProfileSectionView[];
}

/** A retained `<!-- was: … -->` predecessor, so a wrong correction is recoverable. */
export interface ProfileSupersededView {
  readonly lineIndex: number;
  readonly fieldId: string;
  readonly section: string;
  readonly text: string;
  readonly value: string;
  readonly supersededOn: string;
  readonly previousLine: string;
  readonly provenance?: ProfileProvenanceView;
}

/** What `profile.provenance` answers for one field. */
export interface ProfileProvenanceReportView {
  readonly fieldId: string;
  readonly present: boolean;
  readonly handEdited: boolean;
  readonly provenance?: ProfileProvenanceView;
  readonly superseded: readonly ProfileSupersededView[];
}

/** One thing a write did. Names the field; never repeats the value. */
export interface ProfileChangeView {
  readonly kind: string;
  readonly fieldId?: string;
  readonly section: string;
  readonly label: string;
  readonly superseded: boolean;
}

/** What every write verb answers. `ok: false` always carries a reason. */
export interface ProfileWriteResultView {
  readonly ok: boolean;
  readonly reason?: string;
  readonly changes: readonly ProfileChangeView[];
  readonly disclosure: string;
}

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
