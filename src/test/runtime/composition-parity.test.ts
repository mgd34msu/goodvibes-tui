/**
 * Composition-parity gate — pins the wiring facts this app's composition root
 * must keep, now that it is a CLIENT of the daemon rather than a second copy of
 * one.
 *
 * These are source-level assertions on purpose: what they pin is either
 * host-nondeterministic to exercise or a lifecycle side-effect with no return
 * value to inspect, so a source pin is the honest, deterministic way to catch a
 * composition that silently drops one of them.
 *
 * The daemon-side half of this gate — that the standalone daemon observes
 * foreign agents, opts into the real host power seam, and provisions the wake
 * model at boot — went with the daemon to its own repository, where those
 * compositions now live. What is pinned here is the client posture: this
 * process observes nothing, serves nothing, and composes its turn over the
 * SDK's client shape.
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
  test('nothing in this repository observes foreign agents — that scan is the daemon\'s', () => {
    // Observed detection scans the real process table and tmux. Two processes
    // doing it produces two rows for one agent, which is why it was always
    // daemon-only; with the daemon extracted, this repository must not carry
    // the opt-in at all.
    expect(read('src/runtime/services.ts')).not.toContain('observeExternalAgents');
  });

  test('the interactive process does NOT observe (no double-detection; it reads the daemon snapshot)', () => {
    const args = createRuntimeServicesCallArgs(read('src/runtime/bootstrap-core.ts'));
    expect(args).not.toContain('observeExternalAgents');
  });

  test('this composition passes the fleet helper no observed-agent source at all', () => {
    // The helper still SUPPORTS the opt-in — the daemon composes it — but this
    // client must never pass it, or one agent is counted twice.
    expect(read('src/runtime/services.ts')).not.toContain('observeExternalAgents:');
  });
});

describe('composition parity — the durability helper is fed what its sweep needs', () => {
  test('services.ts feeds the durability helper the sweep roots', () => {
    const services = read('src/runtime/services.ts');
    expect(services).toContain('surfaceRoot:');
    expect(services).toContain('shellPaths,');
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

  test('the governor is wired into no verb handler, because this process serves no verbs', () => {
    // ops.memory.get is answered by the DAEMON's governor, over the wire. This
    // process keeps a governor of its own because it holds real caches (the
    // knowledge stores, the session broker) and has to defend its own
    // footprint — but it never advertises one.
    expect(services).not.toContain('attachWsOnlyGatewayVerbHandlers(');
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

  test('voice setup is still composed here, because the microphone and the speaker are here', () => {
    // The wake word listens inside THIS process (capture is a child of this
    // terminal, inference is WASM in-process) and a spoken turn plays out of
    // this terminal's speaker. What moved is the verb surface:
    // voice.local.status/install are the daemon's to answer.
    expect(services).toContain('wireVoiceSetup({');
  });
});

describe('composition parity — host power seam is opt-in (non-spawning default)', () => {
  // SDK 1.9.0's wireRuntimePower defaults an ABSENT seam to the real host seam
  // (createHostPowerSeam — spawns systemd-inhibit + a dbus-monitor sleep-edge
  // watcher). That host-level spawn must never fire on a test-constructed
  // runtime, so the fork mirrors the SDK's own createRuntimeServices: default to
  // the non-spawning unavailable seam, and only the real long-lived compositions
  // opt in. These source pins catch a fork that regresses either half.

  test('createRuntimeServices threads the power-seam opt-in into the idle-power helper', () => {
    const services = read('src/runtime/services.ts');
    expect(services).toContain('powerSeam: options.powerSeam');
  });

  test('this app opts into the real host seam too — a long-lived terminal inhibits idle for its own turns', () => {
    // The daemon's opt-in went with the daemon. This one stays: a running turn
    // in this terminal is exactly as much a reason not to suspend the machine.
    expect(createRuntimeServicesCallArgs(read('src/runtime/bootstrap-core.ts'))).toContain('powerSeam: createHostPowerSeam()');
  });

  test('the embedded interactive runtime opts in too (it IS the daemon in the embedded topology)', () => {
    const args = createRuntimeServicesCallArgs(read('src/runtime/bootstrap-core.ts'));
    expect(args).toContain('powerSeam: createHostPowerSeam()');
  });
});

describe('composition parity — wake-model boot provisioning is opt-in, like the power seam', () => {
  // The wake-word model arrives with the installation, and the daemon retries at
  // boot for whatever the install could not get. That retry does network I/O and
  // starts an hourly recovery sweep, so it must be an explicit opt-in — the same
  // treatment the host power seam gets, for the same reason: a test composing this
  // graph, and a one-shot CLI command, must fetch nothing and start no timer.
  test('the wake model is provisioned by whoever LISTENS, which is this process', () => {
    // The daemon provisions the model at install time; this app provisions it
    // at boot because the inference that reads it runs here.
    expect(createRuntimeServicesCallArgs(read('src/runtime/bootstrap-core.ts'))).toContain('provisionWakeModelsAtBoot: true');
  });

  test('the embedded interactive runtime opts in — it IS the daemon in that topology', () => {
    expect(createRuntimeServicesCallArgs(read('src/runtime/bootstrap-core.ts'))).toContain('provisionWakeModelsAtBoot: true');
  });

  test('the one-shot CLI commands do NOT opt in', () => {
    // `goodvibes bundle …` and the management commands compose a graph to answer
    // one question and exit; starting an hourly sweep and a 6 MB download there
    // would be work nobody asked for.
    expect(createRuntimeServicesCallArgs(read('src/cli/bundle-command.ts'))).not.toContain('provisionWakeModelsAtBoot');
    expect(createRuntimeServicesCallArgs(read('src/cli/management-utils.ts'))).not.toContain('provisionWakeModelsAtBoot');
  });

  test('the sweep and the pending attempt are on the disposal list, opted in or not', () => {
    // An hourly timer nothing stops is a poller this surface leaked. It is
    // registered unconditionally, because "the graph did not start it this time"
    // is not a reason for teardown to have no way to stop it.
    const disposal = read('src/runtime/disposal-wiring.ts');
    expect(disposal).toContain("registry.add('wake-word housekeeping', services.stopWakeHousekeeping)");
    expect(read('src/runtime/services.ts')).toContain('stopWakeHousekeeping');
  });
});
