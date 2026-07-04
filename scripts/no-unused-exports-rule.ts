/**
 * no-unused-exports-rule.ts — WO-206 architecture-gate rule.
 *
 * Bans exported symbols in src/renderer/**\/*.ts that have no non-test
 * import site anywhere in the codebase. This is the guard that would have
 * caught diff-view.ts rotting unwired for 19 versions (WO-204 wired it back
 * up): an export with zero real callers is either dead code that should be
 * deleted, or code that was written but never plugged in.
 *
 * Scope: every top-level export in src/renderer/**\/*.ts — const/let/function/
 * class/interface/type/enum declarations, and local `export { a, b as c }`
 * lists and re-export forwarding (`export { a } from './x'`).
 *
 * VALUE exports (const/let/function/class, and named exports/re-exports of
 * those) "count as used" only when some non-test file (anywhere in the repo,
 * including scripts/) imports that exact name from a specifier resolving to
 * the defining file — JS requires a real import to reach a value, so nothing
 * short of that proves it's reachable. This is the check that would have
 * caught diff-view.ts sitting unwired for 19 versions.
 *
 * TYPE exports (interface/type alias/enum) additionally count as used when
 * the name is referenced anywhere else in their OWN declaring file (as a
 * parameter/return/field type, typically at the exported function they
 * describe). This isn't a loophole: TypeScript's structural typing means a
 * caller of an already-wired `renderThing(opts: ThingOptions)` never needs to
 * name-import `ThingOptions` to pass a matching literal, so requiring a
 * cross-file import site for every companion parameter-shape interface would
 * flag hundreds of legitimate types and swamp the real signal. A type that
 * appears only once in its own file — its own declaration, referenced
 * nowhere, in that file or any other — is still flagged: that's the
 * `UiGlyphRegistry`-shaped case of a genuinely orphaned type.
 *
 * Two further carve-outs from needing a proven usage site:
 *   1. Type-only re-exports — `export type { X } from './y'` or
 *      `export { type X } from './y'` — that forward a type through a
 *      canonical module without themselves being the type's declaration site.
 *      These commonly exist to consolidate a public type surface at one
 *      import path for future/external consumers; requiring proof of a
 *      current importer would create churn disproportionate to the risk (a
 *      forwarded type costs nothing at runtime and the *original*
 *      declaration is still subject to this same rule wherever it lives).
 *   2. NO_UNUSED_EXPORTS_EXEMPT — a minimal, individually justified list of
 *      `relPath#exportName` entries for exports that are genuinely part of a
 *      public surface this static pass cannot see a caller for. Prefer
 *      wiring the export into a real call site or deleting it outright;
 *      treat this list as a last resort, same discipline as the
 *      selected-index and hex-literal rules' exempt lists.
 *
 * `export * from './x'` (whole-module re-export) is out of scope: no
 * src/renderer file used this form as of rule authoring, and it can't be
 * resolved to individual names without deeper resolution. If one is ever
 * added, this rule silently stops covering the names it forwards — extend
 * `extractExportedSymbols`/`extractImportedBindings` rather than relying on
 * that gap.
 */

import ts from 'typescript';

export interface ExportedSymbol {
  readonly name: string;
  readonly line: number;
  readonly kind: 'value' | 'type';
  /** True for `export type { X } from './y'` / `export { type X } from './y'` forwarding. */
  readonly isTypeOnlyReexport: boolean;
}

export interface ImportedBinding {
  readonly specifier: string;
  readonly name: string;
}

export interface UnusedExportsCandidate {
  readonly relPath: string;
  readonly text: string;
}

export interface ImporterFile {
  readonly relPath: string;
  readonly text: string;
  readonly isTest: boolean;
}

/**
 * Fully-qualified `relPath#exportName` exemptions. Keep this list minimal —
 * prefer wiring the export into a real call site or deleting it, same
 * discipline as SELECTED_INDEX_EXEMPT / the hex-literal baseline. Each entry
 * must carry a justifying comment.
 */
