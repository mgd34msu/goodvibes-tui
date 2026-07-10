/**
 * workspace-trust.ts — per-workspace trust gate.
 *
 * The first time GoodVibes opens a workspace (a cwd / project root it has no
 * prior state for), that workspace is "restricted": only read-category tools
 * run; write, execute, and delegate tools are denied until the user marks the
 * workspace trusted. This is NOT a parallel permission checker — the decision
 * is consulted by the real permission machinery at its final ask layer (the
 * requestPermission callback wired in bootstrap-core.ts), so it composes with,
 * and cannot drift from, the existing PermissionManager layer chain.
 *
 * Trust is persisted per-workspace in <cwd>/.goodvibes/tui/trust.json. A
 * workspace that already carries GoodVibes runtime state (prior sessions,
 * checkpoints, state, memory, or a project onboarding marker) is grandfathered
 * as trusted on first load, so the gate only ever prompts for genuinely new
 * places.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JsonFileStore } from '@pellux/goodvibes-sdk/platform/state';
import type { PermissionCategory } from '@pellux/goodvibes-sdk/platform/permissions';
import type { PermissionPromptRequest, PermissionPromptDecision } from '@pellux/goodvibes-sdk/platform/permissions';

type AskCallback = (request: PermissionPromptRequest) => Promise<PermissionPromptDecision>;

/**
 * Wrap the permission machinery's final ask callback with the workspace trust
 * gate: in an untrusted workspace, deny any non-read tool outright instead of
 * asking. This runs inside PermissionManager's own layer chain (it IS the ask
 * layer), so it composes with — and cannot drift from — the real machinery.
 */
export function trustGatedAsk(manager: Pick<WorkspaceTrustManager, 'isCategoryAllowed'>, ask: AskCallback): AskCallback {
  return (request) =>
    manager.isCategoryAllowed(request.category) ? ask(request) : Promise.resolve({ approved: false });
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

export interface WorkspaceTrustManagerOptions {
  readonly shellPaths: WorkspaceTrustPaths;
  /** Whether the workspace already had prior GoodVibes runtime state at startup. */
  readonly hadPriorState: boolean;
}

export class WorkspaceTrustManager {
  private level: WorkspaceTrustLevel | null = null; // null = undecided (new place)
  private grandfathered = false;
  private loaded = false;
  private readonly store: JsonFileStore<PersistedWorkspaceTrust>;
  private readonly hadPriorState: boolean;

  constructor(options: WorkspaceTrustManagerOptions) {
    this.store = new JsonFileStore<PersistedWorkspaceTrust>(
      options.shellPaths.resolveProjectPath('tui', TRUST_FILE),
    );
    this.hadPriorState = options.hadPriorState;
  }

  /**
   * Load the persisted decision. If none exists, grandfather a workspace that
   * already had prior GoodVibes state (persisting the decision so it is never
   * re-evaluated); otherwise the workspace stays undecided and the gate treats
   * it as restricted until the user chooses.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    const persisted = await this.store.load().catch(() => null);
    if (persisted && (persisted.level === 'trusted' || persisted.level === 'restricted')) {
      this.level = persisted.level;
      this.grandfathered = persisted.grandfathered ?? false;
      this.loaded = true;
      return;
    }
    if (this.hadPriorState) {
      this.level = 'trusted';
      this.grandfathered = true;
      await this.persist();
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
