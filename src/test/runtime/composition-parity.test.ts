/**
 * Composition-parity gate — pins daemon-vs-interactive wiring facts that the
 * TUI's forked composition roots must keep in step with the SDK's own.
 *
 * These are source-level assertions on purpose: the wiring differences they
 * pin (observed foreign-agent detection, the startup retention sweep, live
 * config-file watching) are either host-nondeterministic to exercise
 * (observed detection scans the real process table / tmux) or lifecycle
 * side-effects with no return value to inspect, so a source pin is the honest,
 * deterministic way to catch a fork that silently drops one of them.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** The argument object literal passed to the first createRuntimeServices call in a file. */
function createRuntimeServicesCallArgs(source: string): string {
  const idx = source.indexOf('createRuntimeServices({');
  expect(idx, 'createRuntimeServices({ ... }) call not found').toBeGreaterThan(-1);
  // Walk from the opening brace to its matching close so we inspect only this
  // call's options, not the rest of the file.
  const open = source.indexOf('{', idx);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced createRuntimeServices call braces');
}

describe('composition parity — observed foreign-agent detection is daemon-side only', () => {
  test('the standalone daemon composes observed agents (observeExternalAgents: true)', () => {
    const args = createRuntimeServicesCallArgs(read('src/daemon/cli.ts'));
    expect(args).toContain('observeExternalAgents: true');
  });

  test('the interactive process does NOT observe (no double-detection; it reads the daemon snapshot)', () => {
    const args = createRuntimeServicesCallArgs(read('src/runtime/bootstrap-core.ts'));
    expect(args).not.toContain('observeExternalAgents');
  });

  test('createRuntimeServices threads the daemon opt-in into the fleet services helper', () => {
    const services = read('src/runtime/services.ts');
    expect(services).toContain('observeExternalAgents: options.observeExternalAgents');
  });

  test('the fleet services helper constructs the observed source only under the opt-in flag', () => {
    const helper = read('src/runtime/fleet-services.ts');
    // Constructed only when opted in (never unconditionally)...
    expect(helper).toMatch(/observeExternalAgents\s*\?\s*new ObservedAgentSource\(\)\s*:\s*undefined/);
    // ...and threaded into the shared registry as the observedAgents dep.
    expect(helper).toContain('observedAgents,');
  });
});

describe('composition parity — retention janitor and live config apply run on TUI-composed runtimes', () => {
  const durability = read('src/runtime/durability-services.ts');

  test('the startup append-only sweep runs with the FULL roots set', () => {
    expect(durability).toContain('runStartupAppendOnlySweep');
    // Every root the SDK passes must be present — omitting any silently skips
    // that store class on every sweep.
    for (const root of ['workingDirectory', 'surfaceRoot', 'homeDirectory', 'logDir', 'telemetryDir']) {
      expect(durability, `sweep root ${root} missing`).toContain(`${root}:`);
    }
  });

  test('live config-file watching is composed (external edits apply without a restart)', () => {
    expect(durability).toContain('configManager.watchConfigFiles()');
  });

  test('services.ts feeds the durability helper the sweep roots', () => {
    const services = read('src/runtime/services.ts');
    expect(services).toContain('surfaceRoot:');
    expect(services).toContain('shellPaths,');
  });
});

describe('composition parity — keep-awake config live-apply is wired', () => {
  test('the power manager is wired with subscribeConfig so a config write applies live', () => {
    const idlePower = read('src/runtime/idle-power-services.ts');
    expect(idlePower).toContain('subscribeConfig:');
    expect(idlePower).toContain('configManager.subscribe');
  });
});

