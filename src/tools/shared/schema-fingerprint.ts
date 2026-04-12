/**
 * Output schema fingerprint utility.
 *
 * Provides stable SHA-256 fingerprints derived from the sorted key set of a
 * tool result object. The same output mode / input class always produces the
 * same fingerprint because the hash is computed from the sorted key names, not
 * from the values — making it a schema-level identity rather than a content hash.
 *
 * Integration pattern:
 *   1. After a mode-specific result is produced, call `appendSchemaFingerprint`.
 *   2. The `_meta.outputSchemaFingerprint` field is appended to the result object.
 *   3. When the feature flag is disabled the result object is returned unchanged.
 */

import type { FeatureFlagManager } from '../../runtime/feature-flags/index.ts';

export interface SchemaFingerprintOptions {
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null;
}

/**
 * Checks the runtime feature flags explicitly supplied by the composition root.
 */
export function isSchemaFingerprintEnabled(options: SchemaFingerprintOptions = {}): boolean {
  return options.featureFlags?.isEnabled('output-schema-fingerprint') ?? false;
}

// ── Core fingerprinting ───────────────────────────────────────────────────────

/**
 * Canonical schema shape IDs per tool and output mode.
 *
 * The shape ID is the stable, human-readable identifier for what the schema
 * looks like before the hash is computed. It encodes the tool name and mode
 * so that diagnostics can group / filter by shape without needing to know the
 * full fingerprint.
 */
export const SCHEMA_SHAPE_IDS: Record<string, string> = {
  // find tool modes
  'find:files':      'find.files.v1',
  'find:content':    'find.content.v1',
  'find:symbols':    'find.symbols.v1',
  'find:references': 'find.references.v1',
  'find:structural': 'find.structural.v1',
  'find:multi':      'find.multi.v1',

  // analyze tool modes
  'analyze:impact':       'analyze.impact.v1',
  'analyze:dependencies': 'analyze.dependencies.v1',
  'analyze:dead_code':    'analyze.dead_code.v1',
  'analyze:security':     'analyze.security.v1',
  'analyze:coverage':     'analyze.coverage.v1',
  'analyze:bundle':       'analyze.bundle.v1',
  'analyze:preview':      'analyze.preview.v1',
  'analyze:diff':         'analyze.diff.v1',
  'analyze:surface':      'analyze.surface.v1',
  'analyze:breaking':     'analyze.breaking.v1',
  'analyze:semantic_diff':'analyze.semantic_diff.v1',
  'analyze:upgrade':      'analyze.upgrade.v1',
  'analyze:permissions':  'analyze.permissions.v1',
  'analyze:env_audit':    'analyze.env_audit.v1',
  'analyze:test_find':    'analyze.test_find.v1',

  // inspect tool modes
  'inspect:project':         'inspect.project.v1',
  'inspect:api':             'inspect.api.v1',
  'inspect:database':        'inspect.database.v1',
  'inspect:components':      'inspect.components.v1',
  'inspect:layout':          'inspect.layout.v1',
  'inspect:accessibility':   'inspect.accessibility.v1',
  'inspect:api_spec':        'inspect.api_spec.v1',
  'inspect:api_validate':    'inspect.api_validate.v1',
  'inspect:api_sync':        'inspect.api_sync.v1',
  'inspect:scaffold':        'inspect.scaffold.v1',
  'inspect:component_state': 'inspect.component_state.v1',
  'inspect:render_triggers': 'inspect.render_triggers.v1',
  'inspect:hooks':           'inspect.hooks.v1',
  'inspect:overflow':        'inspect.overflow.v1',
  'inspect:sizing':          'inspect.sizing.v1',
  'inspect:stacking':        'inspect.stacking.v1',
  'inspect:responsive':      'inspect.responsive.v1',
  'inspect:events':          'inspect.events.v1',
  'inspect:tailwind':        'inspect.tailwind.v1',
  'inspect:client_boundary': 'inspect.client_boundary.v1',
  'inspect:error_boundary':  'inspect.error_boundary.v1',
};

