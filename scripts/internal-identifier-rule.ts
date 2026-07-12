/**
 * internal-identifier-rule.ts — architecture-gate rule.
 *
 * Bans internal planning identifiers (wave ids, work-order ids, debt-register
 * ids, UX-workstream ids) from appearing anywhere in this repo's tracked text.
 * These are coordination shorthand for planning documents only — the owner's
 * doctrine, quoted verbatim in the failure message below, is that they must
 * never leak into code, comments, docs, or test names. A prior sweep found
 * and removed every instance of these patterns from this repo; this rule
 * exists so a new one can never land again without failing the build.
 *
 * Provenance belongs in decision-record paths (docs/decisions/*.md) or
 * version numbers (docs/releases/*.md) instead — so this rule exempts
 * docs/releases/**, which are dated, self-contained historical records.
 *
 * One further exemption: src/panels/modals/memory-modal.ts's
 * memoryModalGoldenSurface fixture data is deliberately-authored sample
 * memory-record text, pinned byte-for-byte against golden-frame snapshots in
 * src/test/renderer/golden-frames/. Editing its exact characters (even to
 * strip a wave/work-order-shaped substring) desyncs the fixture from its
 * recorded frame and breaks the golden test without fixing any real leak —
 * the text is synthetic, not a real internal identifier.
 */

const OWNER_DOCTRINE =
  'never put wave/work-order/register ids in outward-facing or in-code text; ' +
  'plain language only; provenance via decision-record paths or versions';

const INTERNAL_IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /\bW[0-9]{1,2}\.[0-9]{1,2}\b/g, // wave.item id: a capital W, 1-2 digits, a dot, 1-2 digits
  /\bwo[0-9]{3,4}\b/gi, // numeric work-order id: lowercase "wo" followed by 3-4 digits
  /\bWO-[A-Z]\b/g, // lettered work-order id: "WO-" followed by one capital letter
  /\bWO-[0-9]{2,4}\b/g, // numbered work-order id: "WO-" followed by 2-4 digits
  /\bDEBT-[0-9]+\b/g, // debt-register id: "DEBT-" followed by digits
  /\bUX-[A-Z]\b/g, // UX-workstream id: "UX-" followed by one capital letter
  /\bWave[- ][0-9]+\b/g, // wave word-form: "Wave" plus a hyphen or space plus digits
  /\bW[0-9]+-R[0-9]+\b/g, // wave-round id: a capital W, digits, a hyphen, capital R, digits
];

export interface InternalIdentifierCandidate {
  readonly relPath: string;
  readonly text: string;
}

const EXEMPT_FILES: readonly string[] = ['src/panels/modals/memory-modal.ts'];

function isExempt(relPath: string): boolean {
  const normalized = relPath.split('\\').join('/');
  return normalized.startsWith('docs/releases/') || EXEMPT_FILES.includes(normalized);
}

export function checkNoInternalIdentifiers(
  candidates: readonly InternalIdentifierCandidate[],
): string[] {
  const violations: string[] = [];
  for (const { relPath, text } of candidates) {
    if (isExempt(relPath)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const pattern of INTERNAL_IDENTIFIER_PATTERNS) {
        pattern.lastIndex = 0;
        const match = pattern.exec(line);
        if (match) {
          violations.push(
            `${relPath}:${i + 1}: internal planning identifier "${match[0]}" — ${OWNER_DOCTRINE} [internal-identifier]`,
          );
          break;
        }
      }
    }
  }
  return violations;
}