describe('composition parity — memory governance is composed (governor default ON, real caches, pausable jobs)', () => {
  const services = read('src/runtime/services.ts');

  test('the CacheRegistry, PauseController and the deferrable job ids are built EARLY (before the schedulers that consult them)', () => {
    expect(services).toContain('new CacheRegistry()');
    expect(services).toContain('new PauseController()');
    expect(services).toContain("MEMORY_BACKGROUND_JOB_IDS = ['knowledge-self-improvement', 'memory-consolidation', 'code-index-reindex']");
    // The seams are built before the knowledge services (which consult them via the passed-in gate).
    expect(services.indexOf('new CacheRegistry()')).toBeLessThan(services.indexOf('createKnowledgeServices('));
  });

  test('createRuntimeServices constructs + starts the governor via the tail helper and late-binds the admission gate', () => {
    expect(services).toContain('wireMemoryGovernance({');
    expect(services).toContain('admitExpensiveWorkRef.current = (label) => memoryGovernor.admitExpensiveWork(label)');
  });

  test('the governor is threaded into the gateway verb handlers so ops.memory.get is invokable (not a 501)', () => {
    // memoryGovernor lands in the attachWsOnlyGatewayVerbHandlers deps object.
    const attachIdx = services.indexOf('attachWsOnlyGatewayVerbHandlers(gatewayMethods,');
    expect(attachIdx).toBeGreaterThan(-1);
    expect(services.slice(attachIdx)).toContain('memoryGovernor,');
  });

  test('the three deferrable jobs honor governor backpressure at their scheduler gates', () => {
    // code-index reindex (threaded into createCodeIndexServices)...
    expect(services).toContain("isReindexPaused: () => pauseController.isPaused('code-index-reindex')");
    // memory consolidation (ANDed into the idle gate)...
    expect(services).toContain("!pauseController.isPaused('memory-consolidation')");
    // knowledge self-improvement (isBackgroundPaused on the semantic services).
    expect(services).toContain('isBackgroundPaused: isKnowledgeBackgroundPaused');
  });

  test('the tail helper registers the REAL cache adapters and starts by default (never start:false)', () => {
    const helper = read('src/runtime/memory-governance-services.ts');
    expect(helper).toContain('wireDaemonMemoryGovernance({');
    expect(helper).toContain('knowledgeStores: deps.knowledgeStores');
    expect(helper).toContain('sessionBroker: deps.sessionBroker');
    // Default ON: the helper never opts out of the governor's default start.
    expect(helper).not.toContain('start: false');
  });

  test('managed voice provisioning is composed so voice.local.status/install are invokable', () => {
    expect(services).toContain('wireVoiceSetup({');
    const helper = read('src/runtime/voice-setup-services.ts');
    expect(helper).toContain('const voiceSetup: VoiceSetupService = {');
    const attachIdx = services.indexOf('attachWsOnlyGatewayVerbHandlers(gatewayMethods,');
    expect(services.slice(attachIdx)).toContain('voiceSetup,');
  });

  test('the daemon serves LIVE install progress: the tracker is wired and merged onto status()', () => {
    const helper = read('src/runtime/voice-setup-services.ts');
    expect(helper).toContain('createVoiceInstallProgressTracker(');
    expect(helper).toContain('progress.begin()');
    expect(helper).toContain('onProgress: (p) => progress.onProgress(p)');
    expect(helper).toContain('progress.end()');
    expect(helper).toContain('installInProgress: snapshot');
  });
});

describe('composition parity — host power seam is opt-in (non-spawning default)', () => {
  // SDK 1.9.0's wireRuntimePower defaults an ABSENT seam to the real host seam
  // (createHostPowerSeam — spawns systemd-inhibit + a dbus-monitor sleep-edge
  // watcher). That host-level spawn must never fire on a test-constructed
  // runtime, so the fork mirrors the SDK's own createRuntimeServices: default to
  // the non-spawning unavailable seam, and only the real long-lived compositions
  // opt in. These source pins catch a fork that regresses either half.

  test('the idle-power helper defaults to the NON-spawning unavailable seam when no seam is passed', () => {
    const idlePower = read('src/runtime/idle-power-services.ts');
    // The seam falls back to createUnavailablePowerSeam(...) rather than passing
    // undefined through to wireRuntimePower (which would spawn the host seam).
    expect(idlePower).toMatch(/seam:\s*deps\.powerSeam\s*\?\?\s*createUnavailablePowerSeam\(/);
    expect(idlePower).toContain("import { PowerManager, wireRuntimePower, createUnavailablePowerSeam }");
  });

  test('createRuntimeServices threads the power-seam opt-in into the idle-power helper', () => {
    const services = read('src/runtime/services.ts');
    expect(services).toContain('powerSeam: options.powerSeam');
  });

  test('the standalone daemon opts into the real host power seam (live keep-awake/idle-inhibit)', () => {
    const args = createRuntimeServicesCallArgs(read('src/daemon/cli.ts'));
    expect(args).toContain('powerSeam: createHostPowerSeam()');
  });

  test('the embedded interactive runtime opts in too (it IS the daemon in the embedded topology)', () => {
    const args = createRuntimeServicesCallArgs(read('src/runtime/bootstrap-core.ts'));
    expect(args).toContain('powerSeam: createHostPowerSeam()');
  });
});
