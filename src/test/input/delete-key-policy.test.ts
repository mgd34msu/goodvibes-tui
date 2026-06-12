/**
 * Delete-key policy unit tests
 *
 * Covers:
 *   1. Policy predicate contracts (isTextBackspace, isTextForwardDelete)
 *   2. Panel search filter: 'delete' is a no-op (isPanelSearchBackspace)
 *   3. Selection modal: 'delete' is a no-op (handleSelectionModalToken)
 *   4. Planning panel draft: delete opens confirm gate; draft survives until confirmed
 *   5. Planning panel clear-draft: Delete requires y/n confirmation
 *   6. Router-path reachability: handlePanelFocusToken → panel.handleInput('delete') opens confirm
 */
import { describe, expect, test } from 'bun:test';
import { isTextBackspace, isTextForwardDelete } from '../../input/delete-key-policy.ts';
import { isPanelSearchBackspace } from '../../panels/search-focus.ts';
import { handleSelectionModalToken } from '../../input/handler-modal-routes.ts';
import { handlePanelFocusToken } from '../../input/handler-feed-routes.ts';
import { SelectionModal } from '../../input/selection-modal.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import {
  type ProjectPlanningService,
  type ProjectPlanningState,
} from '@pellux/goodvibes-sdk/platform/knowledge';
import { ProjectPlanningPanel } from '../../panels/project-planning-panel.ts';

// ---------------------------------------------------------------------------
// 1. Policy predicates
// ---------------------------------------------------------------------------

