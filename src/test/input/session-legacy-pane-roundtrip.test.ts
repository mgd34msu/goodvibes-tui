/**
 * session-legacy-pane-roundtrip.test.ts, a session file saved while the TUI
 * still had side panes, taken through the TUI's real /session paths.
 *
 * Such a file carries `returnContext.openPanels` and an "Open panels: ..."
 * summary line. Proven here, end to end through handleSessionWorkflowCommand
 * with a real SessionManager on disk:
 *   - /session resume loads it and prints nothing about panes;
 *   - the resume's journal-replay rewrite of the same file (the TUI write
 *     path that carries the loaded return context back to disk) writes no
 *     pane list;
 *   - /session save and /session fork write no pane list, even when the
 *     conversation export hands them the legacy return context;
 *   - /session rename rewrites the file without it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { journalPathFor, openTranscriptJournal } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { CommandContext } from '../../input/command-registry.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { handleSessionWorkflowCommand } from '../../input/commands/session-workflow.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';
import { legacyPaneReturnContext, rewriteAsLegacyPaneSession } from '../helpers/legacy-pane-session.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-legacy-layout-roundtrip');
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(sm: SessionManager, conversation: ConversationManager, printed: string[]): CommandContext {
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
    },
    // 'local' so the resume prints the saved return context's lines.
    platform: { configManager: { get: (key: string) => (key === 'behavior.returnContextMode' ? 'local' : undefined), getCategory: () => ({}) } },
    clients: { providerApi: { selectModel: async (model: string) => ({ registryKey: model, providerId: 'p' }) } },
  } as unknown as CommandContext;
}

function expectNoPaneState(fileText: string): void {
  expect(fileText).not.toContain('openPanels');
  expect(fileText).not.toContain('Open panels');
}

/** Save a two-message session, then rewrite it into the pre-removal shape. */
function writeLegacySession(sm: SessionManager, sessionId: string, timestamp: number): string {
  const { filePath } = sm.save(sessionId, [
    { role: 'user', content: 'saved before panes went away' },
    { role: 'assistant', content: 'noted' },
  ], { title: 'Legacy layout', model: 'm', provider: 'p', timestamp });
  rewriteAsLegacyPaneSession(filePath);
  const raw = readFileSync(filePath, 'utf-8');
  expect(raw).toContain('"openPanels"');
  expect(raw).toContain('Open panels: sessions, git, fleet, tokens');
  return filePath;
}

describe('a session saved with side panes, through the real /session paths', () => {
  test('/session resume loads it, prints nothing about panes, and its journal-replay rewrite writes no pane list', async () => {
    const surface = makeTestSurface(tmpDir);
    const sm = new SessionManager(tmpDir, { surface });
    const sessionId = 'legacy-layout';
    const filePath = writeLegacySession(sm, sessionId, Date.now() - 5_000);

    // A turn recorded after the snapshot: resume replays it and rewrites the
    // session file, carrying the loaded return context back to disk.
    const journal = openTranscriptJournal(journalPathFor(surface, sessionId), sessionId);
    journal.appendRecord('assistant_turn', [
      { role: 'user', content: 'saved before panes went away' },
      { role: 'assistant', content: 'noted' },
      { role: 'user', content: 'one more' },
      { role: 'assistant', content: 'after the snapshot' },
    ] as never);

    const printed: string[] = [];
    const conversation = new ConversationManager(() => 80);
    const handled = await handleSessionWorkflowCommand(['resume', sessionId], makeCtx(sm, conversation, printed));

    expect(handled).toBe(true);
    const output = printed.join('\n');
    expect(output).toContain(`Resumed session: ${sessionId}`);
    expect(output).toContain('[Recovery] Replayed 1 journal record(s)');
    expect(output).toContain('Activity: idle');
    expect(output).not.toContain('Open panels');
    expect(output).not.toContain('sessions, git, fleet, tokens');
    expect(conversation.getMessageCount()).toBe(4);

    const rewritten = readFileSync(filePath, 'utf-8');
    expect(rewritten).toContain('"returnContext"');
    expect(rewritten).toContain('after the snapshot');
    expectNoPaneState(rewritten);
  });

  test('/session save and /session fork after that resume write no pane list, even when the export carries the legacy return context', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    writeLegacySession(sm, 'legacy-layout-save', Date.now());

    const printed: string[] = [];
    const conversation = new ConversationManager(() => 80);
    const ctx = makeCtx(sm, conversation, printed);
    await handleSessionWorkflowCommand(['resume', 'legacy-layout-save'], ctx);
    expect(printed.join('\n')).toContain('Resumed session: legacy-layout-save');

    // The export handed to the save paths carries the saved return context in
    // its pre-removal shape.
    const exportConversation = conversation.toJSON.bind(conversation);
    (conversation as unknown as { toJSON: () => unknown }).toJSON = () => ({
      ...exportConversation(),
      returnContext: legacyPaneReturnContext(),
    });

    printed.length = 0;
    await handleSessionWorkflowCommand(['save', 'legacy-copy'], ctx);
    expect(printed.join('\n')).toContain('Session saved: legacy-copy');
    const saved = sm.list().find((entry) => entry.name === 'legacy-copy');
    expect(saved).toBeDefined();
    const savedText = readFileSync(saved!.filePath, 'utf-8');
    expect(savedText).toContain('"returnContext"');
    expect(savedText).toContain('Activity: idle');
    expectNoPaneState(savedText);

    printed.length = 0;
    await handleSessionWorkflowCommand(['fork', 'legacy-fork'], ctx);
    expect(printed.join('\n')).toContain('Session forked:');
    const forked = sm.list().find((entry) => entry.title === 'legacy-fork');
    expect(forked).toBeDefined();
    const forkedText = readFileSync(forked!.filePath, 'utf-8');
    expect(forkedText).toContain('"returnContext"');
    expectNoPaneState(forkedText);
  });

  test('/session rename after resuming rewrites the same file without the pane list', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    const filePath = writeLegacySession(sm, 'legacy-layout-rename', Date.now());

    const printed: string[] = [];
    const ctx = makeCtx(sm, new ConversationManager(() => 80), printed);
    await handleSessionWorkflowCommand(['resume', 'legacy-layout-rename'], ctx);
    expect(printed.join('\n')).toContain('Resumed session: legacy-layout-rename');

    printed.length = 0;
    await handleSessionWorkflowCommand(['rename', 'Renamed legacy layout'], ctx);
    expect(printed.join('\n')).toContain('Session renamed to: Renamed legacy layout');

    const renamedText = readFileSync(filePath, 'utf-8');
    expect(renamedText).toContain('Renamed legacy layout');
    expect(renamedText).toContain('"returnContext"');
    expectNoPaneState(renamedText);
  });
});
