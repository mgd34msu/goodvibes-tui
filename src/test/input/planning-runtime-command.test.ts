import { describe, expect, test } from 'bun:test';
import {
  evaluateProjectPlanningReadiness,
  type ProjectPlanningEvaluation,
  type ProjectPlanningService,
  type ProjectPlanningState,
} from '@pellux/goodvibes-sdk/platform/knowledge';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { KillRing } from '../../input/kill-ring.ts';
import { registerPlanningRuntimeCommands } from '../../input/commands/planning-runtime.ts';
import { handlePromptTextToken, handlePromptKeyToken, type KeyRouteState } from '../../input/handler-feed-routes.ts';

function makeState(input: Partial<ProjectPlanningState> = {}): ProjectPlanningState {
  const now = Date.now();
  return {
    id: input.id ?? 'current',
    projectId: input.projectId ?? 'proj',
    knowledgeSpaceId: input.knowledgeSpaceId ?? 'project:proj',
    goal: input.goal ?? '',
    scope: input.scope,
    knownContext: input.knownContext ?? [],
    openQuestions: input.openQuestions ?? [],
    answeredQuestions: input.answeredQuestions ?? [],
    decisions: input.decisions ?? [],
    assumptions: input.assumptions ?? [],
    constraints: input.constraints ?? [],
    risks: input.risks ?? [],
    tasks: input.tasks ?? [],
    dependencies: input.dependencies ?? [],
    verificationGates: input.verificationGates ?? [],
    agentAssignments: input.agentAssignments ?? [],
    readiness: input.readiness ?? 'not-ready',
    executionApproved: input.executionApproved ?? false,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    metadata: input.metadata ?? {},
  };
}

function makeService(initial: ProjectPlanningState | null = null): {
  readonly service: ProjectPlanningService;
  readonly state: () => ProjectPlanningState | null;
} {
  let state = initial;
  const service = {
    async status() {
      return {
        ok: true,
        projectId: 'proj',
        knowledgeSpaceId: 'project:proj',
        passiveOnly: true,
        counts: { states: state ? 1 : 0, decisions: 0, languageArtifacts: 0 },
        capabilities: ['project-scoped-storage'],
      };
    },
    async getState() {
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', state };
    },
    async upsertState(input: { state: Partial<ProjectPlanningState> }) {
      state = evaluateProjectPlanningReadiness(makeState(input.state)).state;
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', state };
    },
    async evaluate(input?: { state?: Partial<ProjectPlanningState> }): Promise<ProjectPlanningEvaluation> {
      return evaluateProjectPlanningReadiness(makeState(input?.state ?? state ?? {}));
    },
  };
  return {
    service: service as unknown as ProjectPlanningService,
    state: () => state,
  };
}

function makeContext(
  service: ProjectPlanningService,
  out: string[],
  opened: string[],
  planManagerOverride: Record<string, unknown> = {},
): CommandContext {
  return {
    print: (message: string) => out.push(message),
    showPanel: (panelId: string) => { opened.push(panelId); },
    // W6.1: /plan open now routes to the 'planning' modal via ctx.openModal.
    openModal: (name: string) => { opened.push(name); },
    session: {
      runtime: {
        model: 'gpt-test',
        provider: 'test',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: 'medium',
        sessionId: 'session',
      },
      conversationManager: {},
      sessionLineageTracker: {
        setOriginalTask: () => {},
      },
    },
    workspace: {
      projectPlanningService: service,
      projectPlanningProjectId: 'proj',
    },
    ops: {
      planManager: {
        getActive: () => null,
        getSummary: () => '',
        list: () => [],
        toMarkdown: () => '',
        dismiss: () => ({ outcome: 'no-active-plan' }),
        ...planManagerOverride,
      },
    },
    provider: {},
    platform: {},
    extensions: {},
    renderRequest: () => {},
    exit: () => {},
  } as unknown as CommandContext;
}

