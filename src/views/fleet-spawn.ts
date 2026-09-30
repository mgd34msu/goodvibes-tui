// ---------------------------------------------------------------------------
// fleet-spawn.ts
//
// The Agents modal's ACP spawn affordance: 'n' lists the
// third-party coding agents the daemon discovered (acp.agents.list, read-only,
// quiet when none), you pick one, then pick a working directory from the known
// candidates (the registered workspaces + the current dir, no free-text path
// retyping where a known dir exists), and acp.sessions.create hosts it as a
// long-lived daemon session. The new row shows up on the next fleet snapshot as
// kind 'acp-agent' and steers/stops/flags-for-attention like any other row.
//
// A structured spawn failure ({binary, stage, message}) is surfaced verbatim,
// never a hung row: the daemon bounds the handshake and returns a 'failed'
// record, and this controller reports its three honest fields.
//
// The controller owns the Agents modal's input while a pick is in flight
// (mirrors FleetActs' pick mode); the modal draws spawnView(). The gateway is
// injectable so the flow round-trips
// against a mocked daemon in tests; the live builder is createAcpSpawnGateway.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { resolveOperatorRpc } from '../input/commands/operator-rpc.ts';

/** One discovered third-party ACP agent (acp.agents.list). */
export type AcpDiscoveredAgent = OperatorMethodOutput<'acp.agents.list'>['agents'][number];
/** acp.sessions.create output, the hosted record + whether it started. */
export type AcpSpawnResult = OperatorMethodOutput<'acp.sessions.create'>;
/** One registered workspace root (workspaces.registrations.list). */
export type AcpWorkspaceRegistration = OperatorMethodOutput<'workspaces.registrations.list'>['workspaces'][number];

/** A working-directory candidate offered in the picker: a known dir, never retyped. */
export interface AcpDirCandidate {
  readonly path: string;
  /** A short human label (a workspace label, or "current directory"). */
  readonly label: string;
}

/**
 * The async verb surface the spawn flow drives, real daemon round-trips in
 * production (createAcpSpawnGateway), a mocked shape in tests.
 */
export interface AcpSpawnGateway {
  /** Discovered third-party agents (read-only; empty is a quiet, honest absence). */
  listAgents(): Promise<readonly AcpDiscoveredAgent[]>;
  /** The registered workspace roots, the known-dir candidates for the picker. */
  listWorkspaces(): Promise<readonly AcpWorkspaceRegistration[]>;
  /** Host a discovered agent in a directory as a long-lived daemon session. */
  createSession(input: { readonly agentId: string; readonly cwd: string }): Promise<AcpSpawnResult>;
}

export type AcpSpawnGatewayResolution =
  | { readonly available: true; readonly gateway: AcpSpawnGateway }
  | { readonly available: false; readonly reason: string };

export interface AcpSpawnGatewayDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}

/**
 * Build the live ACP spawn gateway over the generic operator invoke path, the
 * same daemon resolution the fleet acts use. Honest unavailable reason when no
 * daemon is reachable, so the spawn key refuses cleanly instead of throwing.
 */
export function createAcpSpawnGateway(deps: AcpSpawnGatewayDeps): AcpSpawnGatewayResolution {
  const rpc = resolveOperatorRpc(deps);
  if (!rpc.available) return { available: false, reason: rpc.reason };
  const { sdk } = rpc;
  const gateway: AcpSpawnGateway = {
    listAgents: async () => (await sdk.operator.invoke('acp.agents.list', {})).agents,
    listWorkspaces: async () => (await sdk.operator.invoke('workspaces.registrations.list', {})).workspaces,
    createSession: (input) => sdk.operator.invoke('acp.sessions.create', input),
  };
  return { available: true, gateway };
}

export interface FleetSpawnDeps {
  /** Resolve a live gateway per action (a daemon that comes up mid-session is seen). */
  readonly resolveGateway: () => AcpSpawnGatewayResolution;
  /** The current working directory, always a candidate dir (labeled "current directory"). */
  readonly currentDirectory: () => string;
  /** Surface a result/receipt/error line to the operator (system message). */
  readonly notify: (message: string) => void;
  /** Repaint request when the controller's own mode state changes. */
  readonly markDirty: () => void;
}

/** Pick a third-party agent to host. */
interface AgentStep {
  readonly step: 'agent';
  readonly agents: readonly AcpDiscoveredAgent[];
  index: number;
}
/** Pick the working directory the hosted agent runs in. */
interface DirStep {
  readonly step: 'dir';
  readonly agent: AcpDiscoveredAgent;
  readonly candidates: readonly AcpDirCandidate[];
  index: number;
}
type SpawnMode = AgentStep | DirStep | null;

/** The spawn picker, as data. */
export interface FleetSpawnView {
  readonly step: 'agent' | 'dir';
  readonly title: string;
  readonly intro: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly detail: string; readonly selected: boolean }>;
  /** A create round-trip is in flight. */
  readonly creating: boolean;
}

export class FleetSpawn {
  private mode: SpawnMode = null;
  /** True while a create round-trip is in flight (absorb keys, show a spinner line). */
  private creating = false;

  public constructor(private readonly deps: FleetSpawnDeps) {}

