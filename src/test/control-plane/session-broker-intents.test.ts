import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouteBindingManager } from '@pellux/goodvibes-sdk/platform/channels';
import { SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import { trackDisposables } from '../helpers/disposables.ts';
import { AutomationRouteStore } from '@pellux/goodvibes-sdk/platform/automation';
import { PersistentStore } from '@pellux/goodvibes-sdk/platform/state';

// A broker starts a 60s GC sweep once started; stop() clears it.
const disposables = trackDisposables();

describe('SharedSessionBroker explicit intents', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-session-intents-'));
  });

  function buildBroker() {
    const liveAgents = new Map<string, 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'>();
    const routeBindings = new RouteBindingManager({
      store: new AutomationRouteStore(join(root, 'routes.json')),
    });
    const broker = disposables.add(new SharedSessionBroker({
      store: new PersistentStore(join(root, 'sessions.json')),
      routeBindings,
      agentStatusProvider: {
        getStatus(agentId) {
          const status = liveAgents.get(agentId);
          return status ? { id: agentId, status } : null;
        },
      },
      messageSender: {
        send(_fromId, toId) {
          return liveAgents.has(toId);
        },
      },
    }));
    return {
      broker,
      setLiveAgent(agentId: string, status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' = 'running') {
        liveAgents.set(agentId, status);
      },
    };
  }

  test('submit inputs get stable correlation and causation identifiers', async () => {
    const { broker } = buildBroker();
    await broker.start();

    const submission = await broker.submitMessage({
      surfaceKind: 'tui',
      surfaceId: 'surface:tui',
      body: 'Continue the active task',
    });

    expect(submission.intent).toBe('submit');
    expect(submission.mode).toBe('spawn');
    expect(submission.input.state).toBe('queued');
    expect(submission.input.correlationId).toMatch(/^session-input:/);
    expect(submission.input.causationId).toBe(submission.userMessage.id);

    const inputs = broker.getInputs(submission.session.id, 10);
    expect(inputs[0]?.id).toBe(submission.input.id);
    expect(inputs[0]?.correlationId).toBe(submission.input.correlationId);
  });

  test('steer and follow-up keep distinct live vs queued semantics', async () => {
    const { broker, setLiveAgent } = buildBroker();
    await broker.start();

    const initial = await broker.submitMessage({
      surfaceKind: 'tui',
      surfaceId: 'surface:tui',
      body: 'Initial request',
    });
    setLiveAgent('agent-live-1');
    await broker.bindAgent(initial.session.id, 'agent-live-1');

    const steer = await broker.steerMessage({
      sessionId: initial.session.id,
      surfaceKind: 'tui',
      surfaceId: 'surface:tui',
      body: 'Adjust the current run',
      allowSpawnFallback: false,
    });
    expect(steer.intent).toBe('steer');
    expect(steer.mode).toBe('continued-live');
    expect(steer.state).toBe('delivered');
    expect(steer.activeAgentId).toBe('agent-live-1');

    const followUp = await broker.followUpMessage({
      sessionId: initial.session.id,
      surfaceKind: 'tui',
      surfaceId: 'surface:tui',
      body: 'After this run, summarize the outcome',
    });
    expect(followUp.intent).toBe('follow-up');
    expect(followUp.mode).toBe('queued-follow-up');
    expect(followUp.state).toBe('queued');
  });
});
