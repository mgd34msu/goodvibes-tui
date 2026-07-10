/**
 * workspace-registration.ts — first-open workspace REGISTRATION half.
 *
 * Companion to the per-workspace trust gate (workspace-trust.ts). Trust is
 * TUI-local (a decision persisted under <cwd>/.goodvibes/tui); REGISTRATION is
 * the platform-wide "which project roots has the operator opted GoodVibes into"
 * registry, owned by the SDK.
 *
 * SINGLE SOURCE OF TRUTH. Resolution and mutation both go through the SDK's
 * shared WorkspaceRegistrationStore — the exact class the daemon composes its
 * `workspaces.*` gateway verbs over (control-plane/routes/register-gateway-verb-
 * groups.ts constructs `new WorkspaceRegistrationStore({ path: resolveUserPath(
 * 'control-plane', 'workspace-registrations.json'), homeDir: dirname(daemonState
 * Dir), daemonStateDir })`). We point an in-process store at that identical path
 * and roots, so whether the daemon's `workspaces.resolve` verb reads it over the
 * wire or we read it in-process, both operate on ONE persisted document. This is
 * not a divergent reimplementation: same SDK store class, same file, same
 * root-guard. In-process (rather than an RPC to a composed daemon) because the
 * first-open prompt renders synchronously at startup and must not depend on a
 * daemon being up — the file is the shared source either way.
 *
 * Coverage semantics are the store's (implemented in the SDK, not here): coverage
 * flows DOWN a registered root's subtree, a linked git worktree inherits its main
 * repo's registration, and a remembered decline is subtree-scoped at the root it
 * was asked. So the register half of the first-open prompt only appears when
 * resolution says UNKNOWN; a covered or declined path never re-asks.
 */
import { dirname } from 'node:path';
import { parse as parsePath } from 'node:path';
import {
  WorkspaceRegistrationStore,
  WorkspaceRegistrationError,
  normalizeWorkspaceRoot,
  type WorkspaceCoverageStatus,
  type RegisterWorkspaceResult,
} from '@pellux/goodvibes-sdk/platform/workspace';

/** The slice of ShellPathService this manager needs. */
export interface WorkspaceRegistrationShellPaths {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  resolveUserPath(...segments: string[]): string;
}

/** Filename of the shared control-plane registry document (matches the daemon composition). */
const REGISTRATIONS_FILE = 'workspace-registrations.json';

export interface WorkspaceRegistrationEvaluation {
  /** Normalized absolute working directory the prompt would ask about. */
  readonly root: string;
  /** Coverage verdict from the shared store: covered / declined / unknown. */
  readonly status: WorkspaceCoverageStatus;
  /** The nearest registered root covering the path, or null. */
  readonly coveredBy: string | null;
  /** True when coverage was inherited through the git worktree→main-repo link. */
  readonly viaWorktreeLink: boolean;
  /** True when the root is one the store would refuse ($HOME, filesystem root, ~/.goodvibes). */
  readonly broad: boolean;
  /**
   * Whether to OFFER the register half of the first-open prompt: only when the
   * store says UNKNOWN and the root is registrable. Broad roots are never
   * offered — the store refuses them, so we do not prompt for what would be
   * refused. Covered / declined roots never re-ask.
   */
  readonly offerRegister: boolean;
  /** Human-readable justification from the resolver. */
  readonly reason: string;
}

export interface WorkspaceRegistrationManagerOptions {
  readonly shellPaths: WorkspaceRegistrationShellPaths;
  /**
   * Inject a pre-built store (e.g. a `:memory:` store for tests). Defaults to an
   * in-process store at the shared control-plane path, configured identically to
   * the daemon's.
   */
  readonly store?: WorkspaceRegistrationStore;
}

export class WorkspaceRegistrationManager {
  private readonly store: WorkspaceRegistrationStore;
  private readonly workingDirectory: string;
  private readonly homeDir: string;
  private readonly daemonStateDir: string;