  /** True while the spawn picker owns the fleet view + input. */
  public spawnModeActive(): boolean {
    return this.mode !== null;
  }

  /**
   * Begin the spawn flow: list discovered agents. Quiet, honest absence when the
   * daemon reports none (no mode entered) rather than an empty picker.
   */
  public async begin(): Promise<void> {
    if (this.mode !== null || this.creating) return;
    const gateway = this.requireGateway();
    if (!gateway) return;
    let agents: readonly AcpDiscoveredAgent[];
    try {
      agents = await gateway.listAgents();
    } catch (err) {
      this.deps.notify(`Could not list ACP agents: ${summarizeError(err)}`);
      return;
    }
    if (agents.length === 0) {
      this.deps.notify('No third-party ACP agents discovered (Claude Code, Codex, opencode). Install one on PATH to host it here.');
      return;
    }
    this.mode = { step: 'agent', agents, index: 0 };
    this.deps.markDirty();
  }

  /** Input while the spawn picker is active. Absorbs every key it owns. */
  public handleSpawnInput(key: string): boolean {
    if (!this.mode || this.creating) return true;
    if (key === 'escape' || key === 'esc') { this.mode = null; this.deps.markDirty(); return true; }
    const list = this.mode.step === 'agent' ? this.mode.agents : this.mode.candidates;
    if (key === 'up' || key === 'k') { this.mode.index = (this.mode.index - 1 + list.length) % list.length; this.deps.markDirty(); return true; }
    if (key === 'down' || key === 'j') { this.mode.index = (this.mode.index + 1) % list.length; this.deps.markDirty(); return true; }
    if (key === 'enter' || key === 'return') { void this.advance(); return true; }
    return true;
  }

  /** Enter on the current step: agent → dir picker; dir → create the session. */
  private async advance(): Promise<void> {
    if (!this.mode) return;
    if (this.mode.step === 'agent') {
      const agent = this.mode.agents[this.mode.index];
      if (!agent) return;
      const candidates = await this.resolveDirCandidates();
      this.mode = { step: 'dir', agent, candidates, index: 0 };
      this.deps.markDirty();
      return;
    }
    const cwd = this.mode.candidates[this.mode.index]?.path;
    const agentId = this.mode.agent.id;
    if (!cwd) return;
    await this.createSession(agentId, cwd);
  }

  /** The known-dir candidates: the current directory first, then registered workspaces (deduped). */
  private async resolveDirCandidates(): Promise<AcpDirCandidate[]> {
    const current = this.deps.currentDirectory();
    const candidates: AcpDirCandidate[] = [{ path: current, label: 'current directory' }];
    const gateway = this.requireGateway();
    if (gateway) {
      try {
        for (const ws of await gateway.listWorkspaces()) {
          if (ws.root === current) continue; // already offered as "current directory"
          candidates.push({ path: ws.root, label: ws.label ?? 'workspace' });
        }
      } catch {
        // A workspaces read failure is non-fatal: the current dir is still offered.
      }
    }
    return candidates;
  }

  /** Drive acp.sessions.create and surface the honest outcome (success or structured failure). */
  private async createSession(agentId: string, cwd: string): Promise<void> {
    const gateway = this.requireGateway();
    if (!gateway) { this.mode = null; this.deps.markDirty(); return; }
    this.creating = true;
    this.deps.markDirty();
    try {
      const result = await gateway.createSession({ agentId, cwd });
      const hosted = result.hosted;
      if (hosted.error) {
        // Structured failure rendered verbatim, never a hung row.
        this.deps.notify(`[Fleet] Could not host ${hosted.title || agentId}: ${hosted.error.stage} stage failed for ${hosted.error.binary}; ${hosted.error.message}`);
      } else {
        this.deps.notify(`[Fleet] Hosting ${hosted.title || agentId} in ${cwd}; it appears as an acp-agent row; steer and stop it like any agent.`);
      }
    } catch (err) {
      this.deps.notify(`ACP session create failed: ${summarizeError(err)}`);
    } finally {
      this.creating = false;
      this.mode = null;
      this.deps.markDirty();
    }
  }

  /** The spawn picker as data the Agents modal draws, or null when it is not open. */
  public spawnView(): FleetSpawnView | null {
    if (!this.mode) return null;
    if (this.creating) return { step: this.mode.step, title: 'Hosting the agent…', intro: '', options: [], creating: true };
    if (this.mode.step === 'agent') {
      const index = this.mode.index;
      return {
        step: 'agent',
        title: 'Host an agent',
        intro: 'Host a third-party coding agent here: pick one, then a directory.',
        options: this.mode.agents.map((agent, i) => ({ label: agent.title, detail: agent.binaryPath, selected: i === index })),
        creating: false,
      };
    }
    const index = this.mode.index;
    return {
      step: 'dir',
      title: this.mode.agent.title,
      intro: `Where ${this.mode.agent.title} runs: a known directory, no path to type.`,
      options: this.mode.candidates.map((cand, i) => ({ label: cand.label, detail: cand.path, selected: i === index })),
      creating: false,
    };
  }

  private requireGateway(): AcpSpawnGateway | null {
    const resolution = this.deps.resolveGateway();
    if (!resolution.available) { this.deps.notify(`[Fleet] ${resolution.reason}`); return null; }
    return resolution.gateway;
  }
}