// Regression: after coordinator removal, text containing 'plan' must reach orchestrator.handleUserInput.
// This test drives plan-keyword text through the real input routing layer (handlePromptTextToken +
// handlePromptKeyToken) and asserts that submitInput on CommandContext is called with the original text.
describe('submitInput plan-keyword regression (coordinator removed)', () => {
  test('text containing "plan" flows through real input routing and reaches submitInput unchanged', () => {
    const submitCalls: string[] = [];

    const commandContext = {
      submitInput: (text: string) => { submitCalls.push(text); },
    } as unknown as CommandContext;

    // Build initial prompt state (empty, not in command mode)
    const textState = {
      prompt: '',
      cursorPos: 0,
      commandMode: false,
      killRing: new KillRing(),
      nextPasteId: 1,
      nextImageId: 1,
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      inputHistory: null,
      commandRegistry: new CommandRegistry(),
      commandContext,
      autocomplete: null,
      filePicker: { open: () => {} },
      modalOpened: () => {},
      saveUndoState: () => {},
      saveUndoStateForText: () => {},
      ensureInputCursorVisible: () => {},
      registerPaste: (content: string) => content,
      requestRender: () => {},
    };

    // Simulate user typing 'plan me a new feature' through the text route
    const afterText = handlePromptTextToken(textState, { type: 'text', value: 'plan me a new feature' });

    // Build key route state using the updated prompt from text routing
    const keyState = {
      prompt: afterText.prompt,
      cursorPos: afterText.cursorPos,
      killRing: new KillRing(),
      inputScrollTop: 0,
      commandMode: afterText.commandMode,
      contentWidth: 80,
      maxInputRows: 10,
      inputHistory: null,
      indicatorFocused: false,
      conversationManager: null,
      commandContext,
      autocomplete: null,
      blockActionsMenu: { open: () => {} },
      processModal: { open: () => {} },
      modalOpened: () => {},
      saveUndoState: () => {},
      saveUndoStateForText: () => {},
      ensureInputCursorVisible: () => {},
      getWrappedPromptInfo: () => ({
        wrappedLines: [afterText.prompt],
        segments: [],
        cursorWrappedLine: 0,
        cursorCol: afterText.cursorPos,
        visibleLines: [afterText.prompt],
        visibleCursorLine: 0,
        visibleCursorCol: afterText.cursorPos,
      }),
      moveCursorVertical: () => false,
      handlePathCompletion: () => false,
      handleBlockToggle: () => {},
      findMarkerAtPos: () => null,
      cleanupMarkerRegistry: () => {},
      expandPrompt: (text: string) => text,
      scroll: () => {},
      exitApp: () => {},
      requestRender: () => {},
    };

    // Simulate pressing Enter — drives through real key routing which calls submitInput
    handlePromptKeyToken(keyState, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false });

    // Plan-keyword text must reach submitInput unchanged — not swallowed, not intercepted
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toBe('plan me a new feature');
  });
});

