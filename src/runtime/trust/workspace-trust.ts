/**
 * workspace-trust.ts — per-workspace trust gate.
 *
 * The first time GoodVibes opens a workspace (a cwd / project root it has no
 * prior decision for), that workspace is "undecided": only read-category
 * tools run; the first write, execute, or delegate tool request raises the
 * trust question AT THAT MOMENT — the exact point it has a real consequence —
 * instead of silently failing or being decided by a side effect of the
 * product's own droppings. This is NOT a parallel permission checker — the
 * decision is consulted by the real permission machinery at its final ask
 * layer (the requestPermission callback wired in bootstrap-core.ts), so it
 * composes with, and cannot drift from, the existing PermissionManager layer
 * chain.
 *
 * Trust is persisted per-workspace in <cwd>/.goodvibes/tui/trust.json. There
 * is no more grandfathering: a workspace that already carries prior GoodVibes
 * runtime state gets no special treatment (that side-effect-based shortcut
 * used to paper over the fact that the first session's write attempts were
 * silently denied without ever recording a real decision — now that the first
 * attempt properly raises the question and persists the answer, the shortcut
 * is unnecessary and would only hide a decision the user should actually see
 * once, even on an upgrade).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JsonFileStore } from '@pellux/goodvibes-sdk/platform/state';
import type { PermissionCategory } from '@pellux/goodvibes-sdk/platform/permissions';
import type { PermissionPromptRequest, PermissionPromptDecision } from '@pellux/goodvibes-sdk/platform/permissions';

type AskCallback = (request: PermissionPromptRequest) => Promise<PermissionPromptDecision>;

/**
 * Wrap the permission machinery's final ask callback with the workspace trust
 * gate. This runs inside PermissionManager's own layer chain (it IS the ask
 * layer), so it composes with — and cannot drift from — the real machinery.
 *
 * - Trusted workspace: every category passes through to `ask` unchanged.
 * - Restricted workspace with an EXPLICIT prior decision: non-read categories
 *   are denied outright, same as before — that IS what "restricted" means
 *   once the user has actually chosen it.
 * - Undecided workspace (no decision yet, ever): the first non-read request
 *   raises `requestTrustDecision()` — one modal, persisted via `setLevel` —
 *   and, if the answer is 'trusted', the ORIGINAL request is forwarded to
 *   `ask` so the very thing the user just approved actually happens instead
 *   of failing anyway. Concurrent requests that arrive before the first
 *   decision resolves await the same in-flight prompt rather than opening a
 *   second one.
 */
export function trustGatedAsk(
  manager: Pick<WorkspaceTrustManager, 'isCategoryAllowed' | 'isDecided' | 'setLevel'>,
  ask: AskCallback,
  requestTrustDecision: () => Promise<WorkspaceTrustLevel>,
): AskCallback {
  let pendingDecision: Promise<WorkspaceTrustLevel> | null = null;
  return async (request) => {
    if (manager.isCategoryAllowed(request.category)) return ask(request);
    if (!manager.isDecided()) {
      if (!pendingDecision) {
        pendingDecision = requestTrustDecision().finally(() => {
          pendingDecision = null;
        });
      }
      const level = await pendingDecision;
      await manager.setLevel(level);
      if (manager.isCategoryAllowed(request.category)) return ask(request);
    }
    return { approved: false };
  };
}

export type WorkspaceTrustLevel = 'trusted' | 'restricted';

interface PersistedWorkspaceTrust {
  level: WorkspaceTrustLevel;
  decidedAt: string;
  grandfathered?: boolean;
}

const TRUST_FILE = 'trust.json';

/**
 * detectPriorWorkspaceState — true if <workingDirectory>/.goodvibes already
 * holds GoodVibes RUNTIME state from a prior session. Deliberately keyed on
 * generated state (sessions/checkpoints/state/memory/onboarding marker), not on
 * committed scaffolding like .goodvibes/agents or GOODVIBES.md, so a checked-out
 * template does not read as "previously used". MUST be sampled before any
 * service initializes the workspace this session (bootstrap-core samples it
 * before createRuntimeServices), or this-run scaffolding would look like prior
 * use.
 */