export const NO_UNUSED_EXPORTS_EXEMPT: ReadonlySet<string> = new Set([
  // ── Internal-only, but with dedicated tests pinning exact behavior that a
  // rewrite through the public wrapper would only make less direct. Each is
  // genuinely wired in production (through the sibling named in the comment)
  // — this rule just can't see the indirection — and each's own test
  // exercises algorithmic edge cases (color-math rounding, threshold
  // boundaries, tokenizer branches) the wrapper's tests don't isolate.
  'src/renderer/overlay-viewport.ts#getOverlayWidthClass', // wired via getOverlaySurfaceMetrics; width-band boundaries also pinned by a release-gate test
  'src/renderer/panel-composite.ts#renderPanel', // wired via buildPanelCompositeData; dedicated cache/dirty-flag test suite
  'src/renderer/theme.ts#resolveTheme', // WO-001: documented future call site — markdown.ts's own comment says "replace with resolveTheme(mode) when mode detection lands"
  'src/renderer/system-message.ts#classifySystemMessage', // wired via renderSystemMessage's default typeOverride; ~30 branch-classification cases tested directly
  'src/renderer/markdown.ts#renderInlineMarkdown', // wired via renderMarkdown/renderMarkdownTracked (called internally); tokenizer branch tests exercise it directly
  'src/renderer/agent-detail-modal.ts#formatStalledLabel', // WO-203 hardening: minute count derived from MODAL_STALL_THRESHOLD_MS; wired internally, threshold-derivation pinned by dedicated tests
  'src/renderer/term-caps.ts#nearestAnsi256', // wired via downsampleColor; exact 256-index color-math (cube vs grayscale) pinned by dedicated tests
  'src/renderer/term-caps.ts#nearestAnsi16Fg', // wired via downsampleColor; exact 16-color nearest-match pinned by dedicated tests
  'src/renderer/turn-injection.ts#formatTurnInjectionEntry', // W5.2 (wo803): wired via buildTurnInjectionsText (called internally); per-entry edge cases (empty/relevance-floor/budget-exceeded/fallback-lexical) pinned by dedicated tests
  'src/renderer/compaction-history-modal.ts#formatCompactionEvent', // W5.4/B28 (wo803): wired via buildCompactionHistoryText (called internally); quality-score grade-suffix present/absent/null branches pinned by dedicated tests, independent of the SDK's own module-level compaction-event singleton
  'src/renderer/term-caps.ts#SYNC_BEGIN', // wired via wrapSynced; exact DEC 2026 escape sequence pinned by dedicated tests
  'src/renderer/term-caps.ts#SYNC_END', // wired via wrapSynced; exact DEC 2026 escape sequence pinned by dedicated tests
  // DEBT-2 terminal-bg-probe: the OSC 11 parser/classifier/filter are wired
  // internally via installBackgroundThemeProbe (called from main.ts) and the
  // TerminalBackgroundProbe class, but the fake-terminal harness pins their exact
  // behaviour (BEL vs ST terminators, split/interleaved chunks, rgb/# variants,
  // luminance boundary, tmux wrapping) by calling them directly.
  'src/renderer/terminal-bg-probe.ts#OSC11_QUERY',
  'src/renderer/terminal-bg-probe.ts#DEFAULT_PROBE_TIMEOUT_MS',
  'src/renderer/terminal-bg-probe.ts#LUMINANCE_LIGHT_THRESHOLD',
  'src/renderer/terminal-bg-probe.ts#parseColorSpec',
  'src/renderer/terminal-bg-probe.ts#classifyBackgroundLuminance',
  'src/renderer/terminal-bg-probe.ts#TerminalBackgroundProbe',
  'src/renderer/terminal-bg-probe.ts#wrapForTmuxPassthrough',
  // DEBT-2: DARK_THEME is the frozen dark-token singleton (=== resolveTheme('dark')).
  // Call sites moved to activeTheme(); it stays as the public convenience alias and
  // is pinned by theme.test.ts's identity assertions.
  'src/renderer/theme.ts#DARK_THEME',

]);

/** Whether a repo-relative path falls under the no-unused-exports rule's scope. */
export function isNoUnusedExportsRuleTarget(relPath: string): boolean {
  const normalized = relPath.split('\\').join('/');
  return (
    normalized.startsWith('src/renderer/') &&
    normalized.endsWith('.ts') &&
    !normalized.endsWith('.test.ts') &&
    !normalized.includes('/test/')
  );
}

function parse(text: string, relPath: string): ts.SourceFile {
  return ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

/** Extract every top-level exported name from a renderer source file's text. */
export function extractExportedSymbols(text: string, relPath = 'file.ts'): ExportedSymbol[] {
  const source = parse(text, relPath);
  const symbols: ExportedSymbol[] = [];

  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  for (const stmt of source.statements) {
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      const line = lineOf(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          symbols.push({ name: decl.name.text, line, kind: 'value', isTypeOnlyReexport: false });
        }
      }
    } else if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
      hasExportModifier(stmt) &&
      stmt.name
    ) {
      symbols.push({ name: stmt.name.text, line: lineOf(stmt), kind: 'value', isTypeOnlyReexport: false });
    } else if (
      (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) &&
      hasExportModifier(stmt)
    ) {
      symbols.push({ name: stmt.name.text, line: lineOf(stmt), kind: 'type', isTypeOnlyReexport: false });
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      const line = lineOf(stmt);
      const isForwarding = stmt.moduleSpecifier !== undefined;
      for (const el of stmt.exportClause.elements) {
        const isTypeOnlyReexport = isForwarding && (stmt.isTypeOnly || el.isTypeOnly);
        const kind: 'value' | 'type' = stmt.isTypeOnly || el.isTypeOnly ? 'type' : 'value';
        symbols.push({ name: el.name.text, line, kind, isTypeOnlyReexport });
      }
    }
  }

  return symbols;
}

