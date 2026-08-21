/**
 * profile-render.ts
 *
 * How `/profile` puts the owner profile on screen. Every function here is pure:
 * it takes a checked response (profile-types.ts) and returns a string. Nothing
 * in this file reads a file, opens a connection, or writes to a log, which is
 * what makes the containment rule in docs/owner-profile.md §10/§11.3 testable
 * rather than a claim: a profile value can only leave through the string these
 * functions return, and the only thing that consumes that string is `ctx.print`.
 *
 * Three shapes matter, one per question §8.3 says every surface must answer:
 *
 *   "what do you know about me?" → renderProfileDocument
 *   "where did you get that?"    → renderProfileProvenance
 *   "forget that"                → renderProfileWriteResult
 *
 * Two rules the renderers hold to:
 *
 *   - **A write never echoes the value.** `renderProfileWriteResult` prints the
 *     daemon's own one-line disclosure ("Noted, saved your office address to
 *     your profile.") and the field names that changed. The value the owner just
 *     set is deliberately absent: repeating it puts a closed-tier string into the
 *     transcript for no benefit (§8.2).
 *   - **A refusal is never dressed up as a success.** `ok: false` prints the
 *     daemon's reason verbatim, including "your profile has no shipping address
 *     recorded, so there was nothing to forget" (§9.2). There is no path here
 *     that turns an empty change list into a confirmation.
 */
import type {
  ProfileDocumentView,
  ProfileFieldView,
  ProfileLineView,
  ProfileProvenanceReportView,
  ProfileProvenanceView,
  ProfileSectionView,
  ProfileStateView,
  ProfileWriteResultView,
} from './profile-types.ts';

/** The prefix every line of this command's output carries. */
export const PROFILE_TAG = '[profile]';

/**
 * The load state as a sentence, or `null` when the profile is loaded and has
 * content to show. `unavailable` and `disabled` are stated conditions, never an
 * empty profile that would read as "I know nothing about you" (§4.4).
 */
export function describeProfileState(state: ProfileStateView): string | null {
  if (state.kind === 'disabled') {
    return `The owner profile is turned off (profile.enabled = false). Turn it on in /settings under "Owner Profile", then run /profile again.\n  file: ${state.path}`;
  }
  if (state.kind === 'unavailable') {
    return `Your profile could not be read: ${state.reason ?? 'no reason given'}\n  file: ${state.path}`;
  }
  if (state.exists === false) {
    return `Your profile is empty: nothing has been recorded yet.\n  file: ${state.path}`;
  }
  return null;
}