export function detectPriorWorkspaceState(workingDirectory: string): boolean {
  const root = join(workingDirectory, '.goodvibes');
  if (!existsSync(root)) return false;

  const fileSignals = [
    join(root, 'checkpoints', 'index.json'),
    join(root, 'tui', 'onboarding-checked.json'),
    join(root, 'goodvibes.json'),
  ];
  for (const file of fileSignals) {
    if (existsSync(file)) return true;
  }

  const dirSignals = ['sessions', 'checkpoints', 'state', 'memory'];
  for (const dir of dirSignals) {
    const path = join(root, dir);
    try {
      if (existsSync(path) && statSync(path).isDirectory() && readdirSync(path).length > 0) {
        return true;
      }
    } catch {
      // Unreadable — treat as absent rather than crash the gate.
    }
  }
  return false;
}

export interface WorkspaceTrustPaths {
  readonly projectGoodVibesRoot: string;
  resolveProjectPath(...segments: string[]): string;
}

/** Read-only view of the persisted trust decision, for status/doctor reporting. */
export interface PersistedWorkspaceTrustView {
  /** 'trusted' | 'restricted' when a decision exists; 'undecided' when none is persisted yet. */
  readonly level: WorkspaceTrustLevel | 'undecided';
  readonly grandfathered: boolean;
}

/**
 * readPersistedWorkspaceTrust — read <cwd>/.goodvibes/tui/trust.json WITHOUT the
 * side effects of WorkspaceTrustManager.load() (which grandfathers and persists).
 * Reporting surfaces (`status`/`doctor`) must never mutate trust state, so they
 * use this pure reader instead of constructing a manager.
 */
export function readPersistedWorkspaceTrust(paths: WorkspaceTrustPaths): PersistedWorkspaceTrustView {
  const file = paths.resolveProjectPath('tui', TRUST_FILE);
  try {
    if (!existsSync(file)) return { level: 'undecided', grandfathered: false };
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<PersistedWorkspaceTrust>;
    if (parsed.level === 'trusted' || parsed.level === 'restricted') {
      return { level: parsed.level, grandfathered: parsed.grandfathered ?? false };
    }
  } catch {
    // Unreadable/corrupt — report undecided rather than crash the report.
  }
  return { level: 'undecided', grandfathered: false };
}

export interface WorkspaceTrustManagerOptions {
  readonly shellPaths: WorkspaceTrustPaths;
}

export class WorkspaceTrustManager {
  private level: WorkspaceTrustLevel | null = null; // null = undecided (new place)
  private grandfathered = false;
  private loaded = false;
  private readonly store: JsonFileStore<PersistedWorkspaceTrust>;

  constructor(options: WorkspaceTrustManagerOptions) {
    this.store = new JsonFileStore<PersistedWorkspaceTrust>(
      options.shellPaths.resolveProjectPath('tui', TRUST_FILE),
    );
  }

  /**
   * Load the persisted decision, if one exists. No grandfathering: a
   * workspace with no persisted decision stays undecided (the gate treats it
   * as restricted, and the first non-read tool request raises the trust
   * question via `trustGatedAsk`'s `requestTrustDecision` callback) — even
   * one that already carries prior GoodVibes runtime state. `grandfathered`
   * on an already-persisted decision is read-only history from before this
   * fix (status/doctor still report it honestly); nothing new is ever
   * grandfathered.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    const persisted = await this.store.load().catch(() => null);
    if (persisted && (persisted.level === 'trusted' || persisted.level === 'restricted')) {
      this.level = persisted.level;
      this.grandfathered = persisted.grandfathered ?? false;
    }
    this.loaded = true;
  }

  isDecided(): boolean {
    return this.level !== null;
  }

  /** Undecided workspaces read as 'restricted' — the safe default before a choice. */
  getLevel(): WorkspaceTrustLevel {
    return this.level ?? 'restricted';
  }

  isTrusted(): boolean {
    return this.level === 'trusted';
  }

  wasGrandfathered(): boolean {
    return this.grandfathered;
  }

  async setLevel(level: WorkspaceTrustLevel): Promise<void> {
    this.level = level;
    this.grandfathered = false;
    this.loaded = true;
    await this.persist();
  }

  /**
   * The restriction rule the permission machinery consults. Read tools always
   * run (read-only exploration is the whole point of "restricted"); every other
   * category (write / execute / delegate) is denied until the workspace is
   * trusted.
   */
  isCategoryAllowed(category: PermissionCategory): boolean {
    if (this.isTrusted()) return true;
    return category === 'read';
  }

  private async persist(): Promise<void> {
    if (this.level === null) return;
    await this.store.save({
      level: this.level,
      decidedAt: new Date().toISOString(),
      grandfathered: this.grandfathered,
    });
  }
}