/** Unwrap a single leading `await` so `await import('./x')` reaches the call underneath. */
function unwrapAwait(expr: ts.Expression): ts.Expression {
  return ts.isAwaitExpression(expr) ? expr.expression : expr;
}

/** Whether an expression is a dynamic `import('...')` call (after unwrapping `await`). */
function asDynamicImportCall(expr: ts.Expression): ts.CallExpression | null {
  const unwrapped = unwrapAwait(expr);
  return ts.isCallExpression(unwrapped) && unwrapped.expression.kind === ts.SyntaxKind.ImportKeyword
    ? unwrapped
    : null;
}

/**
 * Extract every relative-import/re-export binding a file's source text pulls
 * in — static `import {...} from './x'`, `export {...} from './x'`
 * forwarding, and destructured dynamic imports (`const { a, b } = await
 * import('./x')`, anywhere in the file, not just top level — this codebase
 * lazy-loads a few heavy renderer modules that way).
 */
export function extractImportedBindings(text: string, relPath = 'file.ts'): ImportedBinding[] {
  const source = parse(text, relPath);
  const bindings: ImportedBinding[] = [];

  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const specifier = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      const namedBindings = clause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const el of namedBindings.elements) {
          bindings.push({ specifier, name: (el.propertyName ?? el.name).text });
        }
      }
      // Default and namespace imports of src/renderer files are intentionally
      // not tracked: no src/renderer file exports a default, and no importer
      // takes a namespace import of one (verified at rule authoring time). A
      // future one would silently escape this rule's usage tracking — extend
      // this function rather than relying on that gap.
    } else if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      const specifier = stmt.moduleSpecifier.text;
      for (const el of stmt.exportClause.elements) {
        bindings.push({ specifier, name: (el.propertyName ?? el.name).text });
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
      const call = asDynamicImportCall(node.initializer);
      const arg = call?.arguments[0];
      if (call && arg && ts.isStringLiteral(arg)) {
        const specifier = arg.text;
        for (const el of node.name.elements) {
          if (el.dotDotDotToken || !ts.isIdentifier(el.name)) continue;
          const propName = el.propertyName;
          if (propName && !ts.isIdentifier(propName) && !ts.isStringLiteral(propName)) continue;
          const name = propName && (ts.isIdentifier(propName) || ts.isStringLiteral(propName)) ? propName.text : el.name.text;
          bindings.push({ specifier, name });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return bindings;
}

/**
 * Enforce the no-unused-exports rule.
 *
 * `resolveSpecifier` resolves a relative import specifier written in
 * `fromRelPath` to the repo-relative path of the file it targets (or null if
 * unresolvable) — the caller supplies filesystem resolution so this module
 * stays pure and unit-testable without touching disk.
 */
export function checkNoUnusedExports(
  targets: readonly UnusedExportsCandidate[],
  importers: readonly ImporterFile[],
  resolveSpecifier: (fromRelPath: string, specifier: string) => string | null,
): string[] {
  const violations: string[] = [];

  // usedNonTest.get(relPath) = set of exported names imported by at least
  // one non-test file, keyed by the defining file's repo-relative path.
  const usedNonTest = new Map<string, Set<string>>();
  for (const importer of importers) {
    if (importer.isTest) continue;
    for (const { specifier, name } of extractImportedBindings(importer.text, importer.relPath)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveSpecifier(importer.relPath, specifier);
      if (!resolved) continue;
      if (!usedNonTest.has(resolved)) usedNonTest.set(resolved, new Set());
      usedNonTest.get(resolved)!.add(name);
    }
  }

  for (const { relPath, text } of targets) {
    if (!isNoUnusedExportsRuleTarget(relPath)) continue;
    const used = usedNonTest.get(relPath) ?? new Set<string>();
    for (const { name, line, kind, isTypeOnlyReexport } of extractExportedSymbols(text, relPath)) {
      if (isTypeOnlyReexport) continue;
      if (NO_UNUSED_EXPORTS_EXEMPT.has(`${relPath}#${name}`)) continue;
      if (used.has(name)) continue;
      if (kind === 'type' && hasSelfFileTypeUse(text, name)) continue;
      violations.push(
        `${relPath}:${line}: export '${name}' has no non-test import site; wire it into a real caller or ` +
          `delete it (or add a justified entry to NO_UNUSED_EXPORTS_EXEMPT) [no-unused-export]`,
      );
    }
  }

  return violations;
}

/**
 * Whether a type name is referenced anywhere in its own declaring file
 * besides its declaration — a plain word-boundary occurrence count, matching
 * the text-scanning style of the hex-literal/selected-index rules rather
 * than a full type-checker walk. `>= 2` means "appears at its declaration
 * plus at least once more" (typically the exported function it describes).
 */
function hasSelfFileTypeUse(text: string, name: string): boolean {
  const re = new RegExp(`\\b${name}\\b`, 'g');
  const matches = text.match(re);
  return (matches?.length ?? 0) >= 2;
}
