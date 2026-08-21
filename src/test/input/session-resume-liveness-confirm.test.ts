/**
 * session-resume-liveness-confirm.test.ts, /session resume's multi-instance
 * liveness confirm gate (item 6b).
 *
 * A session with a LIVE pid liveness marker (see runtime/session-liveness-marker.ts)
 * means another still-running process is actively refreshing it, resuming it
 * here would fork its live state out from under that other instance. /session
 * resume (also reachable via /resume and /sessions resume, same code path)
 * warns and requires an explicit `--force` to proceed. A missing/stale marker,
 * or a marker that happens to be THIS process's own pid, never blocks anything.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import type { CommandContext } from '../../input/command-registry.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { handleSessionWorkflowCommand } from '../../input/commands/session-workflow.ts';
import { writeLivenessMarker } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-resume-liveness-confirm');
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(sm: SessionManager, printed: string[]): CommandContext {
  const conversation = new ConversationManager(() => 80);
  return {
    print: (t: string) => { printed.push(t); },
    renderRequest: () => {},
    session: {
      conversationManager: conversation,
      runtime: { sessionId: 'current-session', model: 'm', provider: 'p', debugMode: false, systemPrompt: '', reasoningEffort: 'medium' },
      sessionManager: sm,
    },
    workspace: {
      shellPaths: { workingDirectory: tmpDir, homeDirectory: tmpDir },
      surface: makeTestSurface(tmpDir),
      panelManager: new PanelManager(),
    },
    platform: { configManager: { get: () => 'off', getCategory: () => ({}) } },
    clients: { providerApi: { selectModel: async (model: string) => ({ registryKey: model, providerId: 'p' }) } },
  } as unknown as CommandContext;
}

describe('/session resume: multi-instance liveness confirm', () => {
  test('no liveness marker at all: resumes normally, no warning', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-a', [{ role: 'user', content: 'hi' }], { title: 'A', model: 'm', provider: 'p', timestamp: Date.now() });
    const printed: string[] = [];
    const ctx = makeCtx(sm, printed);

    const handled = await handleSessionWorkflowCommand(['resume', 'sess-a'], ctx);

    expect(handled).toBe(true);
    expect(printed.join('\n')).toContain('Resumed session: sess-a');
    expect(printed.join('\n')).not.toContain('appears open in another terminal');
  });

  test('a live marker from a DIFFERENT pid warns and refuses without --force', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-b', [{ role: 'user', content: 'hi' }], { title: 'B', model: 'm', provider: 'p', timestamp: Date.now() });
    // A pid guaranteed to differ from this test process's own pid, and (being
    // pid 1 / init on any real machine, but here just an arbitrary alive-ish
    // pid), use a pid this process itself IS, then assert against a marker
    // for a pid that is NOT this process: init (pid 1) is virtually always a
    // real running process on any POSIX host running this test.
    const otherPid = 1;
    writeLivenessMarker(makeTestSurface(tmpDir), 'sess-b', otherPid);
    const printed: string[] = [];
    const ctx = makeCtx(sm, printed);

    const handled = await handleSessionWorkflowCommand(['resume', 'sess-b'], ctx);

    expect(handled).toBe(true);
    const output = printed.join('\n');
    expect(output).toContain('appears open in another terminal');
    expect(output).toContain(`pid ${otherPid}`);
    expect(output).toContain('--force');
    // Never actually resumed, no "Resumed session" receipt.
    expect(output).not.toContain('Resumed session: sess-b');
  });

  test('the same live marker WITH --force proceeds to resume', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-c', [{ role: 'user', content: 'hi' }], { title: 'C', model: 'm', provider: 'p', timestamp: Date.now() });
    writeLivenessMarker(makeTestSurface(tmpDir), 'sess-c', 1);
    const printed: string[] = [];
    const ctx = makeCtx(sm, printed);

    const handled = await handleSessionWorkflowCommand(['resume', 'sess-c', '--force'], ctx);

    expect(handled).toBe(true);
    expect(printed.join('\n')).toContain('Resumed session: sess-c');
  });

  test('a marker whose pid IS this process\'s own pid never warns (resuming the session already active here)', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-self', [{ role: 'user', content: 'hi' }], { title: 'Self', model: 'm', provider: 'p', timestamp: Date.now() });
    writeLivenessMarker(makeTestSurface(tmpDir), 'sess-self', process.pid);
    const printed: string[] = [];
    const ctx = makeCtx(sm, printed);

    const handled = await handleSessionWorkflowCommand(['resume', 'sess-self'], ctx);

    expect(handled).toBe(true);
    expect(printed.join('\n')).toContain('Resumed session: sess-self');
    expect(printed.join('\n')).not.toContain('appears open in another terminal');
  });

  test('a stale marker (pid no longer running) never blocks; best-effort, never a hard lock', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-stale', [{ role: 'user', content: 'hi' }], { title: 'Stale', model: 'm', provider: 'p', timestamp: Date.now() });
    // A pid essentially guaranteed not to be running.
    writeLivenessMarker(makeTestSurface(tmpDir), 'sess-stale', 2_147_483_000);
    const printed: string[] = [];
    const ctx = makeCtx(sm, printed);

    const handled = await handleSessionWorkflowCommand(['resume', 'sess-stale'], ctx);

    expect(handled).toBe(true);
    expect(printed.join('\n')).toContain('Resumed session: sess-stale');
  });
});