  constructor(options: WorkspaceRegistrationManagerOptions) {
    const { shellPaths } = options;
    this.workingDirectory = shellPaths.workingDirectory;
    // Mirror the daemon's composition exactly (register-gateway-verb-groups.ts):
    // the daemon state dir IS resolveUserPath() (~/.goodvibes); its parent is the
    // home directory — both refused as broad roots by the same guard.
    this.daemonStateDir = shellPaths.resolveUserPath();
    this.homeDir = dirname(this.daemonStateDir);
    this.store =
      options.store ??
      new WorkspaceRegistrationStore({
        path: shellPaths.resolveUserPath('control-plane', REGISTRATIONS_FILE),
        homeDir: this.homeDir,
        daemonStateDir: this.daemonStateDir,
      });
  }

  /**
   * isBroadRoot — mirrors the SDK store's broad-root refusal SET (filesystem
   * root, home directory, daemon state dir) so the register half is never
   * offered for a root the store would refuse. This is a UI-suppression predicate
   * only; the store's `add` remains the enforcement authority (see register()),
   * which is why register() also catches WorkspaceRegistrationError.
   */
  private isBroadRoot(normalizedRoot: string): boolean {
    if (normalizedRoot === parsePath(normalizedRoot).root) return true;
    if (normalizedRoot === normalizeWorkspaceRoot(this.homeDir)) return true;
    if (normalizedRoot === normalizeWorkspaceRoot(this.daemonStateDir)) return true;
    return false;
  }

  /**
   * Resolve the current working directory against the shared registry and decide
   * whether the register half of the first-open prompt should appear. Read-only —
   * never writes, so it is safe to call from `status`/`doctor`.
   */
  async evaluate(): Promise<WorkspaceRegistrationEvaluation> {
    const resolution = await this.store.resolve(this.workingDirectory);
    const broad = this.isBroadRoot(resolution.path);
    return {
      root: resolution.path,
      status: resolution.status,
      coveredBy: resolution.coveredBy,
      viaWorktreeLink: resolution.viaWorktreeLink,
      broad,
      offerRegister: resolution.status === 'unknown' && !broad,
      reason: resolution.reason,
    };
  }

  /**
   * Register the current working directory at its resolved project root. The
   * store refuses broad roots (WorkspaceRegistrationError) — we surface that
   * honestly rather than record a phantom registration.
   */
  async register(label?: string): Promise<
    | { readonly registered: true; readonly result: RegisterWorkspaceResult }
    | { readonly registered: false; readonly refusedReason: string }
  > {
    try {
      const result = await this.store.add(this.workingDirectory, label ? { label } : undefined);
      return { registered: true, result };
    } catch (error) {
      if (error instanceof WorkspaceRegistrationError) {
        return { registered: false, refusedReason: error.message };
      }
      throw error;
    }
  }

  /** Remember a subtree-scoped decline at the current working directory. Idempotent. */
  async decline(): Promise<{ readonly root: string; readonly alreadyDeclined: boolean }> {
    return this.store.decline(this.workingDirectory);
  }

  /** The normalized working directory this manager asks about. */
  getWorkingRoot(): string {
    return normalizeWorkspaceRoot(this.workingDirectory);
  }

  /**
   * A one-liner registration posture for `status`/`doctor`. Read-only.
   */
  async describe(): Promise<string> {
    const evaluation = await this.evaluate();
    switch (evaluation.status) {
      case 'covered':
        return evaluation.viaWorktreeLink
          ? `registered (via worktree link to ${evaluation.coveredBy})`
          : `registered (covered by ${evaluation.coveredBy})`;
      case 'declined':
        return 'not registered (registration declined for this directory)';
      case 'unknown':
        return evaluation.broad
          ? 'not registered (this root is too broad to register)'
          : 'not registered (never asked)';
    }
  }
}
