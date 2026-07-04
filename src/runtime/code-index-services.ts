// ---------------------------------------------------------------------------
// code-index-services.ts — Wave 5 (wo804, W5.3 Stage A TUI wiring)
//
// Constructs the TUI's repo source-tree code index: CodeIndexStore
// (@pellux/goodvibes-sdk/platform/state, landed on SDK main as wo802/W5.3
// Stage A). Extracted into its own module rather than built inline in
// services.ts: services.ts sits at the architecture check's 800-line cap
// (scripts/check-architecture.ts), so any new service gets its own
// construction module and a single wiring call there (mirrors
// createWorkstreamServices's one-function-bundle shape).
//
// Schema-initialized eagerly (mirrors memoryStore: construction + init()
// happen unconditionally so the store is queryable — /codebase status, the
// fleet node — even before any build has ever run). The actual walk/chunk/
// embed build is NEVER auto-triggered by default: the hundreds of existing
// test fixtures (and every headless invocation) construct RuntimeServices
// without asking for a full source-tree walk, and init() alone never runs
// one (mirrors the SDK's own RuntimeServices wiring in
// platform/runtime/services.ts, which gates its equivalent scheduleBuild()
// call behind an explicit autoStartCodeIndex option).
//
// REALITY-WINS DIVERGENCE from the SDK's own shape: the SDK's
// RuntimeServicesOptions exposes autoStartCodeIndex as a constructor-time
// boolean because that call site is a library entrypoint threaded by each
// embedder. This TUI's createRuntimeServices has no such per-call knob —
// auto-start is decided from a TUI-local config key instead
// (CODE_INDEX_ENABLED_CONFIG_KEY, default OFF), so every construction path
// (interactive main.ts, the daemon, and every test fixture) shares one
// honest, user-visible on/off switch rather than needing to thread a new
// boolean through every call site. With it off (the default), `/codebase
// build` is the explicit, visible trigger — exactly the shape wo804's brief
// asks for.
//
// Shares memoryEmbeddingRegistry with MemoryStore (constructed in
// services.ts) so code + memory retrieval use one embedding provider and one
// dimensionality, per the SDK design doc (code-index-store.ts's constructor
// takes the SAME MemoryEmbeddingProviderRegistry instance memory uses).
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import { CodeIndexStore } from '@pellux/goodvibes-sdk/platform/state';
import type { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state';
import type { ConfigKey, ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { readBooleanConfig } from '../core/alert-gating.ts';

/**
 * TUI-local synthetic config key (not yet in the SDK's ConfigKey union) that
 * gates the code index's auto-build on construction. Default OFF — see this
 * module's header doc. Surfaced in /config via a synthetic entry
 * (settings-modal-data.ts) exactly like behavior.notifyAfterSeconds.
 */
export const CODE_INDEX_ENABLED_CONFIG_KEY = 'storage.codeIndexEnabled';

/**
 * Honest, generous bounds passed EXPLICITLY to CodeIndexStore (values equal
 * to its own internal defaults) so /codebase status and the settings
 * description can state them in one place without reaching into store
 * internals or duplicating magic numbers.
 */
export const CODE_INDEX_MAX_FILES = 5000;
export const CODE_INDEX_MAX_FILE_BYTES = 512 * 1024;

export interface CodeIndexServicesDeps {
  readonly workingDirectory: string;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
}

export interface CodeIndexServices {
  readonly codeIndexStore: CodeIndexStore;
}

/** Absolute path to the TUI's code-index sqlite file, sibling to memory.sqlite under .goodvibes/tui/. */
export function codeIndexDbPath(workingDirectory: string): string {
  return join(workingDirectory, '.goodvibes', 'tui', 'code-index.sqlite');
}

/**
 * Whether the code index's initial build should auto-start on construction.
 * Exported so /codebase status and the settings modal read the exact same
 * config key + default this module decides auto-start from.
 */
export function isCodeIndexAutoStartEnabled(configManager: Pick<ConfigManager, 'get'>): boolean {
  return readBooleanConfig(
    (key) => configManager.get(key as ConfigKey),
    CODE_INDEX_ENABLED_CONFIG_KEY,
    false,
  );
}

/**
 * Constructs the TUI's CodeIndexStore. Schema-init runs unconditionally
 * (init() never throws — it degrades to an honest `available: false` +
 * recorded error on failure, mirrored by CodeIndexStats/describeDegradation);
 * the initial full build only fires when isCodeIndexAutoStartEnabled() is
 * true, via the SAME fire-and-forget scheduleBuild() an explicit
 * `/codebase build` invocation uses.
 */
export function createCodeIndexServices(deps: CodeIndexServicesDeps): CodeIndexServices {
  const codeIndexStore = new CodeIndexStore(
    deps.workingDirectory,
    codeIndexDbPath(deps.workingDirectory),
    deps.memoryEmbeddingRegistry,
    { maxFiles: CODE_INDEX_MAX_FILES, maxFileBytes: CODE_INDEX_MAX_FILE_BYTES },
  );
  codeIndexStore.init();
  if (isCodeIndexAutoStartEnabled(deps.configManager)) {
    codeIndexStore.scheduleBuild();
  }
  return { codeIndexStore };
}