/**
 * Returns the canonical shape ID for a given tool and mode combination.
 * Falls back to `<tool>.<mode>.v1` for unknown combinations.
 */
export function getSchemaShapeId(tool: string, mode: string): string {
  const key = `${tool}:${mode}`;
  return SCHEMA_SHAPE_IDS[key] ?? `${tool}.${mode}.v1`;
}

/**
 * Compute a stable SHA-256 fingerprint from the sorted top-level key names of
 * a result object.
 *
 * The hash input is the JSON-serialised sorted key array, e.g.:
 *   `["count","files"]` → sha256 → hex string
 *
 * Because the hash is over keys only (not values), the same schema shape
 * always produces the same fingerprint regardless of runtime content.
 *
 * Uses the Web Crypto API (available in Bun via globalThis.crypto).
 */
export async function computeSchemaFingerprint(
  result: Record<string, unknown>,
): Promise<string> {
  const sortedKeys = Object.keys(result).sort();
  const canonical = JSON.stringify(sortedKeys);
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Synchronous variant using the synchronous `crypto.subtle.digestSync` API
 * available in Bun. Falls back to a deterministic key-sort string when the
 * sync API is not available (e.g. in Node.js test environments without
 * polyfilling).
 *
 * This is the preferred variant for tool `execute()` paths where async is
 * already available, but a sync escape hatch is provided for contexts where
 * adding `await` is impractical.
 */
export function computeSchemaFingerprintSync(
  result: Record<string, unknown>,
): string {
  const sortedKeys = Object.keys(result).sort();
  const canonical = JSON.stringify(sortedKeys);

  // Bun exposes crypto.subtle.digestSync (non-standard, Bun-only)
  const bunCrypto = crypto as typeof crypto & {
    subtle: typeof crypto.subtle & { digestSync?(algo: string, data: Uint8Array): ArrayBuffer };
  };

  if (typeof bunCrypto.subtle?.digestSync === 'function') {
    const encoder = new TextEncoder();
    const data = encoder.encode(canonical);
    const hashBuffer = bunCrypto.subtle.digestSync('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback: deterministic but non-cryptographic (test/non-Bun environments)
  // Produces a stable string for the same key set.
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── Result augmentation ───────────────────────────────────────────────────────

/**
 * Schema fingerprint metadata appended to tool results.
 */
export interface SchemaFingerprintMeta {
  /** Canonical shape ID (human-readable, e.g. `find.files.v1`). */
  schemaShapeId: string;
  /** SHA-256 hex (64 chars) in Bun; FNV-1a hex (8 chars) in non-Bun environments. */
  outputSchemaFingerprint: string;
}

/**
 * Append `_meta.outputSchemaFingerprint` to a result object when the feature
 * flag is enabled. Returns the original object unchanged when the flag is
 * disabled.
 *
 * @param result   The mode result object (plain, not yet JSON-stringified).
 * @param tool     Tool name: `'find'`, `'analyze'`, or `'inspect'`.
 * @param mode     The active output mode string (e.g. `'files'`, `'impact'`).
 * @returns        The augmented (or original) result object.
 */
export function appendSchemaFingerprint(
  result: Record<string, unknown>,
  tool: string,
  mode: string,
  options: SchemaFingerprintOptions = {},
): Record<string, unknown> {
  if (!isSchemaFingerprintEnabled(options)) {
    return result;
  }

  const shapeId = getSchemaShapeId(tool, mode);
  const fingerprint = computeSchemaFingerprintSync(result);

  const existingMeta =
    typeof result._meta === 'object' && result._meta !== null
      ? (result._meta as Record<string, unknown>)
      : undefined;

  return {
    ...result,
    _meta: {
      ...(existingMeta ?? {}),
      schemaShapeId: shapeId,
      outputSchemaFingerprint: fingerprint,
    } satisfies SchemaFingerprintMeta,
  };
}
