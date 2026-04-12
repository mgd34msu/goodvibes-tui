import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, existsSync } from 'fs';
import { SessionTaskGraph } from '../../sessions/orchestration/graph.ts';
import {
  CrossSessionTaskRegistry,
} from '../../sessions/orchestration/registry.ts';
import type { CrossSessionTaskRef, SessionTaskGraphSnapshot } from '../../sessions/orchestration/types.ts';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeRef(
  sessionId: string,
  taskId: string,
  overrides: Partial<CrossSessionTaskRef> = {},
): CrossSessionTaskRef {
  return {
    sessionId,
    taskId,
    title: `Task ${taskId}`,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ── SessionTaskGraph ──────────────────────────────────────────────────────────

describe('SessionTaskGraph', () => {
  let graph: SessionTaskGraph;

  beforeEach(() => {
    graph = new SessionTaskGraph();
  });

  // ── upsertRef ────────────────────────────────────────────────────────────────

  describe('upsertRef', () => {
    test('registers a new ref and returns it', () => {
      const ref = makeRef('s1', 't1');
      const stored = graph.upsertRef(ref);
      expect(stored.sessionId).toBe('s1');
      expect(stored.taskId).toBe('t1');
      expect(stored.status).toBe('queued');
    });

    test('upsert preserves identity fields on update', () => {
      const ref = makeRef('s1', 't1', { createdAt: 1000 });
      graph.upsertRef(ref);
      const updated = graph.upsertRef({ ...ref, status: 'running', updatedAt: 2000 });
      expect(updated.status).toBe('running');
      expect(updated.createdAt).toBe(1000); // preserved
    });

    test('upsert patches label when provided', () => {
      graph.upsertRef(makeRef('s1', 't1'));
      graph.upsertRef(makeRef('s1', 't1', { label: 'new-label', status: 'running', updatedAt: 9999 }));
      const stored = graph.getRef('s1', 't1');
      expect(stored?.label).toBe('new-label');
    });

    test('new refs are independent objects (no shared reference)', () => {
      const ref = makeRef('s1', 't1');
      const stored = graph.upsertRef(ref);
      ref.status = 'running';
      expect(stored.status).toBe('queued'); // stored copy unaffected
    });
  });

  // ── addEdge ──────────────────────────────────────────────────────────────────

  describe('addEdge', () => {
    test('adds a dependency edge between two registered refs', () => {
      graph.upsertRef(makeRef('s1', 't1'));
      graph.upsertRef(makeRef('s1', 't2'));
      const result = graph.addEdge({ sessionId: 's1', taskId: 't1' }, { sessionId: 's1', taskId: 't2' });
      expect(result.ok).toBe(true);
      const deps = graph.getDependencies('s1', 't1');
      expect(deps).toHaveLength(1);
      expect(deps[0]!.taskId).toBe('t2');
    });

    test('rejects edge when from-ref is unregistered', () => {
      graph.upsertRef(makeRef('s1', 't2'));
      const result = graph.addEdge({ sessionId: 's1', taskId: 'unknown' }, { sessionId: 's1', taskId: 't2' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Ref not found/);
    });

    test('rejects edge when to-ref is unregistered', () => {
      graph.upsertRef(makeRef('s1', 't1'));
      const result = graph.addEdge({ sessionId: 's1', taskId: 't1' }, { sessionId: 's1', taskId: 'unknown' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Ref not found/);
    });

    test('rejects self-dependency', () => {
      graph.upsertRef(makeRef('s1', 't1'));
      const result = graph.addEdge({ sessionId: 's1', taskId: 't1' }, { sessionId: 's1', taskId: 't1' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Self-dependency/);
    });

    test('is idempotent — duplicate edge returns ok without adding', () => {
      graph.upsertRef(makeRef('s1', 't1'));
      graph.upsertRef(makeRef('s1', 't2'));
      graph.addEdge({ sessionId: 's1', taskId: 't1' }, { sessionId: 's1', taskId: 't2' });
      const result = graph.addEdge({ sessionId: 's1', taskId: 't1' }, { sessionId: 's1', taskId: 't2' });
      expect(result.ok).toBe(true);
      expect(graph.getDependencies('s1', 't1')).toHaveLength(1);
    });
  });

  // ── cycle detection ──────────────────────────────────────────────────────────

  describe('cycle detection', () => {
    test('rejects edge that would create a direct cycle (A→B, B→A)', () => {
      graph.upsertRef(makeRef('s1', 'A'));
      graph.upsertRef(makeRef('s1', 'B'));
      graph.addEdge({ sessionId: 's1', taskId: 'A' }, { sessionId: 's1', taskId: 'B' });
      const result = graph.addEdge({ sessionId: 's1', taskId: 'B' }, { sessionId: 's1', taskId: 'A' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/cycle/);
    });

    test('rejects edge that would create a transitive cycle (A→B→C, C→A)', () => {
      graph.upsertRef(makeRef('s1', 'A'));
      graph.upsertRef(makeRef('s1', 'B'));
      graph.upsertRef(makeRef('s1', 'C'));
      graph.addEdge({ sessionId: 's1', taskId: 'A' }, { sessionId: 's1', taskId: 'B' });
      graph.addEdge({ sessionId: 's1', taskId: 'B' }, { sessionId: 's1', taskId: 'C' });
      const result = graph.addEdge({ sessionId: 's1', taskId: 'C' }, { sessionId: 's1', taskId: 'A' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/cycle/);
    });

    test('allows a valid diamond DAG (A→B, A→C, B→D, C→D)', () => {
      for (const id of ['A', 'B', 'C', 'D']) graph.upsertRef(makeRef('s1', id));
      expect(graph.addEdge({ sessionId: 's1', taskId: 'A' }, { sessionId: 's1', taskId: 'B' }).ok).toBe(true);
      expect(graph.addEdge({ sessionId: 's1', taskId: 'A' }, { sessionId: 's1', taskId: 'C' }).ok).toBe(true);
      expect(graph.addEdge({ sessionId: 's1', taskId: 'B' }, { sessionId: 's1', taskId: 'D' }).ok).toBe(true);
      expect(graph.addEdge({ sessionId: 's1', taskId: 'C' }, { sessionId: 's1', taskId: 'D' }).ok).toBe(true);
    });
  });

  // ── collectSubtree ───────────────────────────────────────────────────────────

  describe('collectSubtree', () => {
    test('returns only root when task has no dependents', () => {
      graph.upsertRef(makeRef('s1', 'root'));
      const subtree = graph.collectSubtree('s1', 'root');
      expect(subtree).toHaveLength(1);
      expect(subtree[0]!.taskId).toBe('root');
    });

    test('returns root plus all transitive dependents in BFS order', () => {
      // root → child1 → grandchild
      //      → child2
      graph.upsertRef(makeRef('s1', 'root'));
      graph.upsertRef(makeRef('s1', 'child1'));
      graph.upsertRef(makeRef('s1', 'child2'));
      graph.upsertRef(makeRef('s1', 'grandchild'));
      // child1 depends on root
      graph.addEdge({ sessionId: 's1', taskId: 'child1' }, { sessionId: 's1', taskId: 'root' });
      // child2 depends on root
      graph.addEdge({ sessionId: 's1', taskId: 'child2' }, { sessionId: 's1', taskId: 'root' });
      // grandchild depends on child1
      graph.addEdge({ sessionId: 's1', taskId: 'grandchild' }, { sessionId: 's1', taskId: 'child1' });

      const subtree = graph.collectSubtree('s1', 'root');
      const ids = subtree.map((r) => r.taskId);
      expect(ids[0]).toBe('root'); // root first
      expect(ids).toContain('child1');
      expect(ids).toContain('child2');
      expect(ids).toContain('grandchild');
      expect(ids).toHaveLength(4);
    });

    test('returns empty array for unregistered task', () => {
      expect(graph.collectSubtree('s1', 'nonexistent')).toEqual([]);
    });
  });

  // ── applyCancellation ────────────────────────────────────────────────────────

  describe('applyCancellation', () => {
    test('task scope cancels only the specified task', () => {
      graph.upsertRef(makeRef('s1', 't1'));
      graph.upsertRef(makeRef('s1', 't2'));
      const result = graph.applyCancellation({ sessionId: 's1', taskId: 't1', scope: 'task', requestedAt: Date.now() });
      expect(result.ok).toBe(true);
      expect(result.cancelled).toHaveLength(1);
      expect(result.cancelled[0]!.taskId).toBe('t1');
      expect(graph.getRef('s1', 't2')?.status).toBe('queued'); // unaffected
    });

    test('subtree scope cancels root and all dependents', () => {
      graph.upsertRef(makeRef('s1', 'root'));
      graph.upsertRef(makeRef('s1', 'child'));
      graph.addEdge({ sessionId: 's1', taskId: 'child' }, { sessionId: 's1', taskId: 'root' });
      const result = graph.applyCancellation({ sessionId: 's1', taskId: 'root', scope: 'subtree', requestedAt: Date.now() });
      expect(result.ok).toBe(true);
      expect(result.cancelled.map((r) => r.taskId).sort()).toEqual(['child', 'root']);
    });

    test('session scope cancels all tasks in session', () => {
      graph.upsertRef(makeRef('s1', 'tA'));
      graph.upsertRef(makeRef('s1', 'tB'));
      graph.upsertRef(makeRef('s2', 'tC')); // different session
      const result = graph.applyCancellation({ sessionId: 's1', scope: 'session', requestedAt: Date.now() });
      expect(result.ok).toBe(true);
      expect(result.cancelled.map((r) => r.taskId).sort()).toEqual(['tA', 'tB']);
      expect(graph.getRef('s2', 'tC')?.status).toBe('queued'); // unaffected
    });

    test('skips already-terminal tasks', () => {
      graph.upsertRef(makeRef('s1', 'done', { status: 'completed' }));
      graph.upsertRef(makeRef('s1', 'live'));
      const result = graph.applyCancellation({ sessionId: 's1', scope: 'session', requestedAt: Date.now() });
      expect(result.ok).toBe(true);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]!.taskId).toBe('done');
      expect(result.cancelled).toHaveLength(1);
      expect(result.cancelled[0]!.taskId).toBe('live');
    });

    test('task scope returns error when taskId is missing', () => {
      const result = graph.applyCancellation({ sessionId: 's1', scope: 'task', requestedAt: Date.now() });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/taskId required/);
    });

    test('subtree scope returns error when taskId is missing', () => {
      const result = graph.applyCancellation({ sessionId: 's1', scope: 'subtree', requestedAt: Date.now() });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/taskId required/);
    });
  });

  // ── snapshot / hydrate round-trip ────────────────────────────────────────────

  describe('snapshot / hydrate round-trip', () => {
    test('snapshot captures all refs, edges, and handoffs', () => {
      graph.upsertRef(makeRef('s1', 't1'));
      graph.upsertRef(makeRef('s1', 't2'));
      graph.addEdge({ sessionId: 's1', taskId: 't1' }, { sessionId: 's1', taskId: 't2' });
      graph.recordHandoff({
        handoffId: 'h1',
        taskRef: { sessionId: 's1', taskId: 't1' },
        fromSessionId: 's1',
        toSessionId: 's2',
        initiatedAt: Date.now(),
        acknowledged: false,
      });

      const snap = graph.snapshot();
      expect(snap.version).toBe(1);
      expect(Object.keys(snap.refs)).toHaveLength(2);
      expect(snap.edges).toHaveLength(1);
      expect(snap.handoffs).toHaveLength(1);
    });

    test('snapshot edge copies are independent (deep copy)', () => {
      graph.upsertRef(makeRef('s1', 't1'));
      graph.upsertRef(makeRef('s1', 't2'));
      graph.addEdge({ sessionId: 's1', taskId: 't1' }, { sessionId: 's1', taskId: 't2' });
      const snap1 = graph.snapshot();
      const snap2 = graph.snapshot();
      // Mutating one snapshot edge ref should not affect the other
      (snap1.edges[0]!.fromRef as { taskId: string }).taskId = 'mutated';
      expect(snap2.edges[0]!.fromRef.taskId).toBe('t1');
    });

    test('hydrate round-trip restores the same graph', () => {
      graph.upsertRef(makeRef('s1', 'A'));
      graph.upsertRef(makeRef('s1', 'B'));
      graph.addEdge({ sessionId: 's1', taskId: 'A' }, { sessionId: 's1', taskId: 'B' });
      const snap = graph.snapshot();

      const graph2 = new SessionTaskGraph();
      graph2.hydrate(snap);

      expect(graph2.getRef('s1', 'A')).toBeDefined();
      expect(graph2.getRef('s1', 'B')).toBeDefined();
      expect(graph2.getDependencies('s1', 'A')[0]!.taskId).toBe('B');
    });

    test('hydrate is safe to call multiple times (idempotent for existing data)', () => {
      graph.upsertRef(makeRef('s1', 't1'));
      const snap = graph.snapshot();
      graph.hydrate(snap); // re-hydrate same data
      expect(graph.getAllRefs()).toHaveLength(1);
    });
  });
});

describe('CrossSessionTaskRegistry', () => {
  let dir: string;
  let registry: CrossSessionTaskRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gv-session-orch-'));
    registry = new CrossSessionTaskRegistry(dir);
  });

  afterEach(() => {
    registry.dispose();
  });

  test('tracks refs via explicit registry instance', () => {
    const ref = makeRef('s1', 'task-1');
    expect(registry.linkTask(ref).ok).toBe(true);
    expect(registry.getRef('s1', 'task-1')?.taskId).toBe('task-1');
  });
});

describe('CrossSessionTaskRegistry lifecycle', () => {
  let baseExitListeners = 0;

  beforeEach(() => {
    baseExitListeners = process.listenerCount('exit');
  });

  afterEach(() => {
    // No shared helper cache needs resetting in this suite.
  });

  test('dispose removes the process exit listener it installs', () => {
    const registry = new CrossSessionTaskRegistry();
    expect(process.listenerCount('exit')).toBe(baseExitListeners + 1);

    registry.dispose();

    expect(process.listenerCount('exit')).toBe(baseExitListeners);
  });

  test('separate instances each install and remove their own exit listeners', () => {
    const first = new CrossSessionTaskRegistry();
    const second = new CrossSessionTaskRegistry();
    expect(process.listenerCount('exit')).toBe(baseExitListeners + 2);

    first.dispose();
    expect(process.listenerCount('exit')).toBe(baseExitListeners + 1);
    second.dispose();
    expect(process.listenerCount('exit')).toBe(baseExitListeners);
  });
});

// ── CrossSessionTaskRegistry persistence ─────────────────────────────────────

describe('CrossSessionTaskRegistry persistence', () => {
  let tmpDir: string;
  let registry: CrossSessionTaskRegistry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-test-'));
    registry = new CrossSessionTaskRegistry(tmpDir);
  });

  afterEach(() => {
    registry.dispose();
  });

  test('linkTask persists to disk after flush', () => {
    const ref = makeRef('s1', 't1');
    registry.linkTask(ref);
    registry.flush();
    const graphPath = join(tmpDir, '.goodvibes', 'tui', 'sessions', 'task-graph.json');
    expect(existsSync(graphPath)).toBe(true);
  });

  test('new registry instance hydrates state from disk', () => {
    const ref = makeRef('s1', 't1', { title: 'Persisted Task' });
    registry.linkTask(ref);
    registry.flush();

    const registry2 = new CrossSessionTaskRegistry(tmpDir);
    const loaded = registry2.getRef('s1', 't1');
    expect(loaded).toBeDefined();
    expect(loaded?.title).toBe('Persisted Task');
  });

  test('linkTask with deps round-trips through persistence', () => {
    const refA = makeRef('s1', 'A');
    const refB = makeRef('s1', 'B');
    registry.linkTask(refA);
    registry.linkTask(refB, { sessionId: 's1', taskId: 'A' }, 'depends on A');
    registry.flush();

    const registry2 = new CrossSessionTaskRegistry(tmpDir);
    const deps = registry2.getDependencies('s1', 'B');
    expect(deps).toHaveLength(1);
    expect(deps[0]!.taskId).toBe('A');
  });

  test('linkTask with cycle returns error', () => {
    registry.linkTask(makeRef('s1', 'X'));
    registry.linkTask(makeRef('s1', 'Y'), { sessionId: 's1', taskId: 'X' });
    // Now try to create a cycle: X depends on Y, but Y already depends on X
    const result = registry.linkTask(makeRef('s1', 'X'), { sessionId: 's1', taskId: 'Y' });
    // X was already registered (upserted), edge X→Y is a cycle since Y depends on X
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cycle/);
  });
});

// Singleton accessor tests removed: the suite now exercises explicit registry instances only.