describe('delete-key policy predicates', () => {
  test('isTextBackspace: backspace returns true', () => {
    expect(isTextBackspace('backspace')).toBe(true);
  });

  test('isTextBackspace: delete returns false', () => {
    expect(isTextBackspace('delete')).toBe(false);
  });

  test('isTextBackspace: other keys return false', () => {
    expect(isTextBackspace('a')).toBe(false);
    expect(isTextBackspace('escape')).toBe(false);
    expect(isTextBackspace('')).toBe(false);
  });

  test('isTextForwardDelete: delete returns true', () => {
    expect(isTextForwardDelete('delete')).toBe(true);
  });

  test('isTextForwardDelete: backspace returns false', () => {
    expect(isTextForwardDelete('backspace')).toBe(false);
  });

  test('isTextForwardDelete: other keys return false', () => {
    expect(isTextForwardDelete('a')).toBe(false);
    expect(isTextForwardDelete('escape')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Panel search filter: isPanelSearchBackspace
// ---------------------------------------------------------------------------

describe('isPanelSearchBackspace', () => {
  test('backspace returns true', () => {
    expect(isPanelSearchBackspace('backspace')).toBe(true);
  });

  test('delete returns false (no-op — end-anchored filter, no cursor)', () => {
    expect(isPanelSearchBackspace('delete')).toBe(false);
  });

  test('other keys return false', () => {
    expect(isPanelSearchBackspace('a')).toBe(false);
    expect(isPanelSearchBackspace('escape')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Selection modal: 'delete' is a no-op in search filters
// ---------------------------------------------------------------------------

describe('selection modal delete-key policy', () => {
  function makeModalState(modal: SelectionModal): {
    selectionModal: SelectionModal;
    selectionCallback: null;
    modalStack: string[];
    requestRender: () => void;
    handleEscape: () => void;
  } {
    return {
      selectionModal: modal,
      selectionCallback: null,
      modalStack: [],
      requestRender: () => {},
      handleEscape: () => {},
    };
  }

  test('backspace removes last char from search filter', () => {
    const modal = new SelectionModal();
    modal.open('Pick', [{ id: 'a', label: 'A' }], { allowSearch: true });
    modal.focusSearch();
    modal.setQuery('abc');

    const state = makeModalState(modal);
    handleSelectionModalToken(state, { type: 'key', name: 'backspace', logicalName: 'backspace', ctrl: false, shift: false, meta: false });
    expect(modal.query).toBe('ab');
  });

  test('delete is a no-op: filter remains intact', () => {
    const modal = new SelectionModal();
    modal.open('Pick', [{ id: 'a', label: 'A' }], { allowSearch: true });
    modal.focusSearch();
    modal.setQuery('abc');

    const state = makeModalState(modal);
    handleSelectionModalToken(state, { type: 'key', name: 'delete', logicalName: 'delete', ctrl: false, shift: false, meta: false });
    expect(modal.query).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// 4 & 5. Planning panel: delete opens confirm gate; confirm required
// ---------------------------------------------------------------------------

function makePlanningState(draft?: string): ProjectPlanningState {
  const now = Date.now();
  return {
    id: 'current',
    projectId: 'proj',
    knowledgeSpaceId: 'project:proj',
    goal: 'Test goal.',
    scope: 'Test scope.',
    knownContext: [],
    openQuestions: [{
      id: 'q1',
      prompt: 'What is the test question?',
      status: 'open',
    }],
    answeredQuestions: [],
    decisions: [],
    assumptions: [],
    constraints: [],
    risks: [],
    tasks: [],
    dependencies: [],
    verificationGates: [],
    agentAssignments: [],
    readiness: 'not-ready',
    executionApproved: false,
    createdAt: now,
    updatedAt: now,
    metadata: { active: true, _initialDraft: draft ?? '' },
  };
}

function makePlanningService(state: ProjectPlanningState): ProjectPlanningService {
  return {
    async status() {
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', passiveOnly: true, counts: { states: 1, decisions: 0, languageArtifacts: 0 }, capabilities: [] };
    },
    async getState() {
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', state };
    },
    async evaluate() {
      return { readiness: 'not-ready', gaps: [], score: 0 };
    },
    async listDecisions() {
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', decisions: [] };
    },
    async getLanguage() {
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', language: null };
    },
    async upsertState(input) {
      state = { ...state, ...(input.state as Partial<ProjectPlanningState>) };
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', state };
    },
  } as unknown as ProjectPlanningService;
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function text(lines: ReturnType<ProjectPlanningPanel['render']>): string {
  return lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');
}

describe('planning panel delete-key policy', () => {
  test('delete key opens confirm gate: draft survives until confirmed', async () => {
    const panel = new ProjectPlanningPanel({ service: makePlanningService(makePlanningState()), projectId: 'proj' });
    panel.onActivate();
    await flushAsync();
    await flushAsync();

    // Type a draft.
    panel.handleInput('h');
    panel.handleInput('i');
    // Press delete — must open confirm gate, NOT wipe the draft immediately.
    expect(panel.handleInput('delete')).toBe(true);
    // Confirm prompt visible; draft still intact.
    const mid = text(panel.render(120, 30));
    expect(mid).toContain('draft answer');
    // Cancel — draft must survive.
    panel.handleInput('escape');
    const after = text(panel.render(120, 30));
    expect(after).toContain('hi');
  });

  test('backspace removes last char from draft', async () => {
    const panel = new ProjectPlanningPanel({ service: makePlanningService(makePlanningState()), projectId: 'proj' });
    panel.onActivate();
    await flushAsync();
    await flushAsync();

    panel.handleInput('h');
    panel.handleInput('i');
    panel.handleInput('backspace');
    const rendered = text(panel.render(120, 30));
    expect(rendered).toContain('Typed answer: h');
    expect(rendered).not.toContain('Typed answer: hi');
  });

  test('delete opens confirmation prompt; draft is preserved until confirmed', async () => {
    const panel = new ProjectPlanningPanel({ service: makePlanningService(makePlanningState()), projectId: 'proj' });
    panel.onActivate();
    await flushAsync();
    await flushAsync();

    panel.handleInput('h');
    panel.handleInput('i');
    // Trigger clear-draft confirmation via Delete.
    expect(panel.handleInput('delete')).toBe(true);
    // Confirmation prompt must be visible; draft must still exist (not cleared yet).
    const mid = text(panel.render(120, 30));
    expect(mid).toContain('draft answer');
    // Draft is still in memory; further regular input is absorbed.
    panel.handleInput('x'); // absorbed by confirm gate
    // Confirm with 'y' — draft is now cleared.
    expect(panel.handleInput('y')).toBe(true);
    const after = text(panel.render(120, 30));
    // After clear, draft line shows empty state.
    expect(after).not.toContain('Typed answer: hi');
  });

  test('delete confirmation cancelled with Esc: draft is preserved', async () => {
    const panel = new ProjectPlanningPanel({ service: makePlanningService(makePlanningState()), projectId: 'proj' });
    panel.onActivate();
    await flushAsync();
    await flushAsync();

    panel.handleInput('h');
    panel.handleInput('i');
    panel.handleInput('delete');
    // Cancel.
    expect(panel.handleInput('escape')).toBe(true);
    const after = text(panel.render(120, 30));
    // Draft must survive cancellation.
    expect(after).toContain('hi');
  });

  test('delete confirmation cancelled with n: draft is preserved', async () => {
    const panel = new ProjectPlanningPanel({ service: makePlanningService(makePlanningState()), projectId: 'proj' });
    panel.onActivate();
    await flushAsync();
    await flushAsync();

    panel.handleInput('h');
    panel.handleInput('i');
    panel.handleInput('delete');
    expect(panel.handleInput('n')).toBe(true);
    const after = text(panel.render(120, 30));
    expect(after).toContain('hi');
  });
});

// ---------------------------------------------------------------------------
// 6. Router-path reachability: handlePanelFocusToken → panel.handleInput('delete')
// ---------------------------------------------------------------------------

describe('router-path reachability: delete token reaches panel via handlePanelFocusToken', () => {
  test('delete key token routed through handlePanelFocusToken opens confirm gate in planning panel', async () => {
    const panel = new ProjectPlanningPanel({ service: makePlanningService(makePlanningState()), projectId: 'proj' });
    panel.onActivate();
    await flushAsync();
    await flushAsync();

    // Type a draft so the panel is in question-answering mode.
    panel.handleInput('h');
    panel.handleInput('i');

    // Wire the panel into a PanelManager via registered type.
    const pm = new PanelManager();
    pm.registerType({
      id: 'project-planning',
      name: 'Planning',
      icon: 'P',
      category: 'agent',
      description: 'Project planning panel',
      factory: () => panel,
    });
    pm.show();
    pm.open('project-planning');

    // Build a minimal KeybindingsManager with a dummy homeDirectory.
    const { KeybindingsManager } = await import('../../input/keybindings.ts');
    const kb = new KeybindingsManager({ homeDirectory: '/tmp' });

    // Build the route state.
    let renderCalled = false;
    const routeState = {
      panelManager: pm,
      keybindingsManager: kb,
      panelFocused: true,
      commandMode: false,
      searchActive: false,
      autocompleteActive: false,
      requestRender: () => { renderCalled = true; },
      handlePathCompletion: () => false,
      cyclePanelTab: () => {},
    };

    // Send a real 'delete' key token through the router.
    const token = {
      type: 'key' as const,
      name: 'delete',
      logicalName: 'delete',
      ctrl: false,
      shift: false,
      meta: false,
    };
    const result = handlePanelFocusToken(routeState, token);

    // Token must be consumed by the router.
    expect(result.handled).toBe(true);
    // Render must have been requested.
    expect(renderCalled).toBe(true);
    // The confirm gate must now be open (confirm prompt visible in render output).
    const rendered = text(panel.render(120, 30));
    expect(rendered).toContain('draft answer');
    // Draft must NOT have been cleared — only the gate opened.
    expect(rendered).toContain('hi');
  });
});