function padTo(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * One field row: the label as written in the file, the value, and the field id
 * so `/profile where <id>` and `/profile forget <id>` are copy-pasteable.
 *
 * An invalid value is shown verbatim with its reason rather than hidden, the
 * owner typed it, and a parser that disliked it is not grounds for pretending it
 * is not there (§4.3).
 */
function renderField(field: ProfileFieldView, labelWidth: number): string {
  const validity = field.valid ? '' : `  (not valid: ${field.invalidReason ?? 'no reason given'})`;
  return `  ${padTo(field.label, labelWidth)}  ${field.value}${validity}  [${field.fieldId}]`;
}

function renderProse(line: ProfileLineView): string {
  return `  ${line.text}`;
}

function renderSection(section: ProfileSectionView): string {
  const labelWidth = section.fields.reduce((width, field) => Math.max(width, field.label.length), 0);
  const lines = [section.heading];
  for (const field of section.fields) lines.push(renderField(field, labelWidth));
  for (const line of section.prose) lines.push(renderProse(line));
  return lines.join('\n');
}

/**
 * "What do you know about me?", the whole document, by section, in the order
 * the file has it. Sections the owner added himself render exactly like the
 * canonical ones, because his headings are as real as the built-in ones (§4.5).
 */
export function renderProfileDocument(document: ProfileDocumentView): string {
  const stateLine = describeProfileState(document.state);
  if (stateLine !== null) return `${PROFILE_TAG} ${stateLine}`;

  const populated = document.sections.filter(
    (section) => section.fields.length > 0 || section.prose.length > 0,
  );
  if (populated.length === 0) {
    return `${PROFILE_TAG} Your profile has no recorded content yet.\n  file: ${document.state.path}`;
  }

  const header = [
    `${PROFILE_TAG} What I know about you`,
    `  file: ${document.state.path}`,
  ];
  return [...header, '', ...populated.map(renderSection).flatMap((block) => [block, ''])]
    .join('\n')
    .trimEnd();
}

function renderProvenanceDetail(provenance: ProfileProvenanceView, indent: string): string[] {
  return [
    `${indent}recorded by ${provenance.surface} on ${provenance.date}`,
    `${indent}you said: "${provenance.said}"`,
  ];
}

/**
 * "Where did you get that?", the surface, the date and the owner's verbatim
 * words, plus every superseded predecessor still retained as a history comment.
 *
 * A field with no suffix reports that he wrote it by hand. That is the honest
 * answer and it is deliberately not softened into "source unknown", because a
 * hand-edited line has a known source: him (§4.2).
 */
export function renderProfileProvenance(report: ProfileProvenanceReportView): string {
  const lines = [`${PROFILE_TAG} Where ${report.fieldId} came from`];

  if (!report.present && report.superseded.length === 0) {
    return `${PROFILE_TAG} Your profile has no ${report.fieldId} recorded, so there is nothing to trace.`;
  }

  if (!report.present) {
    lines.push('  not currently recorded: only superseded history remains:');
  } else if (report.handEdited) {
    lines.push('  no provenance recorded: you wrote or edited this line by hand.');
  } else if (report.provenance) {
    lines.push(...renderProvenanceDetail(report.provenance, '  '));
  } else {
    lines.push('  no provenance recorded.');
  }

  if (report.superseded.length > 0) {
    lines.push('', `  superseded before this (${report.superseded.length}, oldest first):`);
    for (const previous of report.superseded) {
      lines.push(`    ${previous.value}   (replaced ${previous.supersededOn})`);
      if (previous.provenance) lines.push(...renderProvenanceDetail(previous.provenance, '      '));
      else lines.push('      no provenance recorded: hand-written.');
    }
  }
  return lines.join('\n');
}

/** Field names only. A receipt names what changed; it never repeats the value. */
function renderChangeNames(result: ProfileWriteResultView): string[] {
  return result.changes.map((change) => {
    const what = change.fieldId ?? `a note under ${change.section}`;
    const superseded = change.superseded ? ' (previous value kept as history)' : '';
    return `  ${change.kind}: ${what}${superseded}`;
  });
}

/**
 * What a write actually did.
 *
 * `ok: false` prints the daemon's reason and nothing else, no "done", no
 * change list, no disclosure. That covers the case §9.2 names explicitly:
 * forgetting something that was not there reports that it was not there.
 *
 * `ok: true` with an empty change list is also not a success line. The daemon
 * returns an empty disclosure when nothing changed, and inventing "Noted —"
 * over the top of it would be the false receipt the design forbids.
 */
export function renderProfileWriteResult(result: ProfileWriteResultView): string {
  if (!result.ok) {
    return `${PROFILE_TAG} ${result.reason ?? 'the write was refused, and the daemon gave no reason.'}`;
  }
  if (result.changes.length === 0) {
    return `${PROFILE_TAG} nothing changed${result.reason ? `: ${result.reason}` : '.'}`;
  }
  const disclosure = result.disclosure.trim();
  const lines = [disclosure.length > 0 ? `${PROFILE_TAG} ${disclosure}` : `${PROFILE_TAG} done.`];
  lines.push(...renderChangeNames(result));
  return lines.join('\n');
}

/**
 * The diagnostic view: load state, path, section names, counts, and every
 * mechanical value that did not validate WITH its reason.
 *
 * No values appear here, and none can: `ProfileStateView` has no property that
 * carries one. That is what makes this output safe to paste into a bug report
 * (§11.3), and profile-runtime.test.ts asserts it against a populated profile.
 */
export function renderProfileStatus(state: ProfileStateView): string {
  const lines = [`${PROFILE_TAG} Profile status: ${state.kind}`, `  file: ${state.path}`];
  if (state.kind === 'unavailable') {
    lines.push(`  reason: ${state.reason ?? 'no reason given'}`);
    return lines.join('\n');
  }
  if (state.kind === 'disabled') {
    lines.push('  reason: profile.enabled is false, so the file is never opened.');
    return lines.join('\n');
  }
  lines.push(`  file exists: ${state.exists === true ? 'yes' : 'no'}`);
  lines.push(`  lines: ${state.lineCount ?? 0} · fields: ${state.fieldCount ?? 0} · notes: ${state.proseLineCount ?? 0}`);
  const sections = state.sections ?? [];
  lines.push(`  sections (${sections.length}): ${sections.length > 0 ? sections.join(', ') : '(none)'}`);
  const invalid = state.invalidFields ?? [];
  if (invalid.length === 0) {
    lines.push('  fields that did not validate: none');
  } else {
    lines.push(`  fields that did not validate (${invalid.length}): the value is kept as you typed it:`);
    for (const entry of invalid) lines.push(`    ${entry.fieldId}: ${entry.reason}`);
  }
  return lines.join('\n');
}

/**
 * Every field id present in the document, paired with the label written on its
 * line. Used to resolve `/profile where shipping address` to
 * `commerce.shippingAddress` without keeping a copy of the SDK's field registry
 * here, the mapping comes from the live response, so it cannot drift.
 */
export function collectFieldLabels(document: ProfileDocumentView): ReadonlyMap<string, string[]> {
  const byLabel = new Map<string, string[]>();
  for (const section of document.sections) {
    for (const field of section.fields) {
      for (const key of [field.label, field.fieldId]) {
        const normalized = normalizeFieldToken(key);
        const existing = byLabel.get(normalized);
        if (existing) {
          if (!existing.includes(field.fieldId)) existing.push(field.fieldId);
        } else {
          byLabel.set(normalized, [field.fieldId]);
        }
      }
    }
  }
  return byLabel;
}

/** Field names match case-insensitively with whitespace collapsed (§4.3). */
export function normalizeFieldToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
