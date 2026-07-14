/**
 * internal-identifier-rule.ts — architecture-gate rule.
 *
 * Bans internal planning identifiers (wave ids, work-order ids, debt-register
 * ids, UX-workstream ids, and lettered finding/brief ids) from appearing
 * anywhere in this repo's tracked text. These are coordination shorthand for
 * planning documents only — the owner's doctrine, quoted verbatim in the
 * failure message below, is that they must never leak into code, comments,
 * docs, or test names. A prior sweep found and removed every instance of
 * these patterns from this repo; this rule exists so a new one can never
 * land again without failing the build.
 *
 * Provenance belongs in decision-record paths (docs/decisions/*.md) or
 * version numbers (docs/releases/*.md) instead — so this rule exempts
 * docs/releases/**, which are dated, self-contained historical records.
 *
 * Lettered finding/brief ids (a follow-up sweep, second occurrence of this
 * class): a single capital letter in the A-through-E range immediately
 * followed by one or two digits recurs throughout this codebase's comments
 * and test titles as informal review-finding or planning-brief shorthand —
 * the same coordination-shorthand problem as the wave/work-order ids above,
 * one letter-range narrower. F is deliberately excluded from that range: an
 * F-plus-digits token is a terminal function key, a genuine technical
 * vocabulary this repo uses constantly. Only three SHAPES of this letter-
 * plus-digits token are banned, chosen to be safely unambiguous:
 *   1. the token alone, with nothing else, inside a parenthesized aside;
 *   2. a test/describe/it title whose string literal STARTS with the token
 *      immediately followed by a colon or an em-dash;
 *   3. two or more of the tokens chained by forward slashes.
 * Deliberately NOT banned: the bare token with no surrounding delimiter
 * anywhere in running text — that shape has too many genuine technical uses
 * in this repo (the ASCII control-character-set names, quoted-printable/MIME
 * transfer-encoding examples, Slack channel ids — which really do start with
 * a bare letter followed by digits in Slack's own API shape — IMAP command
 * tags, and plain short test-fixture names) to ban without an unacceptable
 * false-positive rate.
 */

const OWNER_DOCTRINE =
  'never put wave/work-order/register ids in outward-facing or in-code text; ' +
  'plain language only; provenance via decision-record paths or versions';

const INTERNAL_IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /\bW[0-9]{1,2}\.[0-9]{1,2}\b/g, // wave.item id: a capital W, 1-2 digits, a dot, 1-2 digits
  /\bwo[0-9]{3,4}\b/gi, // numeric work-order id: lowercase "wo" followed by 3-4 digits
  /\bWO-[A-Z]\b/g, // lettered work-order id: "WO-" followed by one capital letter
  /\bWO-[0-9]{1,4}[A-Za-z]*\b/g, // numbered work-order id: "WO-" then 1-4 digits, with an optional letter suffix — catches digit-then-letter shapes whose trailing letter otherwise defeats a digits-only \b anchor
  /\bDEBT-[0-9]+\b/g, // debt-register id: "DEBT-" followed by digits
  /\bUX-[A-Z]\b/g, // UX-workstream id: "UX-" followed by one capital letter
  /\bWave[- ][0-9]+\b/g, // wave word-form: "Wave" plus a hyphen or space plus digits
  /\bW[0-9]+-R[0-9]+\b/g, // wave-round id: a capital W, digits, a hyphen, capital R, digits
  // Contextual plan-item label: the word "item" (optionally "plan item")
  // followed by a dotted numeric label ("item N.N.N", "plan item N.N").
  // Word-anchored on purpose: a BARE dotted number is indistinguishable from a
  // release version ("(1.2.0)", isCompatible with two semver args), and
  // versions are the doctrine's sanctioned provenance — so only the worded
  // shape is banned.
  /\b(?:plan\s+)?item\s+[0-9]+\.[0-9]+(?:\.[0-9]+)?\b/gi,
  /\([A-E][0-9]{1,2}\)/g, // a lettered finding id (A-E, one or two digits) alone inside parentheses — F excluded (function keys)
  /\b(?:describe|test|it)\(\s*['"][A-E][0-9]{1,2}\s*(?::|—)/g, // a test/describe/it title starting with a lettered finding id, immediately followed by a colon or an em-dash
  /\b[A-E][0-9]{1,2}(?:\/[A-E][0-9]{1,2}){1,}\b/g, // two or more lettered finding ids chained by forward slashes
];

export interface InternalIdentifierCandidate {
  readonly relPath: string;
  readonly text: string;
}

function isExempt(relPath: string): boolean {
  const normalized = relPath.split('\\').join('/');
  return normalized.startsWith('docs/releases/');
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
