/**
 * hex-literal-rule.ts, architecture-gate rule.
 *
 * Bans raw `#RGB`, `#RRGGBB`, and `#RRGGBBAA` colour literals in
 * src/panels/**\/*.ts and src/renderer/**\/*.ts. UI_TONES
 * (src/renderer/ui-primitives.ts) and the
 * mode-resolved theme layer (src/renderer/theme.ts) are the single colour
 * token source; syntax-highlighter.ts owns its own colour table for syntax
 * themes. All three are exempt from the ban.
 *
 * The ~790 pre-existing literals audited across the panel/renderer layers
 * (2026-07-01 panel audit) cannot be migrated in one work order, so this is a
 * RATCHET: a seeded baseline (scripts/hex-literal-baseline.json) records the
 * current violating count per file. Future edits may not INCREASE a file's
 * count past its baseline entry; files absent from the baseline (new files,
 * or files already fully migrated) are held to zero. The baseline itself
 * only shrinks as later cleanup passes (the panel sweep) migrate
 * individual files to tokens, this rule does not block on that sweep.
 */

export const HEX_LITERAL_RE =
  /#[0-9a-fA-F]{8}(?![0-9a-fA-F])|#[0-9a-fA-F]{6}(?![0-9a-fA-F])|#[0-9a-fA-F]{3}(?![0-9a-fA-F])/g;

/** Files that own their own colour source and are exempt from the ban. */
export const HEX_LITERAL_BAN_EXEMPT: ReadonlySet<string> = new Set([
  'src/renderer/ui-primitives.ts',
  'src/renderer/theme.ts',
  'src/renderer/syntax-highlighter.ts',
]);

/** Count raw 3-, 6-, or 8-digit hex colour literals in a file's source text. */
export function countHexLiterals(text: string): number {
  const matches = text.match(HEX_LITERAL_RE);
  return matches ? matches.length : 0;
}

/** Whether a repo-relative path falls under the hex-literal ban's scope. */
export function isHexLiteralBanTarget(relPath: string): boolean {
  const normalized = relPath.split('\\').join('/');
  return (
    (normalized.startsWith('src/panels/') || normalized.startsWith('src/renderer/')) &&
    !HEX_LITERAL_BAN_EXEMPT.has(normalized)
  );
}

export interface HexLiteralCandidate {
  readonly relPath: string;
  readonly text: string;
}

/**
 * Enforce the hex-literal ratchet across a set of candidate files.
 * Returns one violation message per file whose current literal count
 * exceeds its baseline allowance (baseline default: 0).
 */
export function checkHexLiteralRatchet(
  files: readonly HexLiteralCandidate[],
  baseline: Readonly<Record<string, number>>,
): string[] {
  const violations: string[] = [];
  for (const { relPath, text } of files) {
    if (!isHexLiteralBanTarget(relPath)) continue;
    const count = countHexLiterals(text);
    const allowed = baseline[relPath] ?? 0;
    if (count > allowed) {
      violations.push(
        `${relPath}: raw hex color literal count increased (${count} > baseline ${allowed}); use UI_TONES/theme tokens instead [no-raw-hex-literal-growth]`,
      );
    }
  }
  return violations;
}