describe('/plan project planning runtime command', () => {
  test('seeding a plan persists the first SDK next question as open state', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    const fake = makeService();

    await registry.execute('project-plan', ['replace', 'the', 'planning', 'panel'], makeContext(fake.service, out, opened));

    expect(opened).toContain('planning-modal');
    expect(out.join('\n')).toContain('Answer in the prompt, or open the Planning modal');
    expect(fake.state()?.metadata?.['active']).toBe(true);
    expect(fake.state()?.openQuestions.length).toBeGreaterThan(0);
  });

  // DEBT-3: `dismiss` and `answer` are REAL subcommands now — they must NOT be
  // refused as pseudo-verbs, and they must never seed a goal named after themselves.
  test('/plan dismiss with no active plan and no interview state → honest no-op, never seeded', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    const fake = makeService();

    await registry.execute('project-plan', ['dismiss'], makeContext(fake.service, out, opened));

    expect(fake.state()).toBeNull(); // never seeded — the goal is not overwritten with "dismiss"
    expect(out.join('\n')).toContain('No active plan or planning state to dismiss.');
    expect(out.join('\n')).not.toContain('Unknown /plan subcommand');
  });

  test('/plan dismiss deactivates an active project-planning interview state', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const fake = makeService(makeState({ goal: 'Ship it', metadata: { active: true, owner: 'tui' } }));

    await registry.execute('project-plan', ['dismiss'], makeContext(fake.service, out, []));

    expect(fake.state()?.metadata?.['active']).toBe(false);
    expect(fake.state()?.metadata?.['dismissedFrom']).toBe('plan-command');
    expect(out.join('\n')).toContain('Project planning interview marked inactive.');
  });

  test('/plan dismiss refuses a mid-execution plan and points at /workstream cancel', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const fake = makeService(makeState({ goal: 'Running', metadata: { active: true } }));
    const planManager = { dismiss: () => ({ outcome: 'requires-cancel', blockedBy: { title: 'Running plan' } }) };

    await registry.execute('project-plan', ['dismiss'], makeContext(fake.service, out, [], planManager));

    expect(out.join('\n')).toContain('mid-execution');
    expect(out.join('\n')).toContain('/workstream cancel');
    // The interview state is left untouched when execution is mid-flight.
    expect(fake.state()?.metadata?.['active']).toBe(true);
  });

  test('/plan answer <index> <text> records a real answer and clears its open-question gap', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    const answerCalls: unknown[] = [];
    const fake = makeService(makeState({ goal: 'Answer path', openQuestions: [{ id: 'q1', prompt: 'What scope?', status: 'open' }] }));
    // Wrap the service with an answerQuestion that records + reports honestly.
    const service = {
      ...(fake.service as unknown as Record<string, unknown>),
      answerQuestion: async (input: { questionIndex?: number; questionId?: string; answer: string }) => {
        answerCalls.push(input);
        return {
          ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', answered: true,
          question: { id: 'q1', prompt: 'What scope?', status: 'answered', answer: input.answer },
          openQuestions: [], state: fake.state(),
          evaluation: evaluateProjectPlanningReadiness(makeState({ goal: 'Answer path' })),
        };
      },
    } as unknown as ProjectPlanningService;

    await registry.execute('project-plan', ['answer', '1', 'focused', 'first', 'pass'], makeContext(service, out, opened));

    expect(answerCalls).toEqual([{ projectId: 'proj', questionIndex: 0, answer: 'focused first pass' }]);
    expect(out.join('\n')).toContain('Recorded answer to: What scope?');
    expect(opened).toContain('planning-modal');
  });

  test('/plan answer with a bad question ref reports honestly (no seed)', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const fake = makeService(makeState({ goal: 'Answer path', openQuestions: [{ id: 'q1', prompt: 'What scope?', status: 'open' }] }));
    const service = {
      ...(fake.service as unknown as Record<string, unknown>),
      answerQuestion: async () => ({
        ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', answered: false,
        reason: 'question-not-found',
        openQuestions: [{ id: 'q1', prompt: 'What scope?', status: 'open' }],
        state: fake.state(), evaluation: evaluateProjectPlanningReadiness(makeState({ goal: 'Answer path' })),
      }),
    } as unknown as ProjectPlanningService;

    await registry.execute('project-plan', ['answer', 'nope', 'my', 'answer'], makeContext(service, out, []));
    expect(out.join('\n')).toContain('No open question matched "nope"');
    expect(out.join('\n')).toContain('1. What scope? (q1)');
  });

  test('remaining pseudo-subcommand verbs (pause/stop/cancel) are still refused as lone tokens', async () => {
    for (const verb of ['pause', 'stop', 'cancel']) {
      const registry = new CommandRegistry();
      registerPlanningRuntimeCommands(registry);
      const out: string[] = [];
      const fake = makeService();
      await registry.execute('project-plan', [verb], makeContext(fake.service, out, []));
      expect(fake.state()).toBeNull();
      expect(out.join('\n')).toContain(`Unknown /plan subcommand "${verb}"`);
    }
  });

  test('a real multi-word goal that merely starts with a verb-looking word still seeds', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    const fake = makeService();

    await registry.execute('project-plan', ['cancel', 'the', 'legacy', 'billing', 'flow'], makeContext(fake.service, out, opened));

    expect(fake.state()?.metadata?.['active']).toBe(true); // multi-word → genuine goal → seeded
    expect(fake.state()?.goal).toBe('cancel the legacy billing flow');
    expect(opened).toContain('planning-modal');
  });
});
